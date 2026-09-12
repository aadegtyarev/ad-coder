import type { ContextBudget } from "../context/budget";
import type { CompactionMode } from "../context/compactor";
import { MemoryLedgerSink } from "../ledger/ledger";
import { SUBMIT_PLAN_TOOL_NAME } from "../orchestration/plan";
import type { Complexity, PipelineConfig, RoleSpec } from "../orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../orchestration/verdict";
import { buildDefaultProfile } from "../profiles/default-profile";
import { resolveProfile } from "../profiles/resolve";
import type { Profile, ProfileRole } from "../profiles/types";
import type { ProjectStoreConfig } from "../project-store/types";
import { resolvePrompt } from "../prompts/prompts";
import { deepseekPreset, openaiCodexPreset, openrouterPreset } from "../registry/presets";
import { resolveRegistry } from "../registry/resolve";
import type { ProviderConfig, RegistryConfig, ResolvedRegistry } from "../registry/types";
import type { Role } from "../role";
import { defineRole } from "../role";

/**
 * The three shipped providers this resolver can select from the environment.
 * `openai-codex` is the OAuth fallback (no env-var key); the other two are
 * env-var providers whose key is read through the injected `env` accessor.
 */
export type ResolvableProvider = "deepseek" | "openrouter" | "openai-codex";

/**
 * How the context budget is derived as PERCENTS of the chosen model's window
 * (docs/contracts/config.md: the budget must be a percent of the context
 * window, never a hardcoded single value). Each is a fraction in (0, 1). The
 * defaults ship an efficient budget that validates against every shipped
 * preset's window; a caller may override any of them.
 *
 * `maxTokensPercent` is the whole-turn ceiling; `reserveTokensPercent` is the
 * reply reserve; `keepRecentTokensPercent` is the recent tail the compactor
 * never evicts. `reserve + keepRecent` must stay below `maxTokens` (enforced by
 * `defineRole`), which the defaults satisfy (0.10 + 0.25 < 0.90).
 */
export interface BudgetPercents {
  maxTokensPercent?: number;
  reserveTokensPercent?: number;
  keepRecentTokensPercent?: number;
}

const DEFAULT_BUDGET_PERCENTS = {
  maxTokensPercent: 0.9,
  reserveTokensPercent: 0.1,
  keepRecentTokensPercent: 0.25,
} as const;

/** maxRounds default when the caller does not override it. */
const DEFAULT_MAX_ROUNDS = 3;
/** The complexity every pre-plan role and later fallback routes on by default. */
const DEFAULT_COMPLEXITY: Complexity = "medium";

/**
 * Everything `resolvePipelineConfig` needs to build a runnable `PipelineConfig`
 * from the environment.
 *
 * `env` is the ONLY credential surface (defaults to `process.env`); the body
 * never touches `process.env` except as that default accessor. `provider`
 * overrides the env-presence precedence. The three model NAMES each default to
 * the chosen preset's default model, so a single-provider run needs none of
 * them. `warn` receives operator-facing notices (which provider/model the task
 * is being sent to, and a multi-key precedence warning) on stderr by default;
 * injectable so tests capture it instead of writing to the real stderr.
 */
export interface ResolvePipelineConfigOptions {
  task: string;
  targetDir: string;
  env?: (name: string) => string | undefined;
  provider?: ResolvableProvider;
  strongModel?: string;
  midModel?: string;
  cheapModel?: string;
  compactionMode?: CompactionMode;
  summarizerModel?: string;
  allowCrossProviderSummarization?: boolean;
  maxRounds?: number;
  defaultComplexity?: Complexity;
  budgetPercents?: BudgetPercents;
  warn?: (message: string) => void;
  projectStoreConfig?: ProjectStoreConfig;
}

/** Env-var names whose PRESENCE selects a provider, in precedence order. */
const PROVIDER_BY_ENV: ReadonlyArray<{ envVar: string; provider: ResolvableProvider }> = [
  { envVar: "DEEPSEEK_API_KEY", provider: "deepseek" },
  { envVar: "OPENROUTER_API_KEY", provider: "openrouter" },
];

/** The preset builder and its default model NAME for each resolvable provider. */
const PROVIDER_PRESETS: Record<
  ResolvableProvider,
  { preset: () => ProviderConfig; defaultModel: string }
> = {
  deepseek: { preset: deepseekPreset, defaultModel: "deepseek-chat" },
  openrouter: { preset: openrouterPreset, defaultModel: "openrouter-auto" },
  "openai-codex": { preset: openaiCodexPreset, defaultModel: "codex-gpt-5.5" },
};

/**
 * Choose the provider: an explicit `provider` wins; otherwise the FIRST env-var
 * whose key is present in precedence order (DeepSeek -> OpenRouter); otherwise
 * the codex OAuth fallback. When more than one env-var key is present and the
 * caller did not pin a provider, warn that precedence was applied silently so
 * the operator sees where the task is going.
 */
function selectProvider(
  env: (name: string) => string | undefined,
  explicit: ResolvableProvider | undefined,
  warn: (message: string) => void,
): ResolvableProvider {
  if (explicit !== undefined) {
    return explicit;
  }
  const present = PROVIDER_BY_ENV.filter(({ envVar }) => {
    const value = env(envVar);
    return value !== undefined && value !== "";
  });
  if (present.length > 1) {
    warn(
      `ad-coder: warning: multiple provider keys present (${present
        .map((p) => p.envVar)
        .join(
          ", ",
        )}); selecting "${present[0]?.provider}" by precedence -- pass --provider to choose\n`,
    );
  }
  return present[0]?.provider ?? "openai-codex";
}

/**
 * Derive a single `ContextBudget` valid for every role from the SMALLEST window
 * among the chosen tier models, so the one budget validates whichever model a
 * role routes to. Expressed as percents of that window per the config contract.
 */
function deriveBudget(minWindow: number, percents: BudgetPercents | undefined): ContextBudget {
  const p = { ...DEFAULT_BUDGET_PERCENTS, ...(percents ?? {}) };
  return {
    maxTokens: Math.floor(minWindow * p.maxTokensPercent),
    reserveTokens: Math.floor(minWindow * p.reserveTokensPercent),
    keepRecentTokens: Math.floor(minWindow * p.keepRecentTokensPercent),
  };
}

/**
 * Resolve a runnable `PipelineConfig` from the environment: select a provider,
 * build its registry from the shipped preset, route strong/mid/cheap NAMES
 * through the default profile, derive a window-relative budget, and build the
 * four pipeline roles from the built-in prompts.
 *
 * CREDENTIAL BOUNDARY. Keys resolve ONLY through the injected `env` accessor,
 * handed straight to `resolveRegistry({ env })`. A selected env-var provider
 * whose key is unset throws `RegistryError('missing_credential', <VAR-NAME>)`
 * (name only) from `resolveRegistry`; this function does NOT catch or reformat
 * it. The codex fallback is OAuth-only and never throws `missing_credential`.
 */
export function resolvePipelineConfig(options: ResolvePipelineConfigOptions): PipelineConfig {
  const env = options.env ?? ((name: string) => process.env[name]);
  const warn = options.warn ?? ((message: string) => void process.stderr.write(message));

  const provider = selectProvider(env, options.provider, warn);
  const { preset, defaultModel } = PROVIDER_PRESETS[provider];

  const strong = options.strongModel ?? defaultModel;
  const mid = options.midModel ?? defaultModel;
  const cheap = options.cheapModel ?? defaultModel;
  const compactionMode = options.compactionMode ?? "auto";
  if (compactionMode === "cache-aware") {
    throw new Error('context compaction mode "cache-aware" is not supported yet');
  }
  if (compactionMode !== "auto" && compactionMode !== "disabled-then-halt") {
    throw new Error(`unknown context compaction mode "${String(compactionMode)}"`);
  }

  const registryConfig: RegistryConfig = { providers: [preset()] };
  const registry: ResolvedRegistry = resolveRegistry(registryConfig, { env });
  const summarizerModelName = options.summarizerModel ?? cheap;
  const summarizerModel = registry.getModel(summarizerModelName);

  const profile: Profile = buildDefaultProfile({ strong, mid, cheap });
  const defaultComplexity = options.defaultComplexity ?? DEFAULT_COMPLEXITY;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;

  // The budget must validate against EVERY role's model, so derive it from the
  // smallest window among the tier models a role can route to.
  const minWindow = Math.min(
    registry.getModel(strong).contextWindow,
    registry.getModel(mid).contextWindow,
    registry.getModel(cheap).contextWindow,
  );
  const budget = deriveBudget(minWindow, options.budgetPercents);

  warn(`ad-coder: provider "${provider}" | strong "${strong}" mid "${mid}" cheap "${cheap}"\n`);

  const buildRole = (name: ProfileRole, tools: string[]): RoleSpec => {
    // The role's live model is whatever the default profile routes it to at
    // defaultComplexity; the budget is validated against that same model.
    const model = resolveProfile(profile, registry, name, defaultComplexity).model;
    const role: Role = defineRole(
      {
        name,
        provider: model.provider,
        modelId: model.id,
        systemPrompt: resolvePrompt(name, { projectDir: options.targetDir }),
        activeToolNames: tools,
        cacheRetention: "short",
        contextBudget: budget,
      },
      model,
    );
    return { role, model };
  };

  const roles = {
    planner: buildRole("planner", ["read", "bash", SUBMIT_PLAN_TOOL_NAME]),
    security: buildRole("security", ["read", "bash"]),
    coder: buildRole("coder", ["read", "write", "edit", "bash"]),
    reviewer: buildRole("reviewer", ["read", "bash", SUBMIT_VERDICT_TOOL_NAME]),
  };

  return {
    targetDir: options.targetDir,
    models: registry.models,
    task: options.task,
    maxRounds,
    roles,
    ledgerSink: new MemoryLedgerSink(),
    compaction:
      compactionMode === "disabled-then-halt"
        ? { mode: compactionMode }
        : {
            mode: compactionMode,
            summarizerModel,
            ...(options.allowCrossProviderSummarization === true && {
              allowCrossProviderSummarization: true,
            }),
          },
    routing: { profile, registry, defaultComplexity },
    defaults: { maxRounds, defaultComplexity },
    ...(options.projectStoreConfig !== undefined && {
      projectStoreConfig: options.projectStoreConfig,
    }),
  };
}
