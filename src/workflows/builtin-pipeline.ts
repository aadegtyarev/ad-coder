import { buildBuiltInPipelineTools } from "../orchestration/orchestrator";
import type { OrchestratorWorkflowModule } from "./types";

export const BUILT_IN_PIPELINE_WORKFLOW_NAME = "pipeline";

// This is intentionally a registration adapter: it owns the public module name
// and activation boundary while the legacy pipeline core remains headless and
// directly callable. Moving the graph/config bundle is tracked separately so
// registration does not duplicate or regenerate working orchestration logic.
export const BUILT_IN_PIPELINE_WORKFLOW: OrchestratorWorkflowModule = Object.freeze({
  name: BUILT_IN_PIPELINE_WORKFLOW_NAME,
  description: "Reviewed plan, optional research/security, code, and review workflow.",
  buildTools: buildBuiltInPipelineTools,
});
