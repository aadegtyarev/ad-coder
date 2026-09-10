import type { WorkflowContext, WorkflowModule } from "ad-coder";

/**
 * The smallest module `ad-coder run` accepts. A real workflow would build a
 * Role, attach the ledger to a harness's hooks and drive a lane; this one only
 * demonstrates the contract, so it makes no provider call.
 */
const workflow: WorkflowModule = {
  name: "hello",
  async run(ctx: WorkflowContext): Promise<unknown> {
    return { greeting: "hello from ad-coder", runId: ctx.runId, role: ctx.ledger.role };
  },
};

export default workflow;
