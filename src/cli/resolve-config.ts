import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, CacheRetention, CredentialStore, Model } from "@earendil-works/pi-ai";
import { assertCredentialPathOutsideProject, FileCredentialStore } from "../auth/credential-store";
import { type ContextBudgetPercents, deriveContextBudget } from "../context/budget";
import type { CompactionMode } from "../context/compactor";
import { assertSummarizerWindow } from "../context/compactor";
import { CostAnomalyDetector, FileCostAnomalyStore } from "../economics/cost-anomaly";
import { resolveModelInventory } from "../inventory/resolve";
import type { ModelInventoryConfig } from "../inventory/types";
import { MemoryLedgerSink } from "../ledger/ledger";
import type {
  ToolActivityChannel,
  ToolActivityConfig,
  ToolActivityConsumer,
} from "../observability/tool-activity";
import { SUBMIT_FOLLOW_UP_TOOL_NAME } from "../orchestration/follow-up";
import { DEFAULT_SURFACE_ANALYSIS_LIMITS, SUBMIT_PLAN_TOOL_NAME } from "../orchestration/plan";
import { StageLimitController, type StageLimits } from "../orchestration/stage-limits";
import type {
  Complexity,
  PipelineConfig,
  PipelineContextConfig,
  PipelineContextMode,
  RoleSpec,
  SurfaceAnalysisLimits,
} from "../orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../orchestration/verdict";
import { buildDefaultProfile } from "../profiles/default-profile";
import { ProfileError } from "../profiles/errors";
import { resolveProfile } from "../profiles/resolve";
import type { Profile, ProfileRole, ResolvedSelection } from "../profiles/types";
import { PROFILE_ROLES, parseProfile } from "../profiles/validate";
import { readProjectCalibrationSnapshot } from "../project-calibration";
import type { ProjectStoreConfig } from "../project-store/types";
import { buildExploreProjectTool, EXPLORE_PROJECT_TOOL_NAME } from "../project-tools/explore";
import { buildReadProjectTool, READ_PROJECT_TOOL_NAME } from "../project-tools/read";
import { buildSearchProjectTool, SEARCH_PROJECT_TOOL_NAME } from "../project-tools/search";
import { resolvePrompt } from "../prompts/prompts";
import type { ResearchPurpose, RoleBriefSource } from "../prompts/role-briefs";
import { deepseekPreset, openaiCodexPreset, openrouterPreset } from "../registry/presets";
import { resolveRegistry } from "../registry/resolve";
import type {
  ProviderConfig,
  RegistryConfig,
  ResolvedRegistry,
  ResolvedRegistryConfig,
} from "../registry/types";
import { parseRegistryConfig } from "../registry/validate";
import type { Role } from "../role";
import { defineRole } from "../role";
import type { Tool } from "../runner/tool";
import { LOAD_SKILL_TOOL_NAME, roleSkillKit } from "../skills/role-kit";
import { buildImageInspectionTool, buildWebTools } from "../web/tools";

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
export type ConfigurableRole =
  | "planner"
  | "researcher"
  | "security"
  | "coder"
  | "reviewer"
  | "auditor"
  | "orchestrator";
export type BuiltInPluginName = "explore" | "web" | "vision";

const DEFAULT_STAGE_LIMITS: Required<StageLimits> = {
  maxDurationMs: 600_000,
  maxModelTurns: 32,
  maxToolTurns: 128,
  maxInputTokens: 500_000,
  maxCostUsd: 2,
  finalResponseReserveModelTurns: 4,
  finalResponseReserveDurationMs: 30_000,
  finalResponseReserveToolTurns: 8,
  finalResponseReserveInputTokens: 100_000,
};

/** Efficient role ceilings inferred from committed dogfood evidence; overrides remain data-only. */
const DEFAULT_ROLE_STAGE_LIMITS: Readonly<Partial<Record<ProfileRole, StageLimits>>> = {
  planner: {
    maxDurationMs: 180_000,
    maxModelTurns: 10,
    maxToolTurns: 20,
    maxInputTokens: 250_000,
    maxCostUsd: 0.1,
  },
  researcher: {
    maxDurationMs: 240_000,
    maxModelTurns: 14,
    maxToolTurns: 32,
    maxInputTokens: 300_000,
    maxCostUsd: 0.25,
  },
  security: {
    maxDurationMs: 180_000,
    maxModelTurns: 10,
    maxToolTurns: 20,
    maxInputTokens: 200_000,
    maxCostUsd: 0.15,
  },
  coder: {
    maxDurationMs: 480_000,
    maxModelTurns: 20,
    maxToolTurns: 48,
    maxInputTokens: 400_000,
    maxCostUsd: 0.8,
  },
  reviewer: {
    maxDurationMs: 300_000,
    maxModelTurns: 16,
    maxToolTurns: 40,
    maxInputTokens: 350_000,
    maxCostUsd: 0.5,
  },
  auditor: {
    maxDurationMs: 300_000,
    maxModelTurns: 16,
    maxToolTurns: 40,
    maxInputTokens: 350_000,
    maxCostUsd: 0.5,
  },
};

/** maxRounds default when the caller does not override it. */
const DEFAULT_MAX_ROUNDS = 2;
export const DEFAULT_PIPELINE_CONTEXT_CONFIG = {
  mode: "incremental",
  maxFocusedDiffBytes: 64 * 1024,
  projection: { maxPaths: 128, maxPathBytes: 1024, maxAggregateBytes: 32 * 1024 },
} as const satisfies PipelineContextConfig;
/** The complexity every pre-plan role and later fallback routes on by default. */
const DEFAULT_COMPLEXITY: Complexity = "medium";
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
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
  "researcher",
  "security",
  "coder",
  "reviewer",
  "auditor",
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
  inventoryConfig?: ModelInventoryConfig;
  inventoryProfile?: string;
  /** Read a matching committed .ad-coder/calibration.json routing override. Defaults to true. */
  useProjectCalibration?: boolean;
  overrides?: Partial<Record<ProfileRole, import("../profiles/types").SpawnOverride>>;
  plannerModel?: string;
  researcherModel?: string;
  securityModel?: string;
  coderModel?: string;
  reviewerModel?: string;
  auditorModel?: string;
  orchestratorModel?: string;
  /** Image-capable registered model used when a text-only role calls inspect_image. */
  visionModel?: string;
  orchestratorThinkingLevel?: ThinkingLevel;
  requestTimeoutMs?: number;
  stageLimits?: StageLimits;
  /** Optional role-specific overlays, resolved over global stageLimits. */
  roleStageLimits?: Partial<Record<ProfileRole, StageLimits>>;
  compactionMode?: CompactionMode;
  pipelineContextMode?: PipelineContextMode;
  /** Zero disables only the material-diff escalation trigger. */
  pipelineContextMaxDiffBytes?: number;
  pipelineContextMaxPaths?: number;
  pipelineContextMaxPathBytes?: number;
  pipelineContextMaxAggregateBytes?: number;
  summarizerModel?: string;
  allowCrossProviderSummarization?: boolean;
  maxRounds?: number;
  surfaceAnalysisLimits?: Partial<SurfaceAnalysisLimits>;
  defaultComplexity?: Complexity;
  plannerHandoffAttempts?: 1 | 2;
  budgetPercents?: BudgetPercents;
  roleBudgetPercents?: Partial<Record<ConfigurableRole, BudgetPercents>>;
  warn?: (message: string) => void;
  projectStoreConfig?: ProjectStoreConfig;
  /** Persistent provider credentials; defaults to the private user-local store. */
  credentials?: CredentialStore;
  /** Replace every built-in plugin tool; pass an empty array to disable plugins. */
  pluginTools?: Tool[];
  /** Select built-in plugin groups; defaults to all three. Mutually exclusive with pluginTools. */
  enabledPlugins?: readonly BuiltInPluginName[];
  activityChannel?: ToolActivityChannel;
  activityConsumer?: ToolActivityConsumer;
  toolActivity?: Partial<ToolActivityConfig>;
  /** Monotonic milliseconds seam for deterministic stage metrics. */
  monotonicNow?: () => number;
  /** Explicit model-inventory operation that receives the shipped Researcher brief. */
  researchPurpose?: ResearchPurpose;
  /** Trusted simple skill selection for every role prompt; absent means the catalogue. */
  selectedSkills?: readonly string[] | undefined;
  /** Trusted replacement source for the versioned model-inventory Researcher brief. */
  researchBrief?: RoleBriefSource;
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
 * the built-in worker roles from their prompts.
 *
 * CREDENTIAL BOUNDARY. Keys resolve ONLY through the injected `env` accessor,
 * handed straight to `resolveRegistry({ env })`. A selected env-var provider
 * whose key is unset throws `RegistryError('missing_credential', <VAR-NAME>)`
 * (name only) from `resolveRegistry`; this function does NOT catch or reformat
 * it. The codex fallback is OAuth-only and never throws `missing_credential`.
 */
function resolveConfig(
  options: ResolvePipelineConfigOptions,
  orchestratorOnly: boolean,
): PipelineConfig {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 0)
    throw new Error("requestTimeoutMs must be a non-negative safe integer");
  const stageLimits: Required<StageLimits> = { ...DEFAULT_STAGE_LIMITS, ...options.stageLimits };
  new StageLimitController(stageLimits);
  const roleNames = new Set([
    ...Object.keys(DEFAULT_ROLE_STAGE_LIMITS),
    ...Object.keys(options.roleStageLimits ?? {}),
  ]);
  const roleStageLimits = Object.fromEntries(
    [...roleNames].map((role) => {
      const profileRole = role as ProfileRole;
      const resolved = {
        ...DEFAULT_STAGE_LIMITS,
        ...DEFAULT_ROLE_STAGE_LIMITS[profileRole],
        ...options.stageLimits,
        ...options.roleStageLimits?.[profileRole],
      };
      new StageLimitController(resolved);
      return [role, resolved];
    }),
  ) as Partial<Record<ProfileRole, Required<StageLimits>>>;
  if (options.pluginTools !== undefined && options.enabledPlugins !== undefined)
    throw new Error("pluginTools cannot be combined with enabledPlugins");
  const enabledPlugins = options.enabledPlugins ?? ["explore", "web", "vision"];
  for (const name of enabledPlugins) {
    if (name !== "explore" && name !== "web" && name !== "vision")
      throw new Error(`unknown built-in plugin "${String(name)}"`);
  }
  if (new Set(enabledPlugins).size !== enabledPlugins.length)
    throw new Error("enabledPlugins must not contain duplicates");
  validateRoleBudgetPercents(options.roleBudgetPercents);
  if (
    options.researchPurpose !== undefined &&
    options.researchPurpose !== "model-inventory-bootstrap" &&
    options.researchPurpose !== "model-inventory-refresh"
  ) {
    throw new Error(`unsupported research purpose: ${String(options.researchPurpose)}`);
  }
  if (options.researchBrief !== undefined && options.researchPurpose === undefined)
    throw new Error("researchBrief requires an explicit researchPurpose");
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
  if (
    options.inventoryConfig !== undefined &&
    [
      options.registryConfig,
      options.profile,
      options.provider,
      options.strongModel,
      options.midModel,
      options.cheapModel,
      options.plannerModel,
      options.researcherModel,
      options.securityModel,
      options.coderModel,
      options.reviewerModel,
      options.auditorModel,
      options.orchestratorModel,
      options.summarizerModel,
      options.visionModel,
      options.overrides,
    ].some((value) => value !== undefined)
  ) {
    throw new Error(
      "inventoryConfig cannot be combined with independent provider, profile, or model overrides",
    );
  }
  if (options.inventoryProfile !== undefined && options.inventoryConfig === undefined)
    throw new Error("inventoryProfile requires inventoryConfig");
  const env = options.env ?? ((name: string) => process.env[name]);
  if (
    options.orchestratorThinkingLevel !== undefined &&
    !THINKING_LEVELS.includes(options.orchestratorThinkingLevel)
  ) {
    throw new Error(`orchestratorThinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  const warn = options.warn ?? ((message: string) => void process.stderr.write(message));

  const credentials = options.credentials ?? new FileCredentialStore();
  if (credentials instanceof FileCredentialStore) {
    assertCredentialPathOutsideProject(credentials.path, options.targetDir);
  }
  const inventory =
    options.inventoryConfig === undefined
      ? undefined
      : resolveModelInventory(options.inventoryConfig, options.inventoryProfile, {
          env,
          credentials,
        });
  const provider =
    options.registryConfig === undefined && inventory === undefined
      ? selectProvider(env, options.provider, warn)
      : undefined;
  const presetSelection = provider === undefined ? undefined : PROVIDER_PRESETS[provider];
  let authoredRegistry: RegistryConfig;
  if (inventory !== undefined)
    authoredRegistry = options.inventoryConfig?.profiles.find(
      (entry) => entry.name === inventory.name,
    )?.registry as RegistryConfig;
  else if (options.registryConfig !== undefined) authoredRegistry = options.registryConfig;
  else if (presetSelection !== undefined)
    authoredRegistry = { providers: [presetSelection.preset()] };
  else throw new Error("provider preset could not be selected");
  // Validate here too, not only inside resolveRegistry: the default-model pick
  // and the destination warning below both read model facts, and under a
  // provider `catalog` those facts exist only after validation fills them in.
  const registryConfig: ResolvedRegistryConfig = parseRegistryConfig(authoredRegistry);
  const defaultModel =
    presetSelection?.defaultModel ?? registryConfig.providers[0]?.models[0]?.name;
  if (defaultModel === undefined) throw new Error("registryConfig must declare at least one model");

  const strong = options.strongModel ?? defaultModel;
  const mid = options.midModel ?? (provider === "openai-codex" ? "codex-terra" : defaultModel);
  const cheap = options.cheapModel ?? (provider === "openai-codex" ? "codex-luna" : defaultModel);
  const compactionMode = options.compactionMode ?? "auto";
  const pipelineContextMode = options.pipelineContextMode ?? DEFAULT_PIPELINE_CONTEXT_CONFIG.mode;
  if (!(["incremental", "full", "off"] as const).includes(pipelineContextMode)) {
    throw new Error(`unknown pipeline context mode "${String(pipelineContextMode)}"`);
  }
  const pipelineContextMaxDiffBytes =
    options.pipelineContextMaxDiffBytes ?? DEFAULT_PIPELINE_CONTEXT_CONFIG.maxFocusedDiffBytes;
  if (!Number.isSafeInteger(pipelineContextMaxDiffBytes) || pipelineContextMaxDiffBytes < 0) {
    throw new Error("pipelineContextMaxDiffBytes must be a non-negative safe integer");
  }
  const projectionValues = {
    maxPaths:
      options.pipelineContextMaxPaths ?? DEFAULT_PIPELINE_CONTEXT_CONFIG.projection.maxPaths,
    maxPathBytes:
      options.pipelineContextMaxPathBytes ??
      DEFAULT_PIPELINE_CONTEXT_CONFIG.projection.maxPathBytes,
    maxAggregateBytes:
      options.pipelineContextMaxAggregateBytes ??
      DEFAULT_PIPELINE_CONTEXT_CONFIG.projection.maxAggregateBytes,
  };
  for (const [name, value] of Object.entries(projectionValues)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`pipelineContext.${name} must be a positive safe integer`);
  }
  if (compactionMode === "cache-aware") {
    throw new Error('context compaction mode "cache-aware" is not supported yet');
  }
  if (compactionMode !== "auto" && compactionMode !== "disabled-then-halt") {
    throw new Error(`unknown context compaction mode "${String(compactionMode)}"`);
  }

  const registry: ResolvedRegistry =
    inventory?.registry ?? resolveRegistry(registryConfig, { env, credentials });
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
  const projectCalibration =
    options.useProjectCalibration === false ||
    inventory === undefined ||
    options.profile !== undefined
      ? undefined
      : readProjectCalibrationSnapshot(options.targetDir);
  const projectProfile =
    projectCalibration !== undefined &&
    inventory !== undefined &&
    projectCalibration.inventory.name === inventory.name
      ? projectCalibration.routing
      : undefined;
  const useCodexOAuthDefaults =
    provider === "openai-codex" &&
    options.profile === undefined &&
    options.strongModel === undefined &&
    options.midModel === undefined &&
    options.cheapModel === undefined;
  const profile: Profile = parseProfile(
    projectProfile ??
      inventory?.profile ??
      options.profile ??
      (useCodexOAuthDefaults
        ? {
            // The Codex OAuth defaults live IN the profile, for the coder and
            // the orchestrator alike. Expressing the orchestrator default as a
            // second special case at the selection site is what let the banner
            // and the run disagree: the banner resolved the cell (mid tier,
            // Terra) while the build hardcoded Sol, so the operator checked a
            // routing the run did not take.
            entries: defaultProfile.entries.map((entry) => {
              if (entry.role === "coder")
                return { ...entry, model: "codex-sol", thinkingLevel: "medium" as ThinkingLevel };
              if (entry.role === "orchestrator")
                return { ...entry, model: "codex-sol", thinkingLevel: "low" as ThinkingLevel };
              return entry;
            }),
          }
        : defaultProfile),
  );
  const defaultComplexity = options.defaultComplexity ?? DEFAULT_COMPLEXITY;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const explicitModels: Partial<Record<ProfileRole, string>> = {
    ...(options.orchestratorModel !== undefined && { orchestrator: options.orchestratorModel }),
    ...(options.plannerModel !== undefined && { planner: options.plannerModel }),
    ...(options.researcherModel !== undefined && { researcher: options.researcherModel }),
    ...(options.securityModel !== undefined && { security: options.securityModel }),
    ...(options.coderModel !== undefined && { coder: options.coderModel }),
    ...(options.reviewerModel !== undefined && { reviewer: options.reviewerModel }),
    ...(options.auditorModel !== undefined && { auditor: options.auditorModel }),
    // `--summarizer-model` is the summarizer's per-run override, spelled
    // differently for history but doing what every other `--<role>-model` flag
    // does. Routing it through `overrides` rather than resolving it separately
    // is what keeps the banner honest: the banner prints whatever `resolveRole`
    // returns, so a summarizer resolved beside that path printed the profile
    // cell while the run used the flag.
    ...(options.summarizerModel !== undefined && { summarizer: options.summarizerModel }),
  };
  const overrides = { ...options.overrides };
  for (const [role, model] of Object.entries(explicitModels)) {
    overrides[role as ProfileRole] = { model };
  }

  // Every role resolves through here, so the banner reports exactly the route
  // the run will take.
  //
  // `orchestrator` gained a profile cell of its own so a profile can name its
  // model per complexity and a calibration run can attribute its cost apart
  // from the work it delegates; before that it silently read the coder's cell,
  // which made every measurement of the orchestrator a measurement of the
  // coder. Profiles authored before the cell existed have no orchestrator
  // entry, and a hand-written inventory is operator configuration we do not get
  // to invalidate -- so a MISSING orchestrator cell falls back to the coder
  // route it used to take, once and audibly. Only that one gap is absorbed:
  // every other profile error, and every other role, still raises.
  let orchestratorFallbackWarned = false;
  const resolveRole = (role: ProfileRole): ResolvedSelection => {
    try {
      return resolveProfile(profile, registry, role, defaultComplexity, overrides[role]);
    } catch (error) {
      if (
        role !== "orchestrator" ||
        !(error instanceof ProfileError) ||
        error.code !== "missing_mapping"
      ) {
        throw error;
      }
      if (!orchestratorFallbackWarned) {
        orchestratorFallbackWarned = true;
        warn(
          "ad-coder: profile declares no orchestrator cell; routing it through the coder cell as before\n",
        );
      }
      return resolveProfile(profile, registry, "coder", defaultComplexity, overrides.coder);
    }
  };

  const summarizerModel = resolveRole("summarizer").model;

  // What the run will ACTUALLY do, not the three tiers the default profile is
  // built from: under an inventory those tiers all collapse onto one default
  // model, so the old banner printed `strong "x" mid "x" cheap "x"` for a
  // profile routing every role across several models -- true of nothing.
  // Roles are grouped by the model they resolve to at the default complexity,
  // which is the routing decision an operator checks before letting a run go.
  const layout = new Map<string, ProfileRole[]>();
  for (const role of PROFILE_ROLES) {
    let modelName: string;
    try {
      modelName = resolveRole(role).model.name;
    } catch {
      // A role the profile does not map at this complexity is reported as
      // unrouted rather than crashing the banner: the run may never reach it,
      // and if it does, the resolver raises the real typed error there.
      modelName = "unrouted";
    }
    const roles = layout.get(modelName);
    if (roles === undefined) layout.set(modelName, [role]);
    else roles.push(role);
  }
  const source =
    inventory !== undefined
      ? `inventory "${inventory.name}"`
      : `provider "${provider ?? "custom"}"`;
  const routing = [...layout]
    .map(([modelName, roles]) => `${modelName}: ${roles.join(", ")}`)
    .join(" | ");
  warn(`ad-coder: ${source} | complexity "${defaultComplexity}" | ${routing}\n`);

  const buildRole = (name: ProfileRole, tools: string[]): RoleSpec => {
    // The role's live model is whatever the default profile routes it to at
    // defaultComplexity; the budget is validated against that same model.
    const selection = resolveRole(name);
    const model = selection.model;
    const budget = deriveContextBudget(
      model.contextWindow,
      options.roleBudgetPercents?.[name as ConfigurableRole] ?? options.budgetPercents,
    );
    // Same skill surface every front uses: the role's own kit (pin or
    // catalogue) rides on its resolved prompt. An invalid pin fails HERE,
    // before any provider dispatch.
    const kit = roleSkillKit({
      role: name,
      selectedSkills: options.selectedSkills,
      projectDir: options.targetDir,
    });
    const activeTools =
      kit.includeLoadTool && !tools.includes(LOAD_SKILL_TOOL_NAME)
        ? [...tools, LOAD_SKILL_TOOL_NAME]
        : tools;
    const rolePrompt = resolvePrompt(name, { projectDir: options.targetDir });
    // An empty target-local prompt override must still fail exactly as it did
    // before a skill appendix existed: a catalogue row is not a role prompt.
    if (rolePrompt === "")
      throw new Error(`defineRole(${name}): systemPrompt must be a non-empty string`);
    const role: Role = defineRole(
      {
        name,
        provider: model.provider,
        modelId: model.id,
        systemPrompt: `${rolePrompt}${kit.appendix}`,
        activeToolNames: activeTools,
        // The profile's value when it states one, "short" otherwise. This is
        // the sink `ResolvedSelection.cacheRetention` was surfaced for: without
        // it a declared "long"/"none" parsed, validated, and was then silently
        // discarded here, so the config said one thing and every request did
        // another.
        cacheRetention: selection.cacheRetention ?? "short",
        contextBudget: budget,
        ...(selection.thinkingLevel !== undefined && { thinkingLevel: selection.thinkingLevel }),
        requestTimeoutMs,
      },
      model,
    );
    return { role, model };
  };

  // One source for the orchestrator's route, shared with the banner. The Codex
  // OAuth default is carried by the profile above rather than re-decided here.
  const orchestratorSelection: ResolvedSelection =
    options.orchestratorModel !== undefined
      ? { model: registry.getModel(options.orchestratorModel) }
      : resolveRole("orchestrator");
  const visionModel =
    options.visionModel !== undefined ? registry.getModel(options.visionModel) : undefined;
  if (visionModel !== undefined && !visionModel.input.includes("image")) {
    throw new Error(`visionModel "${options.visionModel}" does not support image input`);
  }
  const commonBuiltInTools = [
    ...(enabledPlugins.includes("explore")
      ? [
          buildExploreProjectTool(options.targetDir),
          buildSearchProjectTool(options.targetDir),
          buildReadProjectTool(options.targetDir),
        ]
      : []),
    ...(enabledPlugins.includes("web") ? buildWebTools() : []),
  ];
  const pluginToolsForModel =
    options.pluginTools === undefined
      ? (activeModel: Model<Api>): Tool[] => [
          ...commonBuiltInTools,
          ...(enabledPlugins.includes("vision")
            ? [
                buildImageInspectionTool({
                  targetDir: options.targetDir,
                  models: registry.models,
                  activeModel,
                  ...(visionModel !== undefined && { visionModel }),
                }),
              ]
            : []),
        ]
      : undefined;
  const pluginTools =
    options.pluginTools ?? pluginToolsForModel?.(orchestratorSelection.model) ?? [];
  const orchestrator = buildNamedRole(
    "orchestrator",
    orchestratorSelection.model,
    ["read", "bash"],
    options.orchestratorThinkingLevel ?? orchestratorSelection.thinkingLevel,
    orchestratorSelection.cacheRetention,
  );
  const registeredPluginNames = new Set(pluginTools.map(({ name }) => name));
  const projectToolNames =
    options.pluginTools === undefined
      ? [EXPLORE_PROJECT_TOOL_NAME, SEARCH_PROJECT_TOOL_NAME, READ_PROJECT_TOOL_NAME].filter(
          (name) => registeredPluginNames.has(name),
        )
      : [];
  const webToolNames =
    options.pluginTools === undefined
      ? ["web_search", "web_read"].filter((name) => registeredPluginNames.has(name))
      : [];
  const pipelineRoles = orchestratorOnly
    ? undefined
    : {
        planner: buildRole("planner", [
          "read",
          ...projectToolNames,
          SUBMIT_PLAN_TOOL_NAME,
          SUBMIT_FOLLOW_UP_TOOL_NAME,
        ]),
        researcher: buildRole("researcher", [
          "read",
          "bash",
          ...projectToolNames,
          ...webToolNames,
          SUBMIT_FOLLOW_UP_TOOL_NAME,
        ]),
        security: buildRole("security", [
          "read",
          "bash",
          ...projectToolNames,
          SUBMIT_FOLLOW_UP_TOOL_NAME,
        ]),
        coder: buildRole("coder", [
          "read",
          "write",
          "edit",
          "bash",
          ...projectToolNames.filter((name) => name !== EXPLORE_PROJECT_TOOL_NAME),
          SUBMIT_FOLLOW_UP_TOOL_NAME,
        ]),
        reviewer: buildRole("reviewer", [
          "read",
          "bash",
          ...projectToolNames,
          SUBMIT_VERDICT_TOOL_NAME,
          SUBMIT_FOLLOW_UP_TOOL_NAME,
        ]),
        auditor: buildRole("auditor", [
          "read",
          "bash",
          ...projectToolNames,
          ...webToolNames,
          SUBMIT_FOLLOW_UP_TOOL_NAME,
        ]),
      };

  if (compactionMode !== "disabled-then-halt") {
    const reachable = [orchestratorSelection.model];
    if (!orchestratorOnly) {
      reachable.push(
        ...profile.entries
          .filter((entry) => entry.role !== "summarizer")
          .map((entry) => registry.getModel(entry.model)),
      );
      for (const [role, override] of Object.entries(overrides)) {
        if (role !== "summarizer" && override !== undefined)
          reachable.push(registry.getModel(override.model));
      }
    }
    assertSummarizerWindow(summarizerModel, reachable);
  }

  function buildNamedRole(
    name: ConfigurableRole,
    model: Model<Api>,
    tools: string[],
    thinkingLevel?: ThinkingLevel,
    cacheRetention?: CacheRetention,
  ): RoleSpec {
    const budget = deriveContextBudget(
      model.contextWindow,
      options.roleBudgetPercents?.[name] ?? options.budgetPercents,
    );
    // Same kit as every other role definition: the pinned skills or the
    // catalogue ride on the resolved prompt, everywhere this role is built.
    const kit = roleSkillKit({
      role: name,
      selectedSkills: options.selectedSkills,
      projectDir: options.targetDir,
    });
    const activeTools =
      kit.includeLoadTool && !tools.includes(LOAD_SKILL_TOOL_NAME)
        ? [...tools, LOAD_SKILL_TOOL_NAME]
        : tools;
    const rolePrompt = resolvePrompt(name, { projectDir: options.targetDir });
    if (rolePrompt === "")
      throw new Error(`defineRole(${name}): systemPrompt must be a non-empty string`);
    return {
      model,
      role: defineRole(
        {
          name,
          provider: model.provider,
          modelId: model.id,
          systemPrompt: `${rolePrompt}${kit.appendix}`,
          activeToolNames: activeTools,
          // Same sink as the routed roles above: a profile that states a
          // retention must reach the request, not be dropped on the floor.
          cacheRetention: cacheRetention ?? "short",
          contextBudget: budget,
          ...(thinkingLevel !== undefined && { thinkingLevel }),
          requestTimeoutMs,
        },
        model,
      ),
    };
  }

  const roles =
    pipelineRoles === undefined
      ? { coder: orchestrator, reviewer: orchestrator, orchestrator }
      : { ...pipelineRoles, orchestrator };

  /**
   * Provider-native model id -> how that model's context window was settled.
   *
   * Built from the VALIDATED registry config rather than the live pi `Model`,
   * because the pi model carries the resolved number and nothing about where it
   * came from -- and "where it came from" is the whole point of the projection.
   *
   * KEYED ON `modelId`, NOT `name`. A role holds a live `Model<Api>`, whose
   * `id` is the provider-native id; the registry-scoped `name` is a lookup key
   * that never leaves the registry. When two entries share a native id but
   * settle to different windows -- or settle the same window differently --
   * the entry is dropped rather than guessed at: an unlabelled number is
   * better than a confidently wrong label.
   */
  const windowProvenance = new Map<
    string,
    { window: number; source: string; catalog?: number } | undefined
  >();
  for (const entry of registryConfig.providers) {
    for (const model of entry.models) {
      const settled = {
        window: model.contextWindow,
        source: model.contextWindowSource,
        ...(model.catalogContextWindow !== undefined && { catalog: model.catalogContextWindow }),
      };
      const seen = windowProvenance.get(model.modelId);
      if (windowProvenance.has(model.modelId)) {
        // The WINDOW is part of what makes two entries the same, not just the
        // source label. Two hand-declared entries sharing a native id under
        // different windows are both `declared` with no catalog number, so
        // comparing labels alone called the real collision a match and let
        // whichever was registered first answer for both -- a specific,
        // confident, arbitrary number, which is worse than the unlabelled
        // fallback this branch exists to produce.
        if (
          seen?.window !== settled.window ||
          seen?.source !== settled.source ||
          seen?.catalog !== settled.catalog
        )
          windowProvenance.set(model.modelId, undefined);
        continue;
      }
      windowProvenance.set(model.modelId, settled);
    }
  }

  /**
   * Project the context window each role will ACTUALLY use, and why.
   *
   * WHY THIS EXISTS. `config show` reported every other routing decision but
   * not this one, and the effective window is the one number an operator sizes
   * a task against. It is also the number most likely to differ from what they
   * declared: a catalog model publishing 1M is clamped to the shared operating
   * ceiling, so a config that reads `1000000` silently runs at 200000 with no
   * way to see it. Naming the source -- and, on a clamp, the window that was
   * given up -- is what makes the number explainable rather than merely
   * present.
   *
   * `maxTokens` is projected beside it because the window is not the ceiling a
   * turn actually gets: `deriveContextBudget` takes a percentage of it, and
   * that derived number is what the compactor enforces.
   */
  const contextWindowProjection = Object.fromEntries(
    Object.entries(roles).flatMap(([name, spec]) => {
      const provenance = windowProvenance.get(spec.model.id);
      const origin = provenance?.source ?? "registry";
      const clamped =
        provenance?.catalog !== undefined ? `${origin} from ${provenance.catalog}` : origin;
      return [
        [`contextWindow.${name}`, { value: spec.model.contextWindow, source: clamped }],
        [
          `contextBudgetMaxTokens.${name}`,
          { value: spec.role.contextBudget.maxTokens, source: "derived" },
        ],
      ];
    }),
  );

  return {
    targetDir: options.targetDir,
    models: registry.models,
    task: options.task,
    // Constructed here, for every run resolved through the CLI, because the
    // contract makes detection default-on: a detector nobody builds protects
    // nobody. Its state is per-project and on disk, so a block raised by an
    // unattended run is still standing -- and still liftable by `cost release`
    // -- when the next invocation starts.
    costAnomalyDetector: new CostAnomalyDetector({}, new FileCostAnomalyStore(options.targetDir)),
    maxRounds,
    pluginTools,
    ...(pluginToolsForModel !== undefined && { pluginToolsForModel }),
    surfaceAnalysisLimits,
    ...(options.activityChannel !== undefined && { activityChannel: options.activityChannel }),
    ...(options.activityConsumer !== undefined && { activityConsumer: options.activityConsumer }),
    ...(options.toolActivity !== undefined && { toolActivity: options.toolActivity }),
    ...(options.monotonicNow !== undefined && { monotonicNow: options.monotonicNow }),
    ...(options.researchPurpose !== undefined && { researchPurpose: options.researchPurpose }),
    ...(options.researchBrief !== undefined && { researchBrief: options.researchBrief }),
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
    pipelineContext: {
      mode: pipelineContextMode,
      maxFocusedDiffBytes: pipelineContextMaxDiffBytes,
      projection: projectionValues,
    },
    routing: {
      profile,
      registry,
      defaultComplexity,
      ...(Object.keys(overrides).length > 0 && { overrides }),
      budgetPercents: {
        planner: options.roleBudgetPercents?.planner ?? options.budgetPercents ?? {},
        researcher: options.roleBudgetPercents?.researcher ?? options.budgetPercents ?? {},
        security: options.roleBudgetPercents?.security ?? options.budgetPercents ?? {},
        coder: options.roleBudgetPercents?.coder ?? options.budgetPercents ?? {},
        reviewer: options.roleBudgetPercents?.reviewer ?? options.budgetPercents ?? {},
        auditor: options.roleBudgetPercents?.auditor ?? options.budgetPercents ?? {},
      },
    },
    defaults: {
      maxRounds,
      defaultComplexity,
      ...(options.plannerHandoffAttempts !== undefined && {
        plannerHandoffAttempts: options.plannerHandoffAttempts,
      }),
    },
    effectiveConfig: {
      ...contextWindowProjection,
      inventoryProfile: {
        value: inventory?.name ?? "not-configured",
        source: inventory?.source ?? "built-in-default",
      },
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
      visionModel: {
        value: visionModel?.id ?? "not-configured",
        source: options.visionModel !== undefined ? "cli" : "built-in-default",
      },
      pluginTools: {
        value: pluginTools.length,
        source: options.pluginTools !== undefined ? "api" : "built-in-default",
      },
      enabledPlugins: {
        value: options.pluginTools !== undefined ? "custom" : enabledPlugins.join(",") || "none",
        source: options.enabledPlugins !== undefined ? "cli" : "built-in-default",
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
      // Compaction rewrites the whole history, so which model does it is a
      // routing decision an operator should be able to check without starting a
      // run -- and before this line the only way to learn it was to read the
      // profile and reimplement the override precedence by hand.
      summarizerModel: {
        value: summarizerModel.name,
        source: options.summarizerModel !== undefined ? "cli" : "profile",
      },
      pipelineContextMode: {
        value: pipelineContextMode,
        source: options.pipelineContextMode !== undefined ? "cli" : "built-in-default",
      },
      pipelineContextMaxDiffBytes: {
        value: pipelineContextMaxDiffBytes,
        source: options.pipelineContextMaxDiffBytes !== undefined ? "cli" : "built-in-default",
      },
      pipelineContextMaxPaths: {
        value: projectionValues.maxPaths,
        source: options.pipelineContextMaxPaths !== undefined ? "cli" : "built-in-default",
      },
      pipelineContextMaxPathBytes: {
        value: projectionValues.maxPathBytes,
        source: options.pipelineContextMaxPathBytes !== undefined ? "cli" : "built-in-default",
      },
      pipelineContextMaxAggregateBytes: {
        value: projectionValues.maxAggregateBytes,
        source: options.pipelineContextMaxAggregateBytes !== undefined ? "cli" : "built-in-default",
      },
      requestTimeoutMs: {
        value: requestTimeoutMs,
        source: options.requestTimeoutMs !== undefined ? "cli" : "built-in-default",
      },
      ...Object.fromEntries(
        Object.entries(stageLimits).map(([name, value]) => [
          `stageLimits.${name}`,
          {
            value,
            source:
              options.stageLimits?.[name as keyof StageLimits] !== undefined
                ? "cli"
                : "built-in-default",
          },
        ]),
      ),
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
    stageLimits,
    ...(Object.keys(roleStageLimits).length > 0 && { roleStageLimits }),
    ...(options.projectStoreConfig !== undefined && {
      projectStoreConfig: options.projectStoreConfig,
    }),
  };
}

/** Resolve the complete built-in pipeline, including every pipeline role and prompt. */
export function resolvePipelineConfig(options: ResolvePipelineConfigOptions): PipelineConfig {
  return resolveConfig(options, false);
}

/** Resolve only conversational model/config state; pipeline roles and prompts stay lazy. */
export function resolveOrchestratorSeed(options: ResolvePipelineConfigOptions): PipelineConfig {
  return resolveConfig(options, true);
}
