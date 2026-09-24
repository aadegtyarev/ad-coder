import type { BackgroundRunManager, WakeKind } from "./background-runs";
import type { CreateWaitInput, WaitRecord, WaitService } from "./wait-service";
import type { WakePump } from "./wake";

export interface WaitHostOptions {
  maxWaitsPerScan?: number;
  cadenceMs: number;
  setInterval?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  onError?: (error: unknown, waitId: string) => void;
}

export interface WaitHostScanResult {
  checked: number;
  terminal: number;
  /** Waits reconciled but projecting no wake because their owner is not a run. */
  skipped: number;
  errors: number;
}

const DEFAULT_MAX_WAITS_PER_SCAN = 32;
/**
 * Terminal wait lifecycles map onto the EXISTING wake-delivery kinds; no new
 * kind is invented. `docs/contracts/waiting.md` guarantees that "completion,
 * failure, timeout, and cancellation create the normal durable wake", while
 * a cancellation has no wait-specific wake kind. It therefore projects onto
 * `operator_attention` -- the existing window for "a state the orchestrator
 * has to decide on" -- because an operator-chosen cancellation still owes the
 * owning run a decision (retry, replacement, or a reported outcome).
 * `unavailable` keeps the same mapping for the same reason. Documented in
 * docs/contracts/wake-delivery.md alongside this implementation.
 */
const TERMINAL_WAKE: Partial<Record<WaitRecord["lifecycle"], WakeKind>> = {
  satisfied: "completed",
  failed: "failed",
  unavailable: "operator_attention",
  timed_out: "timed_out",
  stalled: "paused",
  cancelled: "operator_attention",
};

/** Headless, bounded owner of wait reconciliation and wake projection. */
export class WaitHost {
  private readonly maxWaitsPerScan: number;
  private readonly hinted = new Set<string>();
  /** Keyset boundary for listIds: "" starts the sweep, otherwise the last id. */
  private cursor = "";
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;
  private again = false;

  constructor(
    private readonly service: WaitService,
    private readonly runs: BackgroundRunManager,
    private readonly wakePump: Pick<WakePump, "notifyChange">,
    private readonly options: WaitHostOptions,
  ) {
    this.maxWaitsPerScan = options.maxWaitsPerScan ?? DEFAULT_MAX_WAITS_PER_SCAN;
    if (!Number.isSafeInteger(options.cadenceMs) || options.cadenceMs <= 0)
      throw new TypeError("cadenceMs must be a positive integer");
    if (!Number.isSafeInteger(this.maxWaitsPerScan) || this.maxWaitsPerScan <= 0)
      throw new TypeError("maxWaitsPerScan must be a positive integer");
  }

  create(input: CreateWaitInput): WaitRecord {
    return this.service.create(input);
  }

  watch(waitId: string): void {
    this.service.reopen(waitId);
  }

  unwatch(waitId: string): void {
    this.hinted.delete(waitId);
  }

  hint(waitId: string): void {
    this.hinted.add(waitId);
    void this.scan();
  }

  start(): void {
    if (this.timer !== undefined) return;
    const set = this.options.setInterval ?? setInterval;
    this.timer = set(() => void this.scan(), this.options.cadenceMs);
    void this.scan();
  }

  stop(): void {
    if (this.timer === undefined) return;
    (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = undefined;
  }

  async scan(): Promise<WaitHostScanResult> {
    if (this.scanning) {
      this.again = true;
      return { checked: 0, terminal: 0, skipped: 0, errors: 0 };
    }
    this.scanning = true;
    try {
      const page = this.service.listIds(this.cursor, this.maxWaitsPerScan);
      const candidates = [...this.hinted, ...page.ids.filter((id) => !this.hinted.has(id))].slice(
        0,
        this.maxWaitsPerScan,
      );
      for (const id of candidates) this.hinted.delete(id);
      // A durable enumeration gap means the resume boundary is unanchored:
      // re-enumerate from the start on the next sweep instead of silently
      // trusting progress that a creation or removal under the boundary could
      // have unevidenced.
      this.cursor = page.gap ? "" : page.nextCursor;
      let checked = 0;
      let terminal = 0;
      let skipped = 0;
      let errors = 0;
      for (const waitId of candidates) {
        checked += 1;
        try {
          await this.service.reconcile(waitId);
          const record = this.service.get(waitId);
          // Session and operator owners have no durable run wake window. Skip
          // them cleanly each cycle (the wait lifecycle still reconciles)
          // rather than re-raising the same failure every scan.
          if (record.owner.kind !== "run") {
            skipped += 1;
            continue;
          }
          const kind = TERMINAL_WAKE[record.lifecycle];
          if (kind === undefined) continue;
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(record.owner.id))
            throw new TypeError("wait owner must be a valid run identity");
          const terminalAt =
            record.events.filter((event) => event.lifecycle === record.lifecycle).at(-1)
              ?.timestamp ?? record.updatedAt;
          if (!Number.isSafeInteger(terminalAt) || terminalAt < 0)
            throw new TypeError("wait terminal timestamp is invalid");
          const result = this.runs.recordWakeWindow(record.owner.id, kind, terminalAt);
          if (result.recorded) {
            terminal += 1;
            this.wakePump.notifyChange();
          }
        } catch (error) {
          errors += 1;
          this.options.onError?.(error, waitId);
        }
      }
      return { checked, terminal, skipped, errors };
    } finally {
      this.scanning = false;
      if (this.again) {
        this.again = false;
        void this.scan();
      }
    }
  }
}
