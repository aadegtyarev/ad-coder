import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearsOnExplicitAct } from "../project-operations/run-coordinator";
import { ProjectStore } from "../project-store/project-store";
import { ProjectStoreError } from "../project-store/types";
import type { RunPipelineResult, StepCost } from "./orchestrator";
import type { PipelinePause, PipelinePauseCause } from "./types";
import {
  MAX_PAUSE_CAUSE_CODE_CHARS,
  MAX_PAUSE_CAUSE_MESSAGE_CHARS,
  PipelinePauseError,
} from "./types";

export type BackgroundLifecycle =
  | "requested"
  | "started"
  | "stage_changed"
  | "paused"
  | "operator_attention"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "completed";
export type BackgroundTerminalLifecycle = "failed" | "cancelled" | "timed_out" | "completed";

/**
 * Lifecycles that must start an orchestrator turn (issue #387): a state the
 * orchestrator has to decide on. `stage_changed` is a step finishing (the
 * operator's "one of its steps"), so it wakes and is coalesced. Not waking:
 * `requested`/`started` (in-flight), `cancelled` (operator-chosen stop); the
 * tool-activity channel never reaches this manager at all.
 */
export const WAKE_INITIATING_LIFECYCLES = [
  "paused",
  "operator_attention",
  "failed",
  "timed_out",
  "completed",
  "stage_changed",
] as const;
export type WakeKind = (typeof WAKE_INITIATING_LIFECYCLES)[number];

/** One coalesced window of a single wake kind on a single run. */
export interface WakeEntry {
  kind: WakeKind;
  firstAt: number;
  lastAt: number;
  count: number;
  handled: boolean;
  handledAt?: number;
}
/** An unhandled wake projected off durable state for the pump to drain. */
export interface PendingWake extends WakeEntry {
  runId: string;
  pause?: BackgroundRunPause;
  metrics?: { steps: number; totalCost: number };
}

export interface BackgroundRunEvent {
  sequence: number;
  runId: string;
  lifecycle: BackgroundLifecycle;
  timestamp: number;
  stage?: StepCost["phase"];
  pause?: BackgroundRunPause;
  errorCode?: "internal_failure" | "operator_attention" | "deadline_exceeded";
  metrics?: { steps: number; totalCost: number };
}
export interface BackgroundEventPage {
  events: BackgroundRunEvent[];
  nextCursor: number;
  gap: boolean;
}
/** A bounded push hint. Callers retain explicit cursor polling for reconnect and backlog reads. */
export interface BackgroundRunNotice extends BackgroundEventPage {
  type: "background_events";
  runId: string;
  /** Events omitted by retention before this subscriber could observe them. */
  droppedEvents: number;
  /** More persisted events exist beyond this bounded notice. */
  pending: boolean;
}
export type BackgroundRunNoticeConsumer = (notice: BackgroundRunNotice) => void | Promise<void>;

/**
 * What an operator can actually do with a paused background run today.
 *
 * `background` has start/events/status/result/cancel and no resume; `control
 * resume` reads `control-<id>.json` while a background run is stored as
 * `coordinator-<id>.json`. So the only working route is the orchestrator's
 * `resume_pipeline` tool, reached through a console (issue #310). Stated here
 * once, in the record, rather than left for each reader to discover by trying
 * the two commands that do not work.
 */
export const RESUME_PIPELINE_DETAIL =
  "open `ad-coder console --target-dir <dir>` and ask the orchestrator to resume this run id with resume_pipeline, raising the exhausted ceiling; `background` has no resume action and `control resume` does not read background runs";

/**
 * Same route, minus the ceiling framing: a run paused on a NON-ceiling
 * resumable pause resumes with its original task the way it paused, and a
 * raised ceiling is neither needed nor there to find. Sending an operator
 * hunting for raise parameters for a pause that needs only "resume it" reads
 * as guidance, wastes their first move. The ceiling wording stays verbatim for
 * `stage_limit`/`stage_failed` and the pause-less paths (timed_out, abandoned).
 */
export const RESUME_PIPELINE_NO_RAISE_DETAIL =
  "open `ad-coder console --target-dir <dir>` and ask the orchestrator to resume this run id with resume_pipeline; a resumable stage pause resumes with its original task and needs no ceiling raise; `background` has no resume action and `control resume` does not read background runs";

/** The recovery wording a paused/attention status actually owes the operator. */
function resumeRecoveryDetail(pause: BackgroundRunPause | undefined): string {
  return pause !== undefined &&
    clearsOnExplicitAct(pause.code) &&
    pause.code !== "stage_limit" &&
    pause.code !== "stage_failed"
    ? RESUME_PIPELINE_NO_RAISE_DETAIL
    : RESUME_PIPELINE_DETAIL;
}
export interface BackgroundRunStatus {
  runId: string;
  lifecycle: BackgroundLifecycle;
  metrics: { steps: number; totalCost: number };
  pause?: BackgroundRunPause;
  /**
   * What the reader should do next.
   *
   * `resume_pipeline` names the orchestrator's conversational tool, which is the
   * ONLY thing that can currently resume a paused background run -- `background`
   * has no resume action and `control resume` looks for a differently-named
   * record (issue #310). Whoever renders this must say so rather than printing a
   * bare verb the operator cannot type: an instruction that does not work is
   * worse than none, because it is followed first and doubted later.
   */
  recovery?: "wait" | "inspect_events" | "resume_pipeline" | "none";
  /** One line naming what to actually do, when the recovery needs explaining. */
  recoveryDetail?: string;
}
/**
 * The pause payload a background event carries (issue #261): the coordinator's
 * own record verbatim -- fixed phrases built in code, never model content --
 * so a consumer reports the limit and the recovery action without reading the
 * run coordinator's record by hand.
 */
/** Same record verbatim; the alias documents the projection seam. */
export type BackgroundRunPause = PipelinePause;

/** The terminal outcome a completed/failed/cancelled/timed-out run reports. */
export interface BackgroundTerminalOutcome extends BackgroundRunStatus {
  lifecycle: BackgroundTerminalLifecycle;
  approved?: boolean;
  rounds?: number;
  verdict?: string;
}
/** A paused run reports through the same surface, with the same shape. */
export interface BackgroundPausedOutcome extends BackgroundRunStatus {
  lifecycle: "paused";
  pause: BackgroundRunPause;
}
export type BackgroundRunOutcome = BackgroundTerminalOutcome | BackgroundPausedOutcome;
export type BackgroundRunErrorCode =
  | "not_found"
  | "resource_limit"
  | "closed"
  | "invalid_request"
  | "not_terminal"
  | "launch_failed"
  | "state_unavailable";
export class BackgroundRunError extends Error {
  override readonly name = "BackgroundRunError";
  readonly detail = "background_run";
  constructor(
    readonly code: BackgroundRunErrorCode,
    readonly runId?: string,
  ) {
    super(code);
  }
}
export type SameTargetPolicy = "allow" | "reject" | "serialize";
export interface BackgroundRunLimits {
  maxActiveRuns: number;
  maxProcessActiveRuns: number;
  maxTaskBytes: number;
  maxEventsPerRun: number;
  maxPageSize: number;
  maxPageBytes: number;
  /** Maximum undelivered notice pages retained for each subscriber. */
  subscriberQueueCapacity: number;
  maxRunMs: number;
  closeDrainMs: number;
  /** Lease heartbeat window used to distinguish a live detached worker from abandonment. */
  leaseMs: number;
  sameTargetPolicy: SameTargetPolicy;
  /** Maximum coalesced wake windows retained per run. */
  maxWakeEntriesPerRun: number;
  /** Maximum unhandled wake windows a single orchestrator turn drains. */
  maxWakesPerTurn: number;
  /** Optional closed subset of wake kinds; validated as a subset of the initiating set. */
  wakeKinds?: readonly WakeKind[];
}
/** Hard cap independent of callers: each subscriber retains up to this many pages. */
export const MAX_BACKGROUND_SUBSCRIBER_QUEUE_CAPACITY = 1_024;
export const DEFAULT_BACKGROUND_RUN_LIMITS: Readonly<BackgroundRunLimits> = Object.freeze({
  maxActiveRuns: 0,
  maxProcessActiveRuns: 0,
  maxTaskBytes: 0,
  maxEventsPerRun: 0,
  maxPageSize: 32,
  maxPageBytes: 16 * 1024,
  subscriberQueueCapacity: 16,
  maxRunMs: 0,
  closeDrainMs: 0,
  leaseMs: 15_000,
  sameTargetPolicy: "reject",
  maxWakeEntriesPerRun: 12,
  maxWakesPerTurn: 8,
});
interface PersistedEntry {
  version: 1;
  ownerId: string;
  runId: string;
  lifecycle: BackgroundLifecycle;
  events: BackgroundRunEvent[];
  nextSequence: number;
  metrics: { steps: number; totalCost: number };
  pause?: BackgroundRunPause | undefined;
  lease?: { workerId: string; heartbeatAt: number } | undefined;
  outcome?: BackgroundRunOutcome | undefined;
  wake?: { entries: WakeEntry[] } | undefined;
}
export interface BackgroundDetachedLaunch {
  runId: string;
  task: string;
  limits: Readonly<BackgroundRunLimits>;
}
export type BackgroundHostLauncher = (launch: BackgroundDetachedLaunch) => void | Promise<void>;

interface Entry extends PersistedEntry {
  active: boolean;
  cancelled: boolean;
  promise: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  pause?: BackgroundRunPause | undefined;
  lease?: { workerId: string; heartbeatAt: number } | undefined;
  leaseTimer?: ReturnType<typeof setInterval>;
  wake: { entries: WakeEntry[] };
}
interface BackgroundSubscriber {
  consumer: BackgroundRunNoticeConsumer;
  cursors: Map<string, number>;
  queue: BackgroundRunNotice[];
  active: boolean;
  draining: boolean;
}

const MAX_BACKGROUND_EVENT_PAGE_EVENT: BackgroundRunEvent = {
  sequence: Number.MAX_SAFE_INTEGER,
  runId: "x".repeat(256),
  lifecycle: "stage_changed",
  timestamp: Number.MAX_SAFE_INTEGER,
  stage: "security",
  errorCode: "deadline_exceeded",
  metrics: { steps: Number.MAX_SAFE_INTEGER, totalCost: Number.MAX_VALUE },
  pause: {
    phase: "security",
    code: "provider_rejected",
    action: "a".repeat(256),
    limitReason: "cost_unknown",
    limit: Number.MAX_VALUE,
    cause: {
      code: "x".repeat(MAX_PAUSE_CAUSE_CODE_CHARS),
      message: "a".repeat(MAX_PAUSE_CAUSE_MESSAGE_CHARS),
      recurrence: Number.MAX_SAFE_INTEGER,
    },
  },
};
/** Enough room for every schema-valid event, so cursor polling always advances. */
export const MIN_BACKGROUND_EVENT_PAGE_BYTES =
  Buffer.byteLength(JSON.stringify(MAX_BACKGROUND_EVENT_PAGE_EVENT)) + 3;

let processActive = 0;
const targetTails = new Map<string, Promise<void>>();

/** Create each private state ancestor only after rejecting links and foreign permissions. */
function privateStateDirectory(targetDir: string): string {
  const uid = process.getuid?.();
  let current = fs.realpathSync(targetDir);
  for (const segment of [".ad-coder", "runs", "background"]) {
    current = path.join(current, segment);
    try {
      fs.lstatSync(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      fs.mkdirSync(current, { recursive: false, mode: 0o700 });
    }
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (uid !== undefined && stat.uid !== uid)
    )
      throw new BackgroundRunError("state_unavailable");
    fs.chmodSync(current, 0o700);
  }
  return current;
}

/** The executor a background run invokes to drive its detached pipeline. */
export type BackgroundRunExecutor = (
  task: string,
  runId: string,
  control: { cancelled: () => boolean; onStage: (step: StepCost) => void },
) => Promise<RunPipelineResult>;

/** Session-owned durable, content-free projection over isolated pipeline workers. */
export class BackgroundRunManager {
  private readonly entries = new Map<string, Entry>();
  private readonly limits: BackgroundRunLimits;
  private readonly ownerId: string;
  private readonly stateDir?: string;
  private readonly store?: ProjectStore;
  private readonly subscribers = new Set<BackgroundSubscriber>();
  private watcher: fs.FSWatcher | undefined;
  private closed = false;
  constructor(
    private readonly execute: BackgroundRunExecutor,
    limits: Partial<BackgroundRunLimits> = {},
    targetDir?: string,
    ownerId: string = crypto.randomUUID(),
    private readonly launchDetachedHost?: BackgroundHostLauncher,
  ) {
    this.limits = { ...DEFAULT_BACKGROUND_RUN_LIMITS, ...limits };
    const numericLimits = [
      this.limits.maxActiveRuns,
      this.limits.maxProcessActiveRuns,
      this.limits.maxTaskBytes,
      this.limits.maxEventsPerRun,
      this.limits.maxPageSize,
      this.limits.maxPageBytes,
      this.limits.subscriberQueueCapacity,
      this.limits.maxRunMs,
      this.limits.closeDrainMs,
      this.limits.leaseMs,
      this.limits.maxWakeEntriesPerRun,
      this.limits.maxWakesPerTurn,
    ];
    if (numericLimits.some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new BackgroundRunError("invalid_request");
    if (
      this.limits.maxPageSize <= 0 ||
      this.limits.maxPageBytes < MIN_BACKGROUND_EVENT_PAGE_BYTES ||
      this.limits.subscriberQueueCapacity <= 0 ||
      this.limits.subscriberQueueCapacity > MAX_BACKGROUND_SUBSCRIBER_QUEUE_CAPACITY ||
      this.limits.leaseMs <= 0 ||
      this.limits.maxWakeEntriesPerRun <= 0 ||
      this.limits.maxWakesPerTurn <= 0
    )
      throw new BackgroundRunError("invalid_request");
    if (!(["allow", "reject", "serialize"] as const).includes(this.limits.sameTargetPolicy))
      throw new BackgroundRunError("invalid_request");
    if (
      this.limits.wakeKinds?.some(
        (kind) => !(WAKE_INITIATING_LIFECYCLES as readonly string[]).includes(kind),
      )
    )
      throw new BackgroundRunError("invalid_request");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId)) throw new BackgroundRunError("invalid_request");
    this.ownerId = ownerId;
    if (targetDir !== undefined) {
      this.store = new ProjectStore(targetDir);
      this.stateDir = privateStateDirectory(targetDir);
      this.load();
    }
  }
  /** The resolved limits this manager runs under (read-only snapshot). */
  get backgroundLimits(): Readonly<BackgroundRunLimits> {
    return this.limits;
  }
  start(task: string): { runId: string; lifecycle: "requested" } {
    return this.create(task, false);
  }
  /** Admit and launch a durable request through the host supplied by the embedding application. */
  async startDetached(task: string): Promise<{ runId: string; lifecycle: "requested" }> {
    const requested = this.create(task, true);
    const entry = this.entries.get(requested.runId);
    if (entry === undefined) throw new BackgroundRunError("not_found");
    try {
      if (this.launchDetachedHost === undefined)
        throw new Error("detached host launcher is not configured");
      await this.launchDetachedHost({ runId: requested.runId, task, limits: { ...this.limits } });
      return requested;
    } catch {
      this.failLaunch(entry);
      throw new BackgroundRunError("launch_failed", requested.runId);
    }
  }
  /** Claim a requested record in the detached worker process. */
  claim(runId: string, task: string): void {
    const entry = this.owned(runId);
    if (entry.lifecycle !== "requested" || entry.lease !== undefined)
      throw new BackgroundRunError("invalid_request");
    const workerId = crypto.randomUUID();
    if (this.store !== undefined) {
      const file = path.join(this.stateDir as string, `${runId}.json`);
      try {
        this.store.mutateVersionedJson<PersistedEntry>(file, (current) => {
          const value = current?.value;
          if (value === undefined || value.lifecycle !== "requested" || value.lease !== undefined)
            throw new BackgroundRunError("invalid_request", runId);
          return { ...value, lease: { workerId, heartbeatAt: Date.now() } };
        });
      } catch (error) {
        if (error instanceof BackgroundRunError) throw error;
        if (error instanceof ProjectStoreError && error.code === "version_conflict")
          throw new BackgroundRunError("invalid_request", runId);
        throw error;
      }
    }
    entry.active = true;
    entry.lease = { workerId, heartbeatAt: Date.now() };
    this.launch(entry, task);
  }
  private create(task: string, detached: boolean): { runId: string; lifecycle: "requested" } {
    if (this.closed) throw new BackgroundRunError("closed");
    if (
      typeof task !== "string" ||
      task.trim() === "" ||
      (this.limits.maxTaskBytes > 0 && Buffer.byteLength(task) > this.limits.maxTaskBytes)
    )
      throw new BackgroundRunError("resource_limit");
    const active = [...this.entries.values()].filter((entry) => entry.active).length;
    if (
      (this.limits.maxActiveRuns > 0 && active >= this.limits.maxActiveRuns) ||
      (this.limits.maxProcessActiveRuns > 0 && processActive >= this.limits.maxProcessActiveRuns) ||
      (this.stateDir !== undefined &&
        this.limits.sameTargetPolicy === "reject" &&
        targetTails.has(this.stateDir))
    )
      throw new BackgroundRunError("resource_limit");
    const runId = crypto.randomUUID();
    const entry: Entry = {
      version: 1,
      ownerId: this.ownerId,
      runId,
      lifecycle: "requested",
      events: [],
      nextSequence: 1,
      metrics: { steps: 0, totalCost: 0 },
      active: !detached,
      cancelled: false,
      promise: Promise.resolve(),
      wake: { entries: [] },
    };
    this.entries.set(runId, entry);
    this.append(entry, "requested");
    const preceding =
      this.stateDir !== undefined && this.limits.sameTargetPolicy === "serialize"
        ? targetTails.get(this.stateDir)
        : undefined;
    if (detached) {
      entry.active = false;
      entry.promise = Promise.resolve();
      return { runId, lifecycle: "requested" };
    }
    this.launch(entry, task, preceding);
    return { runId, lifecycle: "requested" };
  }
  private failLaunch(entry: Entry): void {
    entry.lifecycle = "failed";
    entry.outcome = { ...this.statusOf(entry), lifecycle: "failed", recovery: "inspect_events" };
    this.append(entry, "failed", {
      errorCode: "internal_failure",
      metrics: { ...entry.metrics },
    });
    this.persist(entry);
  }
  private launch(entry: Entry, task: string, preceding?: Promise<void>): void {
    processActive += 1;
    entry.pause = undefined;
    entry.lease ??= { workerId: crypto.randomUUID(), heartbeatAt: Date.now() };
    this.persist(entry);
    const execute = Promise.resolve(preceding).then(async () => {
      if (entry.cancelled) return;
      entry.lifecycle = "started";
      this.append(entry, "started");
      if (this.limits.maxRunMs > 0)
        entry.timer = setTimeout(() => this.timeout(entry), this.limits.maxRunMs);
      const result = await this.execute(task, entry.runId, {
        cancelled: () => entry.cancelled,
        onStage: (step) => {
          if (entry.cancelled) return;
          entry.metrics = {
            steps: entry.metrics.steps + 1,
            totalCost: entry.metrics.totalCost + step.cost,
          };
          this.append(entry, "stage_changed", { stage: step.phase, metrics: { ...entry.metrics } });
        },
      });
      if (entry.cancelled) return;
      entry.metrics = { steps: result.perStep.length, totalCost: result.totalCost };
      entry.lifecycle = "completed";
      const lastVerdict = result.result.verdicts.at(-1);
      entry.outcome = {
        ...this.statusOf(entry),
        lifecycle: "completed",
        approved: result.result.approved,
        rounds: result.result.rounds,
        ...(lastVerdict === undefined ? { verdict: "not_run" } : { verdict: lastVerdict.status }),
      };
      this.append(entry, "completed", { metrics: { ...entry.metrics } });
    });
    entry.promise = execute
      .catch((error: unknown) => {
        if (entry.cancelled) return;
        // A pause is not a failure (issue #261): the coordinator recorded a
        // resumable state with the recovery action in words, so the report
        // carries the same identification -- name, limit, action -- and the
        // metrics include what the run had already spent.
        if (error instanceof PipelinePauseError) {
          entry.lifecycle = "paused";
          entry.metrics = { ...error.metrics };
          entry.pause = copyPause(error.pause);
          this.append(entry, "paused", {
            ...((PHASES as readonly string[]).includes(error.pause.phase)
              ? { stage: error.pause.phase as StepCost["phase"] }
              : {}),
            pause: copyPause(error.pause),
            metrics: { ...entry.metrics },
          });
          return;
        }
        const attention = isOperatorAttention(error);
        entry.lifecycle = attention ? "operator_attention" : "failed";
        this.append(entry, entry.lifecycle, {
          errorCode: attention ? "operator_attention" : "internal_failure",
          metrics: { ...entry.metrics },
        });
        if (attention) return;
        entry.outcome = {
          ...this.statusOf(entry),
          lifecycle: "failed",
          recovery: "inspect_events",
        };
        this.persist(entry);
      })
      .finally(() => {
        entry.active = false;
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        if (entry.leaseTimer !== undefined) clearInterval(entry.leaseTimer);
        entry.lease = undefined;
        this.persist(entry);
        processActive -= 1;
        if (this.stateDir !== undefined && targetTails.get(this.stateDir) === entry.promise)
          targetTails.delete(this.stateDir);
      });
    if (this.stateDir !== undefined && this.limits.sameTargetPolicy !== "allow")
      targetTails.set(this.stateDir, entry.promise);
    entry.leaseTimer = setInterval(
      () => {
        if (entry.active && entry.lease !== undefined) {
          entry.lease.heartbeatAt = Date.now();
          this.persist(entry);
        }
      },
      Math.max(100, Math.floor(this.limits.leaseMs / 3)),
    );
    void entry.promise;
  }
  async wait(runId: string): Promise<void> {
    await this.owned(runId).promise;
  }

  /**
   * Project a FOREGROUND resume's re-pause onto this run's registry entry
   * (issue #363).
   *
   * A foreground resume never runs through `launch`, so its new pause is
   * recorded only in the coordinator checkpoint; without this projection the
   * entry kept the EARLIER pause and the registry contradicted the checkpoint
   * an operator compares it against. Ownership rules apply unchanged: a runId
   * this manager does not hold (never started here, or a record owned by
   * another owner) is skipped silently, and an entry with a live worker is
   * left alone -- the worker's own catch records its pause. A stale terminal
   * outcome is dropped: a re-paused run is not the terminal thing it was.
   */
  projectForegroundPause(
    runId: string,
    pause: PipelinePause,
    metrics: { steps: number; totalCost: number },
  ): void {
    if (this.entries.get(runId) === undefined) return;
    const entry = this.owned(runId);
    if (entry.active) return;
    entry.lifecycle = "paused";
    entry.metrics = { ...metrics };
    entry.pause = copyPause(pause);
    entry.outcome = undefined;
    this.append(entry, "paused", {
      ...((PHASES as readonly string[]).includes(pause.phase)
        ? { stage: pause.phase as StepCost["phase"] }
        : {}),
      pause: copyPause(pause),
      metrics: { ...entry.metrics },
    });
  }
  /**
   * Subscribe to future owner-scoped, content-free lifecycle pages.
   *
   * Each callback receives pages through an asynchronous bounded per-subscriber queue.
   * Notifications are hints only: reconnect and backlog consumption continue to use events(runId, cursor).
   */
  subscribe(consumer: BackgroundRunNoticeConsumer): () => void {
    if (this.closed) throw new BackgroundRunError("closed");
    if (typeof consumer !== "function") throw new BackgroundRunError("invalid_request");
    const subscriber: BackgroundSubscriber = {
      consumer,
      cursors: new Map(),
      queue: [],
      active: true,
      draining: false,
    };
    for (const entry of this.entries.values())
      subscriber.cursors.set(entry.runId, entry.nextSequence - 1);
    this.subscribers.add(subscriber);
    try {
      this.ensureWatcher();
    } catch (error) {
      this.subscribers.delete(subscriber);
      throw error;
    }
    return () => this.removeSubscriber(subscriber);
  }
  /** Owner-scoped, bounded lifecycle summary. Foreign records are never loaded. */
  list(limit = this.limits.maxPageSize): BackgroundRunStatus[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new BackgroundRunError("invalid_request");
    return [...this.entries.values()]
      .slice(0, Math.min(limit || this.limits.maxPageSize, this.limits.maxPageSize))
      .map((entry) => this.statusOf(entry));
  }
  status(runId: string): BackgroundRunStatus {
    return this.statusOf(this.owned(runId));
  }
  events(runId: string, cursor: number, limit = this.limits.maxPageSize): BackgroundEventPage {
    const entry = this.owned(runId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 0)
      throw new BackgroundRunError("invalid_request");
    return this.eventsOf(entry, cursor, limit || this.limits.maxPageSize);
  }
  result(runId: string): BackgroundRunOutcome {
    const entry = this.owned(runId);
    if (entry.outcome !== undefined) return copyOutcome(entry.outcome);
    // A pause is reportable on the same surface a completed run is (issue
    // #261): it is durable and resumable, so `not_terminal` would silently
    // hide it from exactly the consumer that must react to the limit.
    if (entry.lifecycle === "paused" && entry.pause !== undefined)
      return { ...this.statusOf(entry), lifecycle: "paused", pause: copyPause(entry.pause) };
    throw new BackgroundRunError("not_terminal");
  }
  cancel(runId: string): BackgroundRunStatus {
    const entry = this.owned(runId);
    if (!isTerminal(entry.lifecycle)) {
      entry.cancelled = true;
      entry.lifecycle = "cancelled";
      entry.outcome = { ...this.statusOf(entry), lifecycle: "cancelled", recovery: "none" };
      this.append(entry, "cancelled", { metrics: { ...entry.metrics } });
    }
    return this.statusOf(entry);
  }
  /** Unhandled wake windows, refreshing non-active entries off durable state. */
  pendingWakes(): PendingWake[] {
    for (const runId of this.entries.keys()) {
      const entry = this.entries.get(runId);
      if (entry !== undefined && !entry.active) this.refresh(runId);
    }
    const pending: PendingWake[] = [];
    for (const entry of this.entries.values()) {
      const runsOwnerWakes = this.limits.wakeKinds === undefined ? null : this.limits.wakeKinds;
      for (const w of entry.wake.entries) {
        if (w.handled) continue;
        if (runsOwnerWakes !== null && !runsOwnerWakes.includes(w.kind)) continue;
        pending.push({
          runId: entry.runId,
          kind: w.kind,
          firstAt: w.firstAt,
          lastAt: w.lastAt,
          count: w.count,
          handled: false,
          ...(entry.pause === undefined ? {} : { pause: { ...entry.pause } }),
          metrics: { ...entry.metrics },
        });
      }
    }
    return pending;
  }
  /** Mark the named wake kinds handled for a run, on durable state and in memory. */
  markWakesHandled(runId: string, kinds: readonly WakeKind[]): void {
    if (this.closed) throw new BackgroundRunError("closed");
    const entry = this.entries.get(runId);
    const now = Date.now();
    if (entry !== undefined) {
      for (const w of entry.wake.entries)
        if (kinds.includes(w.kind) && !w.handled) {
          w.handled = true;
          w.handledAt = now;
        }
    }
    if (this.stateDir === undefined) {
      if (entry === undefined) throw new BackgroundRunError("not_found", runId);
      return;
    }
    const file = path.join(this.stateDir, `${runId}.json`);
    this.store?.mutateVersionedJson<PersistedEntry>(file, (current) => {
      const value = current?.value;
      if (value === undefined) throw new BackgroundRunError("not_found", runId);
      const entries = (value.wake?.entries ?? []).map((w) =>
        kinds.includes(w.kind) && !w.handled ? { ...w, handled: true, handledAt: now } : w,
      );
      return { ...value, wake: { entries } };
    });
  }
  async close(preserveWorkers = false): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopWatcher();
    for (const subscriber of this.subscribers) this.deactivateSubscriber(subscriber);
    this.subscribers.clear();
    for (const entry of this.entries.values())
      if (!preserveWorkers && entry.active && !isTerminal(entry.lifecycle))
        this.cancel(entry.runId);
    if (this.limits.closeDrainMs === 0) return;
    const pending = Promise.allSettled([...this.entries.values()].map((entry) => entry.promise));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.limits.closeDrainMs);
      void pending.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  private timeout(e: Entry): void {
    if (isTerminal(e.lifecycle)) return;
    e.cancelled = true;
    e.lifecycle = "timed_out";
    e.outcome = {
      ...this.statusOf(e),
      lifecycle: "timed_out",
      recovery: "resume_pipeline",
      recoveryDetail: RESUME_PIPELINE_DETAIL,
    };
    this.append(e, "timed_out", { errorCode: "deadline_exceeded", metrics: { ...e.metrics } });
  }
  private statusOf(e: Entry): BackgroundRunStatus {
    return {
      runId: e.runId,
      lifecycle: e.lifecycle,
      metrics: { ...e.metrics },
      ...(e.pause === undefined ? {} : { pause: copyPause(e.pause) }),
      recovery: isTerminal(e.lifecycle)
        ? "none"
        : e.lifecycle === "operator_attention" || e.lifecycle === "paused"
          ? "resume_pipeline"
          : "wait",
      ...(!isTerminal(e.lifecycle) &&
      (e.lifecycle === "operator_attention" || e.lifecycle === "paused")
        ? { recoveryDetail: resumeRecoveryDetail(e.pause) }
        : {}),
    };
  }
  private owned(runId: string): Entry {
    const current = this.entries.get(runId);
    if (current !== undefined && !current.active) this.refresh(runId);
    const entry = this.entries.get(runId);
    if (entry === undefined) throw new BackgroundRunError("not_found");
    return entry;
  }
  private append(
    e: Entry,
    lifecycle: BackgroundLifecycle,
    fields: Partial<BackgroundRunEvent> = {},
  ): void {
    e.events.push({
      sequence: e.nextSequence++,
      runId: e.runId,
      lifecycle,
      timestamp: Date.now(),
      ...fields,
    });
    if (this.limits.maxEventsPerRun > 0 && e.events.length > this.limits.maxEventsPerRun)
      e.events.splice(0, e.events.length - this.limits.maxEventsPerRun);
    this.coalesceWake(e, lifecycle);
    this.persist(e);
    this.notify(e);
  }

  /** Record (or extend) a wake window for a turn-initiating lifecycle. */
  private coalesceWake(e: Entry, lifecycle: BackgroundLifecycle): void {
    if (!(WAKE_INITIATING_LIFECYCLES as readonly string[]).includes(lifecycle)) return;
    if (
      this.limits.wakeKinds !== undefined &&
      !this.limits.wakeKinds.includes(lifecycle as WakeKind)
    )
      return;
    const now = Date.now();
    const kind = lifecycle as WakeKind;
    const existing = [...e.wake.entries].reverse().find((w) => w.kind === kind && !w.handled);
    if (existing !== undefined) {
      existing.lastAt = now;
      existing.count += 1;
      return;
    }
    e.wake.entries.push({ kind, firstAt: now, lastAt: now, count: 1, handled: false });
    // Evict only the oldest HANDLED windows at the cap; unhandled windows are
    // the turn-initiating signal and must never be dropped by retention.
    if (e.wake.entries.length > this.limits.maxWakeEntriesPerRun) {
      const handled = e.wake.entries.filter((w) => w.handled);
      const over = e.wake.entries.length - this.limits.maxWakeEntriesPerRun;
      if (handled.length >= over) {
        for (let i = 0; i < over; i++) {
          const evict = handled[i];
          if (evict !== undefined) {
            const idx = e.wake.entries.indexOf(evict);
            if (idx !== -1) e.wake.entries.splice(idx, 1);
          }
        }
      }
    }
  }
  private persist(e: Entry): void {
    if (this.stateDir === undefined) return;
    const file = path.join(this.stateDir, `${e.runId}.json`);
    const data: PersistedEntry = {
      version: 1,
      ownerId: e.ownerId,
      runId: e.runId,
      lifecycle: e.lifecycle,
      events: e.events,
      nextSequence: e.nextSequence,
      metrics: e.metrics,
      ...(e.pause && { pause: copyPause(e.pause) }),
      ...(e.lease && { lease: e.lease }),
      ...(e.outcome && { outcome: e.outcome }),
      wake: { entries: e.wake.entries.map((w) => ({ ...w })) },
    };
    if (this.store !== undefined) {
      // Read-modify-write over the on-disk wake state, so a blind persist (the
      // lease heartbeat here, or a detached worker's own persist) can never
      // clobber a handled/unhandled window another writer recorded. `mergeWake`
      // unions by kind and lets a handled window win over a stale unhandled one.
      this.store.mutateVersionedJson<PersistedEntry>(file, (current) => {
        const wake = mergeWake(current?.value?.wake, data.wake);
        return { ...data, ...(wake === undefined ? {} : { wake }) };
      });
      return;
    }
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  private refresh(runId: string): void {
    if (this.stateDir === undefined) return;
    const file = path.join(this.stateDir, `${runId}.json`);
    let persisted: PersistedEntry;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      persisted = parsePersistedEntry(raw.value ?? raw);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw new BackgroundRunError("state_unavailable", runId);
    }
    if (persisted.ownerId !== this.ownerId) return;
    const entry = this.entries.get(runId);
    if (entry === undefined || entry.active) return;
    const changed = persisted.nextSequence !== entry.nextSequence;
    entry.lifecycle = persisted.lifecycle;
    entry.events = persisted.events.map(copyEvent);
    entry.nextSequence = persisted.nextSequence;
    entry.metrics = copyMetrics(persisted.metrics);
    entry.pause = persisted.pause === undefined ? undefined : copyPause(persisted.pause);
    entry.lease = persisted.lease;
    entry.outcome = persisted.outcome === undefined ? undefined : copyOutcome(persisted.outcome);
    entry.wake = { entries: (persisted.wake?.entries ?? []).map((w) => ({ ...w })) };
    if (changed) this.notify(entry);
  }
  private ensureWatcher(): void {
    if (this.stateDir === undefined || this.watcher !== undefined) return;
    try {
      this.watcher = fs.watch(this.stateDir, (_event, filename) => {
        try {
          const name = filename?.toString();
          if (name?.endsWith(".json")) {
            const runId = name.slice(0, -5);
            if (this.entries.has(runId)) this.refresh(runId);
            return;
          }
          for (const runId of this.entries.keys()) this.refresh(runId);
        } catch {
          this.stopWatcher();
          this.subscribers.clear();
          console.error(
            "ad-coder: background state became unavailable; use polling after state recovery",
          );
        }
      });
    } catch {
      throw new BackgroundRunError("state_unavailable");
    }
  }
  private stopWatcher(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }
  private notify(entry: Entry): void {
    for (const subscriber of this.subscribers) {
      const cursor = subscriber.cursors.get(entry.runId) ?? 0;
      const page = this.eventsOf(entry, cursor, this.limits.maxPageSize);
      const pending = page.nextCursor < entry.nextSequence - 1;
      if (page.events.length === 0 && !page.gap && !pending) continue;
      const oldest = entry.events[0]?.sequence ?? entry.nextSequence;
      const droppedEvents = page.gap ? Math.max(0, oldest - cursor - 1) : 0;
      subscriber.cursors.set(entry.runId, page.nextCursor);
      this.enqueue(subscriber, {
        type: "background_events",
        runId: entry.runId,
        ...page,
        droppedEvents,
        pending,
      });
    }
  }
  private enqueue(subscriber: BackgroundSubscriber, notice: BackgroundRunNotice): void {
    if (!subscriber.active) return;
    if (subscriber.queue.length >= this.limits.subscriberQueueCapacity) {
      const replaced = subscriber.queue.shift();
      if (replaced !== undefined) {
        notice.droppedEvents += replaced.droppedEvents + replaced.events.length;
        notice.pending = true;
      }
    }
    subscriber.queue.push(notice);
    this.drainSubscriber(subscriber);
  }
  private drainSubscriber(subscriber: BackgroundSubscriber): void {
    if (!subscriber.active || subscriber.draining) return;
    subscriber.draining = true;
    queueMicrotask(async () => {
      try {
        while (subscriber.active) {
          const notice = subscriber.queue.shift();
          if (notice === undefined) break;
          await subscriber.consumer(notice);
        }
      } catch {
        this.removeSubscriber(subscriber);
        console.error("ad-coder: background subscriber failed; subscription removed");
      } finally {
        subscriber.draining = false;
        if (subscriber.active && subscriber.queue.length > 0) this.drainSubscriber(subscriber);
      }
    });
  }
  private deactivateSubscriber(subscriber: BackgroundSubscriber): void {
    subscriber.active = false;
    subscriber.queue.length = 0;
  }
  private removeSubscriber(subscriber: BackgroundSubscriber): void {
    this.deactivateSubscriber(subscriber);
    this.subscribers.delete(subscriber);
    if (this.subscribers.size === 0) this.stopWatcher();
  }
  private eventsOf(entry: Entry, cursor: number, limit: number): BackgroundEventPage {
    const countCap = Math.min(limit, this.limits.maxPageSize);
    const oldest = entry.events[0]?.sequence ?? entry.nextSequence;
    const gap = cursor + 1 < oldest;
    const effective = gap ? oldest - 1 : cursor;
    const events: BackgroundRunEvent[] = [];
    let bytes = 2;
    for (const event of entry.events) {
      if (event.sequence <= effective || events.length >= countCap) continue;
      const size = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes + size > this.limits.maxPageBytes) break;
      events.push(copyEvent(event));
      bytes += size;
    }
    return { events, nextCursor: events.at(-1)?.sequence ?? effective, gap };
  }
  private load(): void {
    if (this.stateDir === undefined) return;
    for (const name of fs.readdirSync(this.stateDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.stateDir, name), "utf8"));
        const persisted = parsePersistedEntry(raw.value ?? raw);
        if (persisted.ownerId !== this.ownerId) continue;
        const interrupted = !isTerminal(persisted.lifecycle);
        // A recorded pause survives worker exit BY DESIGN (issue #261): the
        // pause record carries its own recovery action, so a stale lease
        // makes it abandoned no more than a completed run's terminal record.
        const abandoned =
          interrupted &&
          persisted.lifecycle !== "paused" &&
          persisted.lifecycle !== "requested" &&
          !hasFreshLease(persisted.lease, this.limits.leaseMs);
        const entry: Entry = {
          version: 1,
          ownerId: persisted.ownerId,
          runId: persisted.runId,
          lifecycle: persisted.lifecycle,
          events: persisted.events.map(copyEvent),
          nextSequence: persisted.nextSequence,
          metrics: copyMetrics(persisted.metrics),
          ...(persisted.pause === undefined ? {} : { pause: copyPause(persisted.pause) }),
          ...(persisted.outcome !== undefined
            ? { outcome: copyOutcome(persisted.outcome) }
            : abandoned
              ? {
                  outcome: {
                    runId: persisted.runId,
                    lifecycle: "failed" as const,
                    metrics: copyMetrics(persisted.metrics),
                    recovery: "resume_pipeline" as const,
                    recoveryDetail: RESUME_PIPELINE_DETAIL,
                  },
                }
              : {}),
          active: false,
          cancelled: false,
          ...(persisted.lease === undefined ? {} : { lease: persisted.lease }),
          promise: Promise.resolve(),
          wake: { entries: (persisted.wake?.entries ?? []).map((w) => ({ ...w })) },
        };
        this.entries.set(entry.runId, entry);
        if (abandoned) {
          entry.lifecycle = "failed";
          entry.cancelled = true;
          entry.outcome = {
            runId: persisted.runId,
            lifecycle: "failed" as const,
            metrics: copyMetrics(persisted.metrics),
            recovery: "resume_pipeline" as const,
            recoveryDetail: RESUME_PIPELINE_DETAIL,
          };
          this.append(entry, "failed", {
            errorCode: "internal_failure",
            metrics: { ...entry.metrics },
          });
        }
      } catch {
        // A partial or malformed record is untrusted and deliberately unavailable.
      }
    }
  }
}
const LIFECYCLES = [
  "requested",
  "started",
  "stage_changed",
  "paused",
  "operator_attention",
  "failed",
  "cancelled",
  "timed_out",
  "completed",
] as const;
const TERMINAL_LIFECYCLES = ["failed", "cancelled", "timed_out", "completed"] as const;
const PHASES = ["plan", "research", "security", "code", "review", "done"] as const;
/**
 * Phases a durable pause can name. A pause can in principle stop on every
 * workflow phase, so the widest `WorkflowPhase` spelling is accepted where a
 * pause payload is parsed; stage-change events stay on the narrower set.
 */
const PAUSE_PHASES = ["plan", "research", "security", "code", "gates", "review", "done"] as const;
const STAGE_LIMIT_REASONS = [
  "duration",
  "model_turns",
  "tool_turns",
  "input",
  "cost",
  "cost_in_flight",
  "cost_unknown",
] as const;
const ERROR_CODES = ["internal_failure", "operator_attention", "deadline_exceeded"] as const;
const RECOVERIES = ["wait", "inspect_events", "resume_pipeline", "none"] as const;

function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("record must be an object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)))
    throw new TypeError("record contains an unknown field");
  return object;
}
function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new TypeError("record contains an invalid enum");
  return value as T;
}
function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new TypeError("record contains an invalid integer");
  return value as number;
}
function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new TypeError("record contains an invalid number");
  return value;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new TypeError("record contains an invalid string");
  return value;
}
function parseMetrics(value: unknown): { steps: number; totalCost: number } {
  const object = strictObject(value, ["steps", "totalCost"]);
  return { steps: safeInteger(object.steps), totalCost: finiteNumber(object.totalCost) };
}
function parseWakeEntry(value: unknown): WakeEntry {
  const object = strictObject(value, [
    "kind",
    "firstAt",
    "lastAt",
    "count",
    "handled",
    "handledAt",
  ]);
  const kind = enumValue(object.kind, WAKE_INITIATING_LIFECYCLES);
  if (typeof object.handled !== "boolean") throw new TypeError("wake handled is invalid");
  return {
    kind,
    firstAt: safeInteger(object.firstAt),
    lastAt: safeInteger(object.lastAt),
    count: safeInteger(object.count, 1),
    handled: object.handled,
    ...(object.handledAt === undefined ? {} : { handledAt: safeInteger(object.handledAt) }),
  };
}
function parseWake(value: unknown): { entries: WakeEntry[] } {
  const object = strictObject(value, ["entries"]);
  if (!Array.isArray(object.entries)) throw new TypeError("wake entries must be an array");
  return { entries: object.entries.map(parseWakeEntry) };
}
/**
 * Union two wake projections so a blind writer cannot erase another writer's
 * windows. A window's identity is its kind plus the timestamp that began it
 * (`firstAt`), NOT its handled state: two observations of the SAME window (one
 * writer marked it handled, another still holds it unhandled) collapse into
 * one where handled wins, while a genuinely new window of the same kind (a
 * later re-pause) keeps its own firstAt and stays distinct, so a blind merge
 * cannot erase a fresh unhandled window behind an already-handled one. Within
 * a window, count takes the widest single observation (the events folded into
 * one window) -- never a sum of two projections of the same window -- and
 * firstAt/lastAt take the min/max bounds.
 */
function mergeWake(
  a: { entries: WakeEntry[] } | undefined,
  b: { entries: WakeEntry[] } | undefined,
): { entries: WakeEntry[] } | undefined {
  if (a === undefined && b === undefined) return undefined;
  const byWindow = new Map<string, WakeEntry[]>();
  for (const w of [...(a?.entries ?? []), ...(b?.entries ?? [])]) {
    const key = `${w.kind}\u0000${w.firstAt}`;
    byWindow.set(key, [...(byWindow.get(key) ?? []), w]);
  }
  const entries: WakeEntry[] = [];
  for (const list of byWindow.values()) {
    const first = list[0];
    if (first === undefined) continue;
    const handled = list.some((w) => w.handled);
    let handledAt: number | undefined;
    for (const w of list)
      if (w.handledAt !== undefined)
        handledAt = handledAt === undefined ? w.handledAt : Math.max(handledAt, w.handledAt);
    entries.push({
      kind: first.kind,
      firstAt: Math.min(...list.map((w) => w.firstAt)),
      lastAt: Math.max(...list.map((w) => w.lastAt)),
      count: Math.max(...list.map((w) => w.count)),
      handled,
      ...(handledAt === undefined ? {} : { handledAt }),
    });
  }
  return { entries };
}
function copyMetrics(value: { steps: number; totalCost: number }): {
  steps: number;
  totalCost: number;
} {
  return { steps: value.steps, totalCost: value.totalCost };
}
function parsePause(value: unknown): BackgroundRunPause {
  const object = strictObject(value, ["phase", "code", "action", "limitReason", "limit", "cause"]);
  const pause = enumValue(object.phase, PAUSE_PHASES);
  const limitReason =
    object.limitReason === undefined
      ? undefined
      : enumValue(object.limitReason, STAGE_LIMIT_REASONS);
  return {
    phase: pause,
    code: requiredString(object.code),
    action: requiredString(object.action),
    ...(limitReason === undefined ? {} : { limitReason }),
    ...(object.limit === undefined ? {} : { limit: finiteNumber(object.limit) }),
    ...(object.cause === undefined ? {} : { cause: parsePauseCause(object.cause) }),
  };
}

/** Same bounds the write side clips to (orchestration/types.ts), re-checked on read. */
function parsePauseCause(value: unknown): PipelinePauseCause {
  const object = strictObject(value, ["code", "message", "recurrence"]);
  const code = object.code;
  const message = object.message;
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_PAUSE_CAUSE_CODE_CHARS)
    throw new TypeError("pause cause code is invalid");
  if (
    message !== undefined &&
    (typeof message !== "string" || message.length > MAX_PAUSE_CAUSE_MESSAGE_CHARS)
  )
    throw new TypeError("pause cause message is invalid");
  return {
    code,
    ...(message === undefined ? {} : { message }),
    recurrence: safeInteger(object.recurrence),
  };
}

/** A pause copy that owns its cause object, so no two records alias one. */
function copyPause(pause: PipelinePause): PipelinePause {
  return {
    ...pause,
    ...(pause.cause === undefined ? {} : { cause: { ...pause.cause } }),
  };
}
function parseEvent(value: unknown, runId: string): BackgroundRunEvent {
  const object = strictObject(value, [
    "sequence",
    "runId",
    "lifecycle",
    "timestamp",
    "stage",
    "pause",
    "errorCode",
    "metrics",
  ]);
  if (object.runId !== runId) throw new TypeError("event run does not match record");
  const lifecycle = enumValue(object.lifecycle, LIFECYCLES);
  const stage = object.stage === undefined ? undefined : enumValue(object.stage, PHASES);
  return {
    sequence: safeInteger(object.sequence, 1),
    runId,
    lifecycle,
    timestamp: safeInteger(object.timestamp),
    ...(stage === undefined ? {} : { stage }),
    ...(object.pause === undefined ? {} : { pause: parsePause(object.pause) }),
    ...(object.errorCode === undefined
      ? {}
      : { errorCode: enumValue(object.errorCode, ERROR_CODES) }),
    ...(object.metrics === undefined ? {} : { metrics: parseMetrics(object.metrics) }),
  };
}
function copyEvent(event: BackgroundRunEvent): BackgroundRunEvent {
  return {
    sequence: event.sequence,
    runId: event.runId,
    lifecycle: event.lifecycle,
    timestamp: event.timestamp,
    ...(event.stage === undefined ? {} : { stage: event.stage }),
    ...(event.pause === undefined ? {} : { pause: copyPause(event.pause) }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    ...(event.metrics === undefined ? {} : { metrics: copyMetrics(event.metrics) }),
  };
}
function parseOutcome(value: unknown, runId: string): BackgroundTerminalOutcome {
  const object = strictObject(value, [
    "runId",
    "lifecycle",
    "metrics",
    "recovery",
    "approved",
    "rounds",
    "verdict",
  ]);
  if (object.runId !== runId) throw new TypeError("outcome run does not match record");
  const lifecycle = enumValue(object.lifecycle, TERMINAL_LIFECYCLES);
  if (object.approved !== undefined && typeof object.approved !== "boolean")
    throw new TypeError("outcome approval is invalid");
  return {
    runId,
    lifecycle,
    metrics: parseMetrics(object.metrics),
    ...(object.recovery === undefined ? {} : { recovery: enumValue(object.recovery, RECOVERIES) }),
    ...(object.approved === undefined ? {} : { approved: object.approved }),
    ...(object.rounds === undefined ? {} : { rounds: safeInteger(object.rounds) }),
    ...(object.verdict === undefined
      ? {}
      : {
          verdict: enumValue(object.verdict, ["approved", "changes_requested", "not_run"] as const),
        }),
  };
}
function copyOutcome(outcome: BackgroundRunOutcome): BackgroundTerminalOutcome {
  // A paused run reports through status/result synthesis, never as a terminal
  // outcome; this guard is unreachable at runtime and exists to narrow.
  if (outcome.lifecycle === "paused") throw new TypeError("paused runs have no terminal outcome");
  return {
    runId: outcome.runId,
    lifecycle: outcome.lifecycle,
    metrics: copyMetrics(outcome.metrics),
    ...(outcome.recovery === undefined ? {} : { recovery: outcome.recovery }),
    ...(outcome.approved === undefined ? {} : { approved: outcome.approved }),
    ...(outcome.rounds === undefined ? {} : { rounds: outcome.rounds }),
    ...(outcome.verdict === undefined ? {} : { verdict: outcome.verdict }),
  };
}
function hasFreshLease(lease: PersistedEntry["lease"], leaseMs: number): boolean {
  return lease !== undefined && Date.now() - lease.heartbeatAt <= leaseMs;
}
function parsePersistedEntry(value: unknown): PersistedEntry {
  const object = strictObject(value, [
    "version",
    "ownerId",
    "runId",
    "lifecycle",
    "events",
    "nextSequence",
    "metrics",
    "pause",
    "lease",
    "outcome",
    "wake",
  ]);
  if (object.version !== 1 || !Array.isArray(object.events))
    throw new TypeError("record schema version is invalid");
  const ownerId = requiredString(object.ownerId);
  const runId = requiredString(object.runId);
  const lifecycle = enumValue(object.lifecycle, LIFECYCLES);
  const events = object.events.map((event) => parseEvent(event, runId));
  const nextSequence = safeInteger(object.nextSequence, 1);
  if (
    events.some(
      (event, index) =>
        event.sequence >= nextSequence ||
        (index > 0 && event.sequence <= (events[index - 1]?.sequence ?? 0)),
    )
  )
    throw new TypeError("event sequence is invalid");
  const lease =
    object.lease === undefined
      ? undefined
      : (() => {
          const leaseObject = strictObject(object.lease, ["workerId", "heartbeatAt"]);
          return {
            workerId: requiredString(leaseObject.workerId),
            heartbeatAt: safeInteger(leaseObject.heartbeatAt),
          };
        })();
  const pause = object.pause === undefined ? undefined : parsePause(object.pause);
  const outcome = object.outcome === undefined ? undefined : parseOutcome(object.outcome, runId);
  const wake = object.wake === undefined ? undefined : parseWake(object.wake);
  if (outcome !== undefined && outcome.lifecycle !== lifecycle)
    throw new TypeError("outcome lifecycle does not match record");
  if (isTerminal(lifecycle) !== (outcome !== undefined))
    throw new TypeError("terminal outcome is missing or unexpected");
  return {
    version: 1,
    ownerId,
    runId,
    lifecycle,
    events,
    nextSequence,
    metrics: parseMetrics(object.metrics),
    ...(pause === undefined ? {} : { pause }),
    ...(lease === undefined ? {} : { lease }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(wake === undefined ? {} : { wake }),
  };
}
function isTerminal(x: BackgroundLifecycle): x is BackgroundTerminalLifecycle {
  return (TERMINAL_LIFECYCLES as readonly string[]).includes(x);
}
function isOperatorAttention(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["pipeline_paused", "operator_attention", "stage_limit"].includes(
      String((error as { code: unknown }).code),
    )
  );
}
