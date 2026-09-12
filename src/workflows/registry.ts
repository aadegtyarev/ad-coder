import type { OrchestratorWorkflowModule } from "./types";

const WORKFLOW_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export function resolveWorkflowModules(
  modules: readonly OrchestratorWorkflowModule[],
  enabled: readonly string[],
): OrchestratorWorkflowModule[] {
  const available = new Map<string, OrchestratorWorkflowModule>();
  for (const module of modules) {
    if (!WORKFLOW_NAME.test(module.name))
      throw new Error(`invalid workflow module name: ${module.name}`);
    if (available.has(module.name)) throw new Error(`duplicate workflow module: ${module.name}`);
    available.set(module.name, module);
  }
  const seen = new Set<string>();
  return enabled.map((name) => {
    if (seen.has(name)) throw new Error(`duplicate enabled workflow module: ${name}`);
    seen.add(name);
    const module = available.get(name);
    if (module === undefined) throw new Error(`unknown workflow module: ${name}`);
    return module;
  });
}
