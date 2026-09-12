import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import { assertCredentialPathOutsideProject, FileCredentialStore } from "../auth/credential-store";
import { type ContextBudgetPercents, deriveContextBudget } from "../context/budget";
import type { CompactionMode } from "../context/compactor";
import { assertSummarizerWindow } from "../context/compactor";
import { MemoryLedgerSink } from "../ledger/ledger";
import { SUBMIT_FOLLOW_UP_TOOL_NAME } from "../orchestration/follow-up";
import { DEFAULT_SURFACE_ANALYSIS_LIMITS, SUBMIT_PLAN_TOOL_NAME } from "../orchestration/plan";
import type {
  Complexity,
  PipelineConfig,
  RoleSpec,
  SurfaceAnalysisLimits,
} from "../orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../orchestration/verdict";
import { buildDefaultProfile } from "../profiles/default-profile";
import { resolveProfile } from "../profiles/resolve";
import type { Profile, ProfileRole, ResolvedSelection } from "../profiles/types";
import { parseProfile } from "../profiles/validate";
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
export type BudgetPercents = ContextBudgetPercents;
export type ConfigurableRole = "planner" | "security" | "coder" | "reviewer" | "orchestrator";

/** maxRounds default when the caller does not override it. */
const DEFAULT_MAX_ROUNDS = 2;
/** The complexity every pre-plan role and later fallback routes on by default. */
const DEFAULT_COMPLEXITY: Complexity = "medium";
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const CONFIGURABLE_ROLES: readonly ConfigurableRole[] = [
  "planner",
  "security",
  "coder",
  "reviewer",
  "orchestrator",
];

function validateRoleBudgetPercents(
  value: Partial<Record<ConfigurableRole, BudgetPercents>> | undefined,
): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("roleBudgetPercents must be an object");
  }
  for (const [role, percents] of Object.entries(value)) {
    if (!CONFIGURABLE_ROLES.includes(role as ConfigurableRole)) {
      throw new Error(`roleBudgetPercents contains unknown role ${role}`);
    }
    if (typeof percents !== "object" || percents === null || Array.isArray(percents)) {
      throw new Error(`roleBudgetPercents.${role} must be an object`);
    }
    deriveContextBudget(1000, percents);
  }
}

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
  /** Explicit operator-authored registry data; never discovered from targetDir. */
  registryConfig?: RegistryConfig;
  profile?: Profile;
  overrides?: Partial<Record<ProfileRole, import("../profiles/types").SpawnOverride>>;
  plannerModel?: string;
  securityModel?: string;
  coderModel?: string;
  reviewerModel?: string;
  orchestratorModel?: string;
  orchestratorThinkingLevel?: ThinkingLevel;
  compactionMode?: CompactionMode;
  summarizerModel?: string;
  allowCrossProviderSummarization?: boolean;
  maxRounds?: number;
  surfaceAnalysisLimits?: Partial<SurfaceAnalysisLimits>;
  defaultComplexity?: Complexity;
  budgetPercents?: BudgetPercents;
  roleBudgetPercents?: Partial<Record<ConfigurableRole, BudgetPercents>>;
  warn?: (message: string) => void;
  projectStoreConfig?: ProjectStoreConfig;
  /** Persistent provider credentials; defaults to the private user-local store. */
  credentials?: CredentialStore;
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
  "openai-codex": { preset: openaiCodexPreset, defaultModel: "codex-sol" },
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
  validateRoleBudgetPercents(options.roleBudgetPercents);
  const surfaceAnalysisLimits: SurfaceAnalysisLimits = {
    ...DEFAULT_SURFACE_ANALYSIS_LIMITS,
    ...options.surfaceAnalysisLimits,
  };
  for (const [name, value] of Object.entries(surfaceAnalysisLimits)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`surfaceAnalysisLimits.${name} must be a non-negative safe integer`);
  }
  if (options.registryConfig !== undefined && options.provider !== undefined) {
    throw new Error("provider cannot be combined with registryConfig");
  }
  const env = options.env ?? ((name: string) => process.env[name]);
  if (
    options.orchestratorThinkingLevel !== undefined &&
    !THINKING_LEVELS.includes(options.orchestratorThinkingLevel)
  ) {
    throw new Error(`orchestratorThinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  const warn = options.warn ?? ((message: string) => void process.stderr.write(message));

  const provider =
    options.registryConfig === undefined ? selectProvider(env, options.provider, warn) : undefined;
  const presetSelection = provider === undefined ? undefined : PROVIDER_PRESETS[provider];
  let registryConfig: RegistryConfig;
  if (options.registryConfig !== undefined) registryConfig = options.registryConfig;
  else if (presetSelection !== undefined)
    registryConfig = { providers: [presetSelection.preset()] };
  else throw new Error("provider preset could not be selected");
  const defaultModel =
    presetSelection?.defaultModel ?? registryConfig.providers[0]?.models[0]?.name;
  if (defaultModel === undefined) throw new Error("registryConfig must declare at least one model");

  const strong = options.strongModel ?? defaultModel;
  const mid = options.midModel ?? (provider === "openai-codex" ? "codex-terra" : defaultModel);
  const cheap = options.cheapModel ?? (provider === "openai-codex" ? "codex-luna" : defaultModel);
  const compactionMode = options.compactionMode ?? "auto";
  if (compactionMode === "cache-aware") {
    throw new Error('context compaction mode "cache-aware" is not supported yet');
  }
  if (compactionMode !== "auto" && compactionMode !== "disabled-then-halt") {
    throw new Error(`unknown context compaction mode "${String(compactionMode)}"`);
  }

  const credentials = options.credentials ?? new FileCredentialStore();
  if (credentials instanceof FileCredentialStore) {
    assertCredentialPathOutsideProject(credentials.path, options.targetDir);
  }
  const registry: ResolvedRegistry = resolveRegistry(registryConfig, {
    env,
    credentials,
  });
  for (const configuredProvider of registryConfig.providers) {
    const credentialName =
      configuredProvider.credential.kind === "env-var"
        ? configuredProvider.credential.envVar
        : "oauth";
    const firstModel = configuredProvider.models[0];
    if (firstModel === undefined) throw new Error("provider must declare a model");
    const resolvedModel = registry.getModel(firstModel.name);
    warn(
      `ad-coder: provider destination "${resolvedModel.provider}" host "${new URL(resolvedModel.baseUrl).host}" credential "${credentialName}"\n`,
    );
  }
  const defaultProfile = buildDefaultProfile({ strong, mid, cheap });
  const useCodexOAuthDefaults =
    provider === "openai-codex" &&
    options.profile === undefined &&
    options.strongModel === undefined &&
    options.midModel === undefined &&
    options.cheapModel === undefined;
  const profile: Profile = parseProfile(
    options.profile ??
      (useCodexOAuthDefaults
        ? {
            entries: defaultProfile.entries.map((entry) =>
              entry.role === "coder"
                ? { ...entry, model: "codex-sol", thinkingLevel: "medium" as ThinkingLevel }
                : entry,
            ),
          }
        : defaultProfile),
  );
  const defaultComplexity = options.defaultComplexity ?? DEFAULT_COMPLEXITY;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const summarizerModel =
    options.summarizerModel !== undefined
      ? registry.getModel(options.summarizerModel)
      : resolveProfile(
          profile,
          registry,
          "recorder",
          defaultComplexity,
          options.overrides?.recorder,
        ).model;

  const explicitModels: Partial<Record<ProfileRole, string>> = {
    ...(options.plannerModel !== undefined && { planner: options.plannerModel }),
    ...(options.securityModel !== undefined && { security: options.securityModel }),
    ...(options.coderModel !== undefined && { coder: options.coderModel }),
    ...(options.reviewerModel !== undefined && { reviewer: options.reviewerModel }),
  };
  const overrides = { ...options.overrides };
  for (const [role, model] of Object.entries(explicitModels)) {
    overrides[role as ProfileRole] = { model };
  }

  warn(
    `ad-coder: provider "${provider ?? "custom"}" | strong "${strong}" mid "${mid}" cheap "${cheap}"\n`,
  );

  const buildRole = (name: ProfileRole, tools: string[]): RoleSpec => {
    // The role's live model is whatever the default profile routes it to at
    // defaultComplexity; the budget is validated against that same model.
    const selection = resolveProfile(profile, registry, name, defaultComplexity, overrides[name]);
    const model = selection.model;
    const budget = deriveContextBudget(
      model.contextWindow,
      options.roleBudgetPercents?.[name as ConfigurableRole] ?? options.budgetPercents,
    );
    const role: Role = defineRole(
      {
        name,
        provider: model.provider,
        modelId: model.id,
        systemPrompt: resolvePrompt(name, { projectDir: options.targetDir }),
        activeToolNames: tools,
        cacheRetention: "short",
        contextBudget: budget,
        ...(selection.thinkingLevel !== undefined && { thinkingLevel: selection.thinkingLevel }),
      },
      model,
    );
    return { role, model };
  };

  const roles = {
    planner: buildRole("planner", [
      "read",
      "bash",
      SUBMIT_PLAN_TOOL_NAME,
      SUBMIT_FOLLOW_UP_TOOL_NAME,
    ]),
    security: buildRole("security", ["read", "bash", SUBMIT_FOLLOW_UP_TOOL_NAME]),
    coder: buildRole("coder", ["read", "write", "edit", "bash", SUBMIT_FOLLOW_UP_TOOL_NAME]),
    reviewer: buildRole("reviewer", [
      "read",
      "bash",
      SUBMIT_VERDICT_TOOL_NAME,
      SUBMIT_FOLLOW_UP_TOOL_NAME,
    ]),
  };

  const orchestratorSelection: ResolvedSelection =
    options.orchestratorModel !== undefined
      ? { model: registry.getModel(options.orchestratorModel) }
      : useCodexOAuthDefaults
        ? { model: registry.getModel("codex-sol"), thinkingLevel: "low" }
        : resolveProfile(profile, registry, "coder", defaultComplexity, overrides.coder);
  const orchestrator = buildNamedRole(
    "orchestrator",
    orchestratorSelection.model,
    ["read", "bash"],
    options.orchestratorThinkingLevel ?? orchestratorSelection.thinkingLevel,
  );

  if (compactionMode !== "disabled-then-halt") {
    const reachable = profile.entries
      .filter((entry) => entry.role !== "recorder")
      .map((entry) => registry.getModel(entry.model));
    for (const [role, override] of Object.entries(overrides)) {
      if (role !== "recorder" && override !== undefined)
        reachable.push(registry.getModel(override.model));
    }
    reachable.push(orchestratorSelection.model);
    assertSummarizerWindow(summarizerModel, reachable);
  }

  function buildNamedRole(
    name: ConfigurableRole,
    model: Model<Api>,
    tools: string[],
    thinkingLevel?: ThinkingLevel,
  ): RoleSpec {
    const budget = deriveContextBudget(
      model.contextWindow,
      options.roleBudgetPercents?.[name] ?? options.budgetPercents,
    );
    return {
      model,
      role: defineRole(
        {
          name,
          provider: model.provider,
          modelId: model.id,
          systemPrompt: resolvePrompt(name, { projectDir: options.targetDir }),
          activeToolNames: tools,
          cacheRetention: "short",
          contextBudget: budget,
          ...(thinkingLevel !== undefined && { thinkingLevel }),
        },
        model,
      ),
    };
  }

  return {
    targetDir: options.targetDir,
    models: registry.models,
    task: options.task,
    maxRounds,
    surfaceAnalysisLimits,
    roles: { ...roles, orchestrator },
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
    routing: {
      profile,
      registry,
      defaultComplexity,
      ...(Object.keys(overrides).length > 0 && { overrides }),
      budgetPercents: {
        planner: options.roleBudgetPercents?.planner ?? options.budgetPercents ?? {},
        security: options.roleBudgetPercents?.security ?? options.budgetPercents ?? {},
        coder: options.roleBudgetPercents?.coder ?? options.budgetPercents ?? {},
        reviewer: options.roleBudgetPercents?.reviewer ?? options.budgetPercents ?? {},
      },
    },
    defaults: { maxRounds, defaultComplexity },
    effectiveConfig: {
      provider: {
        value: provider ?? "custom",
        source:
          options.provider !== undefined
            ? "cli"
            : PROVIDER_BY_ENV.some(({ envVar }) => env(envVar) !== undefined)
              ? "environment"
              : "registry-default",
      },
      strongModel: {
        value: strong,
        source: options.strongModel !== undefined ? "cli" : "registry-default",
      },
      midModel: { value: mid, source: options.midModel !== undefined ? "cli" : "registry-default" },
      cheapModel: {
        value: cheap,
        source: options.cheapModel !== undefined ? "cli" : "registry-default",
      },
      maxRounds: {
        value: maxRounds,
        source: options.maxRounds !== undefined ? "cli" : "built-in-default",
      },
      defaultComplexity: {
        value: defaultComplexity,
        source: options.defaultComplexity !== undefined ? "cli" : "built-in-default",
      },
      compactionMode: {
        value: compactionMode,
        source: options.compactionMode !== undefined ? "cli" : "built-in-default",
      },
      ...Object.fromEntries(
        Object.entries(surfaceAnalysisLimits).map(([name, value]) => [
          `surfaceAnalysisLimits.${name}`,
          {
            value,
            source:
              options.surfaceAnalysisLimits?.[name as keyof SurfaceAnalysisLimits] !== undefined
                ? "cli"
                : "built-in-default",
          },
        ]),
      ),
    },
    ...(options.projectStoreConfig !== undefined && {
      projectStoreConfig: options.projectStoreConfig,
    }),
  };
}
