import { PROVIDER_ERROR_CODE_BOUND } from "../runner/errors";
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

/**
 * The typed code only (an identifier, never content): the read is TOTAL and the
 * value is BOUNDED.
 *
 * Total: a poisoned `code` getter (or a Proxy that refuses `has`/`get`) degrades
 * to `unknown` instead of escaping through the boundary itself.
 *
 * Bounded: the line this feeds is documented as "one bounded, identifier-only
 * stderr line" (`docs/contracts/errors.md`, 2026-09-20 issue #430), so an
 * arbitrary `code` -- long, whitespace-laden, or an embedded newline -- must not
 * reach it. The rule is the project's own (2026-09-19 issue #418): a code that
 * fails its bound is DROPPED, never truncated, and a non-string is dropped too
 * (`String(...)` would render `[object Object]`-shaped junk). The bound below is
 * the canonical one from `src/runner/errors.ts`, reused rather than re-invented.
 */
function safeErrorCode(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code: unknown = (error as { code: unknown }).code;
      if (typeof code === "string" && PROVIDER_ERROR_CODE_BOUND.test(code)) return code;
    }
  } catch {
    // Fall through to the "unknown" default.
  }
  return "unknown";
}

/**
 * One bounded, identifier-only failure line for a contained drain boundary:
 * the typed code only (identifier, never content), plus the action that state
 * allows -- retrying on the next nudge, since nothing was marked handled.
 */
function drainErrorLine(error: unknown): string {
  const code = safeErrorCode(error);
  return `failed to read pending wakes (${code}); the wakes stay unhandled and drain on the next nudge`;
}

export interface WakePumpDeps {
  listPending: () => PendingWake[];
  markHandled: (runId: string, kinds: readonly WakeKind[]) => void;
  runTurn: (prompt: string, step: string) => Promise<void>;
  maxWakesPerTurn?: number;
  /** True while a front / wake turn is running; the pump must defer, never race it. */
  turnActive?: () => boolean;
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
      // A front turn owns the conversation right now; defer rather than race it.
      // The wake stays durably unhandled and drains on the next nudge (a new
      // notice or the front turn's settle) -- never lost, never hot-looped.
      if (this.deps.turnActive?.()) return;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    let succeeded = false;
    // Reading durable wake state (`listPending` -> `pendingWakes` -> `refresh`)
    // is typed, but this method is entered through `void this.drain()` with
    // nothing above it to catch (issue #430): a `state_unavailable` failure
    // reading one run record surfaced as an unhandled rejection and killed the
    // console's 0-second wake turn with an empty ledger. Every boundary here --
    // the initial read, the batch turn, the handled mark, and the post-drain
    // re-read -- is contained: one bounded, code-first stderr line, `inFlight`
    // reset in `finally`, and the wakes stay durably unhandled for the next
    // nudge (never hot-looped, never lost).
    try {
      let pending: PendingWake[];
      try {
        pending = this.deps.listPending();
      } catch (error) {
        console.error(`ad-coder: wake state unavailable; ${drainErrorLine(error)}`);
        pending = [];
      }
      if (pending.length === 0) return;
      const batch = pending.slice(0, this.maxWakesPerTurn);
      const step = `wake:${++this.turnCounter}`;
      try {
        await this.deps.runTurn(buildWakeTurnPrompt(batch), step);
      } catch (error) {
        // A racing failure (e.g. `conversation step already active`) must not
        // escape through `void this.drain()` as an unhandled rejection, and must
        // not hot-loop: mark NOTHING handled, report one bounded line to stderr,
        // and leave the batch unhandled for the next nudge.
        // Identifier-only stderr (round 2, issue #430): never the error
        // message -- it may carry user data; the code is the safe identifier.
        console.error(`ad-coder: wake turn failed (${step}); code=${safeErrorCode(error)}`);
        return;
      }
      // Mark handled only after the turn resolves, so a failed turn leaves the
      // wakes unhandled for the next drain.
      try {
        for (const wake of batch) this.deps.markHandled(wake.runId, [wake.kind]);
      } catch (error) {
        // Marking handled touches the same durable state; a failure here leaves
        // the batch to the next nudge, exactly like a failed turn.
        console.error(`ad-coder: wake mark failed; ${drainErrorLine(error)}`);
        return;
      }
      succeeded = true;
    } finally {
      this.inFlight = false;
      // After a SUCCESSFUL drain, reschedule only if unhandled windows remain
      // (the per-turn cap left some behind). A FAILED drain leaves everything
      // unhandled on purpose and must stay quiescent until the next nudge, so
      // it never hot-loops. The re-read is itself a durable read and is
      // contained the same way as the initial one.
      let remaining = false;
      try {
        remaining = succeeded && this.deps.listPending().length > 0;
      } catch (error) {
        console.error(`ad-coder: wake state unavailable; ${drainErrorLine(error)}`);
      }
      if (remaining) {
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
