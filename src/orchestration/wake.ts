import type { PendingWake, WakeKind } from "./background-runs";
import { RESUME_PIPELINE_DETAIL } from "./background-runs";

/**
 * Turn-initiating wake delivery for background runs (issue #387).
 *
 * State notices (`paused`, `failed`, ...) must start an orchestrator turn; the
 * durable wake records in `background-runs.ts` carry exactly the safe fields
 * (`parsePause`-validated) a turn may react on. This module builds the fixed
 * prompt and drains pending wakes into bounded turns. Activity notices stay
 * rendering-only and never reach this path.
 */

/**
 * Build a wake turn prompt from a batch of pending wakes, using ONLY the
 * record's own safe fields (runId, lifecycle, `parsePause`-validated pause
 * payload, metrics). Never raw event prose or the run's task content.
 */
export function buildWakeTurnPrompt(wakes: readonly PendingWake[]): string {
  const lines: string[] = [];
  lines.push(
    "Background runs recorded state notices that need an orchestrator decision. Act on each one below.",
  );
  for (const wake of wakes) {
    lines.push("");
    lines.push(`- run ${wake.runId}: ${wake.kind}`);
    if (wake.pause !== undefined) {
      lines.push(`  - pause: phase=${wake.pause.phase} code=${wake.pause.code}`);
      if (wake.pause.limitReason !== undefined)
        lines.push(`    limitReason=${wake.pause.limitReason}`);
      if (wake.pause.limit !== undefined) lines.push(`    limit=${wake.pause.limit}`);
      if (wake.pause.action !== undefined) lines.push(`    action=${wake.pause.action}`);
    }
    if (wake.metrics !== undefined)
      lines.push(`  - metrics: steps=${wake.metrics.steps} totalCost=${wake.metrics.totalCost}`);
    lines.push(
      `  - coalesced: ${wake.count} notice(s) since ${new Date(wake.firstAt).toISOString()}`,
    );
  }
  lines.push("");
  lines.push(
    "Resolution rules: a `stage_limit` pause is resolved by calling resume_pipeline with " +
      "exactly ONE raiseRole, ONE raiseReason, and a raiseLimit LARGER than the exhausted value " +
      "(the coordinator refuses an unchanged ceiling). A `failed`, `completed`, `timed_out`, " +
      "`operator_attention`, or `stage_changed` notice is handled, or explicitly recorded why it " +
      "cannot be. Do not model any content or raw event prose, and use no parallel resolver " +
      "beside resume_pipeline.",
  );
  lines.push(RESUME_PIPELINE_DETAIL);
  return lines.join("\n");
}

export interface WakePumpDeps {
  listPending: () => PendingWake[];
  markHandled: (runId: string, kinds: readonly WakeKind[]) => void;
  runTurn: (prompt: string, step: string) => Promise<void>;
  maxWakesPerTurn?: number;
}

/**
 * Drains pending durable wakes into orchestrator turns, one turn per batch.
 *
 * Single-flight: `runTurn` is never called while a turn is active or a drain is
 * in flight. `notifyChange()` re-reads durable state, so a dropped notice page
 * loses nothing. A drain batches up to `maxWakesPerTurn` unhandled windows into
 * ONE turn, marks them handled after it resolves, and reschedules only if
 * unhandled windows remain.
 */
export class WakePump {
  private readonly maxWakesPerTurn: number;
  private inFlight = false;
  private scheduled = false;
  private turnCounter = 0;
  private idleResolver: (() => void) | undefined;

  constructor(private readonly deps: WakePumpDeps) {
    this.maxWakesPerTurn = deps.maxWakesPerTurn ?? 8;
    if (!Number.isSafeInteger(this.maxWakesPerTurn) || this.maxWakesPerTurn <= 0)
      throw new TypeError("maxWakesPerTurn must be a positive integer");
  }

  /** Re-read durable state and drain whatever is unhandled, if idle. */
  notifyChange(): void {
    this.schedule();
  }

  /** Re-read durable state after a turn settled, so nothing pending is missed. */
  onTurnSettled(): void {
    this.schedule();
  }

  /** Drain pending wakes discovered at startup; resolves once idle. */
  async startupScan(): Promise<void> {
    this.schedule();
    await this.awaitIdle();
  }

  private schedule(): void {
    if (this.scheduled || this.inFlight) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const pending = this.deps.listPending();
      if (pending.length === 0) return;
      const batch = pending.slice(0, this.maxWakesPerTurn);
      const step = `wake:${++this.turnCounter}`;
      await this.deps.runTurn(buildWakeTurnPrompt(batch), step);
      // Mark handled only after the turn resolves, so a failed turn leaves the
      // wakes unhandled for the next drain.
      for (const wake of batch) this.deps.markHandled(wake.runId, [wake.kind]);
    } finally {
      this.inFlight = false;
      // Reschedule only if unhandled windows remain; then signal idle when a
      // settle leaves nothing queued.
      if (this.deps.listPending().length > 0) {
        this.schedule();
      } else if (this.idleResolver !== undefined) {
        const resolve = this.idleResolver;
        this.idleResolver = undefined;
        resolve();
      }
    }
  }

  private awaitIdle(): Promise<void> {
    if (!this.inFlight && !this.scheduled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleResolver = resolve;
    });
  }
}
