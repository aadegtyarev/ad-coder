import type { Ledger } from "./ledger/ledger";
import type { RoleRunner } from "./runner/role-runner";

export interface WorkflowContext {
  runId: string;
  ledger: Ledger;
  /**
   * Present only when the CLI was given a `--target-dir`. A workflow that needs
   * to drive a role uses this; one that only reads `runId`/`ledger` never sees
   * it. Optional so existing workflows and `isWorkflowModule` are untouched.
   */
  runRole?: RoleRunner;
}

export interface WorkflowModule {
  name: string;
  run(ctx: WorkflowContext): Promise<unknown>;
}

/**
 * Structural check the CLI runs on a dynamically imported default export, so a
 * malformed module is rejected by name at the boundary instead of throwing a
 * TypeError somewhere inside the run.
 */
export function isWorkflowModule(value: unknown): value is WorkflowModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; run?: unknown };
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.run === "function"
  );
}
