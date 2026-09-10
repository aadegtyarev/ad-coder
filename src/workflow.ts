import type { Ledger } from "./ledger/ledger";

export interface WorkflowContext {
  runId: string;
  ledger: Ledger;
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
