import { ProjectOperationsError } from "../project-operations/errors";
import { RunCoordinator } from "../project-operations/run-coordinator";
import { createWorkflowSession } from "./session";
import type { PipelineConfig, PipelineResult } from "./types";
import { OrchestrationError } from "./types";

/**
 * Compose the EXISTING single-turn `runRole` into a plan -> [security] ->
 * (code<->review loop) pipeline.
 *
 * WHY this is now three lines of loop: the whole step graph -- the transition
 * rules, model selection (`pickModel`), turn execution (`runTurn`), the prompt
 * composers and the `missing_verdict`/`malformed_*` throw points -- lives ONCE
 * in `createWorkflowSession` (session.ts). `runPipeline` is the AUTO-DRIVER over
 * that engine: it steps until the state settles, always taking the default
 * transition (`autoDriver`), then flattens the settled state into a
 * `PipelineResult`. This is byte-for-byte the prior behavior -- same signature,
 * same ledger step labels (`plan`/`security`/`code:N`/`review:N`), same runId
 * ordering, same errors at the same points.
 *
 * WHY the verdict is a `submit_verdict` TOOL CALL and not a filesystem artifact:
 * each reviewer round is handed a fresh `submit_verdict` tool that captures the
 * verdict from the model's tool-call args -- no file is written or read. TWO
 * non-obvious harness facts bridge the tool to the loop. (1) The harness
 * validates tool args against the TypeBox schema BEFORE execute, so that schema
 * is permissive at the enum leaves and `parseVerdict` stays the real gate -- a
 * strict schema would bounce a malformed verdict pre-execute and mis-code it as
 * missing_verdict. (2) The harness SWALLOWS any throw from execute into an error
 * tool-result, so the tool stores `parseVerdict`'s `OrchestrationError` in a
 * per-round capture holder instead of throwing, and the engine re-throws it
 * after the turn. Empty holder -> `missing_verdict`; captured error ->
 * `malformed_verdict`; captured verdict -> use (last-wins on a repeated call).
 *
 * THE LOOP settles when a reviewer round returns `status: 'approved'` or when
 * `maxRounds` is reached. Exhausting the cap returns
 * `outcome: "decomposition_required"` with `approved: false` -- a legitimate,
 * un-thrown result the caller inspects. A missing or malformed
 * verdict, by contrast, is a hard `OrchestrationError`: it is never read as a
 * pass. Runs are strictly sequential (no `Promise.all`/retry/fan-out), so a
 * shared `ledgerSink` is safe and per-round cost is attributed by the `step`
 * dimension (`plan`, `code:1`, `review:1`, `code:2`, ...) plus `role.name`.
 *
 * MODEL SELECTION is complexity-aware when `config.routing` is present: the
 * planner routes on `routing.defaultComplexity` (default `'medium'`) BEFORE its
 * plan is known, and every later role routes on the effective complexity (the
 * planner's submitted tier, else that same default). Absent routing, each turn
 * runs on its `RoleSpec.model` -- byte-for-byte the prior behavior. A caller
 * config error thrown by `resolveProfile` (`missing_mapping` / `unknown_model`)
 * is the caller's `ProfileError` and propagates UNWRAPPED, distinct from the
 * pipeline's own `OrchestrationError` surface.
 */
export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const session = createWorkflowSession(config);
  const coordinator = new RunCoordinator(session, session.projectStore, config.coordinator);
  const completed = await coordinator.run();
  if (completed.status === "paused" && completed.checkpoint.pause !== undefined) {
    const pause = completed.checkpoint.pause;
    throw new OrchestrationError(
      "requirements_unresolved",
      completed.checkpoint.runId,
      `${pause.code}: ${pause.action}`,
    );
  }
  if (completed.result === undefined) {
    const decision = completed.checkpoint.decisions.find((item) => item.status === "pending");
    throw new ProjectOperationsError(
      "pending_decision",
      decision?.id ?? completed.checkpoint.runId,
    );
  }
  return completed.result;
}
