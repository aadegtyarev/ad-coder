import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

/**
 * ad-coder's own tool surface. A `Tool` is a harness tool bound to the runner's
 * `ExecutionToolContext` -- the same context the built-in bash/read/write/edit
 * tools receive -- so a caller-supplied tool slots into the runner's combined
 * tool array without exposing the raw pi harness type at ad-coder's boundary.
 *
 * The parameter schema and detail generics are erased to their defaults here;
 * use `defineTool` when building a concrete tool so those generics are preserved
 * through construction.
 */
export type Tool = AgentHarnessTool<ExecutionToolContext>;

/**
 * Identity helper for authoring a custom runner tool, mirroring `defineRole`.
 *
 * It exists so callers build tools against ad-coder's surface rather than
 * importing the raw `AgentHarnessTool` from pi: the generics `P`/`D` are
 * preserved on the return (a tool built with a concrete parameter schema keeps
 * its `Static<P>` execute signature) while the result stays assignable to the
 * runner's `Tool[]` array. There is no runtime transformation -- the same object
 * is returned -- so wrapping a tool is free and only shapes types.
 */
export function defineTool<P extends TSchema = TSchema, D = unknown>(
  tool: AgentHarnessTool<ExecutionToolContext, P, D>,
): AgentHarnessTool<ExecutionToolContext, P, D> {
  return tool;
}
