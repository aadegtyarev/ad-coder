import type { AvailableTransition } from "./types";

/**
 * Why a driver's chosen transition was rejected at the drive boundary.
 *
 * - `transition_not_offered`: a driver returned a transition the completed
 *   `step` did not offer (no match by kind+toPhase+toRound). It is a hard,
 *   loud failure BECAUSE a driver -- human, `--auto`, or a future orchestrator
 *   -- must only ever commit an edge the engine itself put on the table; a
 *   forged or reconstructed edge that slipped past would drive the run off its
 *   own graph.
 */
export type DriveErrorCode = "transition_not_offered";

/**
 * Raised when the drive loop is handed a transition the step did not offer.
 * Carries a `code` discriminant and a names-only `detail` holding ONLY the
 * rejected transition's `kind` -- never model text, prompt content, or a runId
 * body. Mirrors `OrchestrationError`/`RunnerError` house style: safe tokens
 * only, dense WHY in JSDoc, nothing that leaks.
 */
export class DriveError extends Error {
  override readonly name = "DriveError";
  readonly code: DriveErrorCode;
  /** The rejected transition's kind (`advance`/`rework`/`stop`). Never content. */
  readonly detail: string;

  constructor(code: DriveErrorCode, detail: string, message: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Reject a transition the step did not offer. Matches by VALUE
 * (kind+toPhase+toRound), not reference identity: `autoDriver` and the human
 * mapping return an object from the offered array, but a future
 * orchestrator-driver may hand a reconstructed-but-equivalent edge, and a
 * reference-only check would wrongly reject it. `step` guarantees each kind is
 * unique within one offered set, so value equality is unambiguous.
 */
export function assertTransitionOffered(
  chosen: AvailableTransition,
  transitions: readonly AvailableTransition[],
): void {
  const offered = transitions.some(
    (t) => t.kind === chosen.kind && t.toPhase === chosen.toPhase && t.toRound === chosen.toRound,
  );
  if (!offered) {
    throw new DriveError(
      "transition_not_offered",
      chosen.kind,
      "chosen transition was not offered by the step",
    );
  }
}
