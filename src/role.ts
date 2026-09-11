import type { AgentHarnessOptions, Session } from "@earendil-works/pi-agent-core";
import type { Api, CacheRetention, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ContextBudget } from "./context/budget";
import { validateContextBudget } from "./context/budget";

const CACHE_RETENTIONS: readonly CacheRetention[] = ["none", "short", "long"];

/**
 * A validated preset over the role-owned slice of `AgentHarnessOptions`.
 *
 * `session`, `models` and `model` are deliberately absent: they are per-run,
 * not per-role, and are supplied to `toHarnessOptions` instead.
 */
export interface Role {
  name: string;
  provider: string;
  modelId: string;
  /** Passed to the harness verbatim. Never a function, never concatenated. */
  systemPrompt: string;
  /**
   * The capability allow-list. Default-open: ABSENT means "every registered
   * tool" (the harness reads `activeToolNames ?? tools.map((t) => t.name)`), a
   * present empty array is a valid deny-all, and a present non-empty array is
   * the exact set. Only absence is new behaviour -- every existing role sets
   * this explicitly, so making it optional changes nothing that is in use.
   */
  activeToolNames?: string[];
  cacheRetention: CacheRetention;
  /** ad-coder's own context ceiling, validated against the model's window. */
  contextBudget: ContextBudget;
}

export interface RoleRunDeps {
  session: Session;
  models: Models;
  model: Model<Api>;
}

/**
 * Validate a preset at its boundary, so a malformed role cannot reach the
 * harness. The `model` is supplied by the caller (not resolved from a catalog)
 * so a local or custom OpenAI-compatible endpoint absent from the builtin
 * catalog still validates against its real `contextWindow`.
 */
export function defineRole(input: Role, model: Model<Api>): Role {
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new Error("defineRole: name must be a non-empty string");
  }
  if (typeof input.provider !== "string" || input.provider.trim() === "") {
    throw new Error(`defineRole(${input.name}): provider must be a non-empty string`);
  }
  if (typeof input.modelId !== "string" || input.modelId.trim() === "") {
    throw new Error(`defineRole(${input.name}): modelId must be a non-empty string`);
  }
  if (typeof input.systemPrompt !== "string" || input.systemPrompt === "") {
    throw new Error(`defineRole(${input.name}): systemPrompt must be a non-empty string`);
  }
  // Guard on PRESENCE, not truthiness: an absent field is default-open and
  // valid, but a field that IS present must be a real array -- a string, 0 or
  // any other non-array is still a malformed allow-list and throws.
  if (input.activeToolNames !== undefined) {
    if (!Array.isArray(input.activeToolNames)) {
      throw new Error(
        `defineRole(${input.name}): activeToolNames must be an array (use [] to allow no tools)`,
      );
    }
    const seen = new Set<string>();
    for (const toolName of input.activeToolNames) {
      if (typeof toolName !== "string" || toolName.trim() === "") {
        throw new Error(`defineRole(${input.name}): activeToolNames contains an empty entry`);
      }
      if (seen.has(toolName)) {
        throw new Error(
          `defineRole(${input.name}): activeToolNames contains duplicate "${toolName}"`,
        );
      }
      seen.add(toolName);
    }
  }
  if (!CACHE_RETENTIONS.includes(input.cacheRetention)) {
    throw new Error(
      `defineRole(${input.name}): cacheRetention must be one of ${CACHE_RETENTIONS.join(", ")}`,
    );
  }
  validateContextBudget(input.name, input.contextBudget, model);
  return input;
}

/** Project a role plus its per-run dependencies onto harness options. */
export function toHarnessOptions(role: Role, deps: RoleRunDeps): AgentHarnessOptions {
  return {
    session: deps.session,
    models: deps.models,
    model: deps.model,
    systemPrompt: role.systemPrompt,
    // Branch on `!== undefined`, NEVER on `.length` or truthiness. The harness
    // reads `options.activeToolNames ?? tools.map((t) => t.name)`, so an absent
    // key grants every registered tool. A present value -- INCLUDING a `[]`
    // deny-all -- must survive verbatim; a `.length` test would emit no key for
    // `[]` and silently turn deny-all into full tool access. Absence omits the
    // key entirely so a default-open role inherits the harness's grant-all.
    ...(role.activeToolNames !== undefined && {
      activeToolNames: [...role.activeToolNames],
    }),
    streamOptions: { cacheRetention: role.cacheRetention },
    // Pi's compaction prompt is a hardcoded constant, so the context strategy
    // stays in ad-coder. All three fields are required even when disabled.
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
  };
}

/**
 * Resolve a role's model from the built-in catalog, which also supplies the
 * `Models` collection the harness requires. Uses `builtinModels().getModel`
 * rather than `getBuiltinModel`, whose signature demands literal-typed
 * provider and model keys that a `Role`'s plain strings cannot satisfy.
 */
export function resolveRoleModel(role: Role): { model: Model<Api>; models: Models } {
  const models = builtinModels();
  const model = models.getModel(role.provider, role.modelId);
  if (model === undefined) {
    throw new Error(
      `resolveRoleModel(${role.name}): no built-in model "${role.modelId}" for provider "${role.provider}"`,
    );
  }
  return { model, models };
}
