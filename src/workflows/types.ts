import type { Orchestrator } from "../orchestration/orchestrator";
import type { Tool } from "../runner/tool";

/** A trusted, named workflow contribution to the conversational orchestrator. */
export interface OrchestratorWorkflowModule {
  name: string;
  description: string;
  buildTools(core: Orchestrator): Tool[];
}
