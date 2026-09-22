import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, CacheRetention, CredentialStore, Model } from "@earendil-works/pi-ai";
import { assertCredentialPathOutsideProject, FileCredentialStore } from "../auth/credential-store";
import { ConfigError } from "../config/errors";
import { loadModelsConfigSeam, loadSettingsConfigSeam } from "../config/seam";
import { toRegistryAndProfile } from "../config/to-registry";
import type { ProviderAdmissionSettings, SessionManagerSettings } from "../config/types";
import { type ContextBudgetPercents, deriveContextBudget } from "../context/budget";
import type { CompactionMode } from "../context/compactor";
import { assertSummarizerWindow } from "../context/compactor";
import { CostAnomalyDetector, FileCostAnomalyStore } from "../economics/cost-anomaly";
import { DEFAULT_PROJECT_GATES } from "../gates/project-gates";
import type { QualityGate } from "../gates/types";
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
import { readProjectCalibrationSnapshot, snapshotSource } from "../project-calibration";
import type { ProjectStoreConfig } from "../project-store/types";
import { buildExploreProjectTool, EXPLORE_PROJECT_TOOL_NAME } from "../project-tools/explore";
import { buildReadProjectTool, READ_PROJECT_TOOL_NAME } from "../project-tools/read";
import { buildSearchProjectTool, SEARCH_PROJECT_TOOL_NAME } from "../project-tools/search";
import { resolvePrompt } from "../prompts/prompts";
import type { ResearchPurpose, RoleBriefSource } from "../prompts/role-briefs";
import {
  DEFAULT_PROVIDER_ADMISSION_CONFIG,
  FileProviderAdmissionStore,
  MemoryProviderAdmissionStore,
  type ProviderAdmissionConfig,
  ProviderAdmissionController,
  type ProviderAdmissionStore,
} from "../provider-admission";
import { RegistryError } from "../registry/errors";
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
import { DEFAULT_MAX_PROJECTS } from "../session-manager/manager";
import { pluginNamesFromToolNames } from "../skills/resolver";
import { LOAD_SKILL_TOOL_NAME, roleSkillKit } from "../skills/role-kit";
import { resolveStampRequirement } from "../stamp/record-review-stamp";
import { buildImageInspectionTool, buildWebTools } from "../web/tools";
import { BUILT_IN_PIPELINE_WORKFLOW_NAME } from "../workflows/builtin-pipeline";
import { printStartupBannerOnce } from "./startup-banner";

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
 * `defineRole`), which the defaults satisfy (0.10 + 0.25 < 0.80).
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

/**
 * Calibrated 2026-09-19 (issue #405) from the fleet's own pause statistics: 72 coordinator run
 * records carried 16 duration pauses and 4 input-token pauses, and **zero** pauses on model turns,
 * tool turns or cost. Duration and input are therefore the ceilings that actually bind, and the
 * turn ceilings move with them so that a raised duration does not simply push the same stage into
 * the neighbouring wall (the plan stage that closed out on `model_turns` at 20/30 with 12 reserved
 * is the specimen). Cost is deliberately NOT raised: it is the one ceiling with no pause evidence,
 * and the per-role cost ratios are a calibration of their own.
 */
export const DEFAULT_STAGE_LIMITS: Required<StageLimits> = {
  maxDurationMs: 2_700_000,
  maxModelTurns: 144,
  maxToolTurns: 576,
  maxInputTokens: 2_400_000,
  maxCostUsd: 6,
  finalResponseReserveModelTurns: 12,
  finalResponseReserveDurationMs: 90_000,
  finalResponseReserveToolTurns: 24,
  finalResponseReserveInputTokens: 300_000,
};

/**
 * Efficient role ceilings inferred from committed dogfood evidence; overrides remain data-only.
 *
 * Calibrated again 2026-09-19 (issues #358, #405): the per-role table is what the operator's own
 * console runs on — a global `--stage-max-*` flag OVERRIDES these values, so raising the flag alone
 * leaves every run that passes no flag exactly where it was. Every ceiling below moves by one
 * bounded step (duration and turns x1.5, input x1.6) and cost stays put, because cost is the one
 * dimension with no pause evidence at all.
 *
 * Two of these steps are measurements rather than symmetry:
 *
 * - `planner.maxDurationMs` takes its value from the learned ceiling the stage-limit contract
 *   already records (docs/contracts/stage-limit-calibration.md, 2026-09-18, run
 *   `4c26d8d9-f682-4587-8e5e-07f1de1f8e82`): a plan stage that exhausted 540_000 completed at
 *   726_866 once it was given 810_000. The shipped default was still the pre-probe number, so the
 *   learned value never reached anyone who did not pass a flag by hand.
 * - `planner.maxModelTurns` follows the closeout reason of that same completion:
 *   `reason model_turns, "20/30 model turns used, 12 reserved"` — with duration raised, the turns
 *   ceiling is the next one the stage meets.
 *
 * The rest is symmetry with those two, which is a stated reason and not a measurement: a raise of
 * one ceiling without its neighbours only moves where the stage stops. 78% of every duration pause
 * recorded is the plan stage, so the planner's numbers are the ones to watch; if it pauses again,
 * that is the second observation the contract requires before the next raise.
 */
export const DEFAULT_ROLE_STAGE_LIMITS: Readonly<Partial<Record<ProfileRole, StageLimits>>> = {
  planner: {
    maxDurationMs: 810_000,
    maxModelTurns: 45,
    maxToolTurns: 90,
    maxInputTokens: 1_200_000,
    maxCostUsd: 0.3,
  },
  researcher: {
    maxDurationMs: 1_080_000,
    maxModelTurns: 63,
    maxToolTurns: 144,
    maxInputTokens: 1_440_000,
    maxCostUsd: 0.75,
  },
  security: {
    maxDurationMs: 810_000,
    maxModelTurns: 45,
    maxToolTurns: 90,
    maxInputTokens: 960_000,
    maxCostUsd: 0.45,
  },
  coder: {
    maxDurationMs: 2_160_000,
    maxModelTurns: 90,
    maxToolTurns: 216,
    maxInputTokens: 1_920_000,
    maxCostUsd: 2.4,
  },
  reviewer: {
    maxDurationMs: 1_350_000,
    maxModelTurns: 72,
    maxToolTurns: 180,
    maxInputTokens: 1_680_000,
    maxCostUsd: 1.5,
  },
  auditor: {
    maxDurationMs: 1_350_000,
    maxModelTurns: 72,
    maxToolTurns: 180,
    maxInputTokens: 1_680_000,
    maxCostUsd: 1.5,
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
/** The six worker roles the conversational orchestrator can delegate independently. */
export const DELEGATABLE_ROLES = [
  "planner",
  "researcher",
  "security",
  "coder",
  "reviewer",
  "auditor",
] as const;

/**
 * The resolved, machine-readable counterpart of the startup banner: which
 * worker roles this session can delegate and the model each dispatches on at
 * the default complexity. Assembled by the resolver from the same layout the
 * banner prints, so a delegation tool's description never restates role names
 * as prose that can go stale.
 */
export interface DelegatedRoute {
  source: string;
  complexity: string;
  groups: readonly { model: string; roles: readonly string[] }[];
  /** Delegatable roles that resolved to no model at this complexity. */
  unreachable: readonly string[];
}

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
  /**
   * The named routing profile the operator selected from `models.yaml`
   * (`--models-profile`). Absent means the document's own `default:`, which is
   * the route every fleet process runs unless it names another profile.
   */
  modelsProfile?: string;
  /**
   * The `models.yaml` path the stored-config seam reads. When set with no
   * independent overrides, the resolver tries this file (issue #280);
   * absent/malformed follows the seam's typed rules. Never read from the real
   * home config in tests -- inject a temp path.
   */
  modelsConfigPath?: string;
  /** The `settings.yaml` path (behaviour). Always honoured when set, independent of routing. */
  settingsConfigPath?: string;
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
  /** Maximum durable summary output tokens; absent derives one third of each active window. */
  compactionSummaryMaxTokens?: number;
  /** Attempts on the configured summarizer route before its active-route fallback. */
  compactionSummarizerRetryLimit?: number;
  /** Retry exhausted summarization through the active role model. Defaults to true. */
  compactionFallbackToRoleModel?: boolean;
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
  /**
   * Replace the shipped declared-gate set for the pipeline (issue #227). Omit
   * it and the pipeline runs the project's own seven gates; a caller or project
   * hands its own argv data (e.g. `cargo clippy`) instead. `maxCaptureBytes`
   * overrides the executor's per-gate inbound capture ceiling.
   */
  qualityGates?: {
    gates?: QualityGate[];
    maxOutputChars?: number;
    maxCaptureBytes?: number;
  };
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
  /**
   * The headless SessionManager's allowed roots and creation volume
   * (issue #365 layer 2), surfaced in `config show` the same way admission is:
   * the configured value and the layer that set it. An empty root list is the
   * refusal-to-serve default, never a silent zero.
   */
  sessionManagerSettings?: SessionManagerSettings;

  /** Where the session-manager settings came from (config:configurable). */
  sessionManagerSettingsSource?: "settings" | "caller";

  /** Monotonic milliseconds seam for deterministic stage metrics. */
  monotonicNow?: () => number;
  /**
   * Operator/caller overrides for the shared provider-admission boundary
   * (issue #365), e.g. `settings.yaml`'s `provider-admission` section. Absent
   * means the module's finite defaults with admission ENABLED; a configured
   * `maxConcurrentPerScope: 0` is the disable sentinel handled by the wiring
   * gate below, never fed to the module's constructor.
   */
  providerAdmissionSettings?: ProviderAdmissionSettings;
  /**
   * Where those settings came from, so enabled-by-default is never silent
   * (docs/contracts/config.md). A caller that supplies settings without naming
   * a source is the source.
   */
  providerAdmissionSettingsSource?: "settings" | "caller";
  /** Explicit model-inventory operation that receives the shipped Researcher brief. */
  researchPurpose?: ResearchPurpose;
  /** Trusted simple skill selection for every role prompt; absent means the catalogue. */
  selectedSkills?: readonly string[] | undefined;
  /** Explicit off: no catalogue, no loader, no appendix (the `--no-skills` flag resolves to this). */
  skillsDisabled?: boolean | undefined;
  /** The skill set a run can reach, resolved with digests, for the visibility row. */
  skillInventory?:
    | readonly { id: string; version: string; source: string; sha256: string }[]
    | undefined;
  /** Where that skill set came from: flag, profile setting, or the default. */
  skillsSource?: "cli" | "profile" | "built-in-default" | undefined;
  /** Resolved enabled workflow-module names; absent means the built-in default, empty means off. */
  selectedWorkflows?: readonly string[] | undefined;
  /** Where that selection came from, so enabled-by-default is never silent. */
  workflowsSource?: "cli" | "built-in-default" | undefined;
  /**
   * Refuse an unresolvable route instead of substituting the env-preset/codex
   * fallback (issue #453). When `true`, the precedence ladder
   * (models.yaml -> inventory -> registryConfig -> env-preset) MUST resolve to
   * a route the resolve can name; an absent rung at every level throws a typed
   * `route_unresolved` error naming the selection sources that were considered
   * and the rung that could not be reached -- never a credential value, never
   * provider prose. Scoped to the spawned/detached worker entry: a console
   * launched with no stored selection keeps its present built-in fallback.
   */
  requireResolvableRoute?: boolean;
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

/** The five admission settings a caller may override, in resolution order. */
const ADMISSION_SETTING_KEYS = [
  "maxConcurrentPerScope",
  "queueCapacityPerScope",
  "maxWaitMs",
  "retryDelayMs",
  "cooldownMaxMs",
] as const;

/**
 * The ONE wiring gate that turns resolved admission settings into the shared
 * `ProviderAdmissionController` (issue #365).
 *
 * The disable sentinel lives HERE, not in the module: the config convention is
 * numeric limits default `0` where `0` disables, but the module's own config
 * validation refuses `maxConcurrentPerScope: 0` (a controller without
 * concurrency admits nothing). So a configured `0` means admission DISABLED —
 * this returns `undefined` and every seam unwraps to a pass-through chain —
 * and the `0` never reaches the constructor. Any other configured value is
 * fed to the constructor as an override, so the module's finite defaults stay
 * standing and nonsense (a zero on a positive-required setting, a non-integer)
 * fails loud with the module's `TypeError`.
 *
 * The optional `durableStore` is how a headless caller honours the contract's
 * durability line ("admission status ... durable wherever a request is
 * durable"): every shipped entry point that knows a durable run store binds
 * `FileProviderAdmissionStore(targetDir)` so queue/cooldown/uncertain state
 * is restored at construction alongside the durable runs.
 */
export function resolveProviderAdmissionController(
  settings: ProviderAdmissionSettings | undefined,
  durableStore?: ProviderAdmissionStore,
): ProviderAdmissionController | undefined {
  if (settings?.maxConcurrentPerScope === 0) return undefined;
  const overrides: Partial<ProviderAdmissionConfig> = {};
  for (const key of ADMISSION_SETTING_KEYS) {
    const value = settings?.[key];
    if (value !== undefined) overrides[key] = value;
  }
  // NO durable run store in hand: an explicitly in-memory store, justified
  // against the contract's durability line — admission state stays durable
  // only wherever a request is durable, and a caller that seeds a controller
  // without a targetDir has no durable run store to attach to, so the
  // snapshot survives within this process (snapshots, double-restore guards)
  // but not a restart. Durable shipped paths pass the file store above;
  // programmatic in-process callers are not a durable-request surface.
  return new ProviderAdmissionController(
    overrides,
    durableStore ?? new MemoryProviderAdmissionStore(),
  );
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
  // Provider admission (issue #365): the shared outermost Models boundary.
  // Constructed here for every resolved run because the contract makes a
  // saturated scope unbypassable, and resolved here so `config show` reports
  // the effective limits with the layer that set them. Enabled by default;
  // a configured `maxConcurrentPerScope: 0` is the disable sentinel, judged
  // inside the wiring gate (the module refuses a zero).
  //
  // DURABILITY: a resolved run already persists against `options.targetDir`
  // (durable runs and ledger live under `.ad-coder/`, and the cost-anomaly
  // detector below binds its own file store to the same root), so admission
  // state is stored there too and restored at construction — resting queue
  // occupancy, cooldown, and the uncertain in-flight permit survive a restart
  // beside the durable run records, per docs/contracts/provider-admission.md.
  const providerAdmissionController = resolveProviderAdmissionController(
    options.providerAdmissionSettings,
    new FileProviderAdmissionStore(options.targetDir),
  );
  const admissionSource =
    options.providerAdmissionSettings === undefined
      ? "built-in-default"
      : (options.providerAdmissionSettingsSource ?? "caller");
  const providerAdmissionRows: Record<
    string,
    { value: string | number | boolean; source: string }
  > = {
    "providerAdmission.enabled": {
      value: providerAdmissionController !== undefined,
      source:
        options.providerAdmissionSettings?.maxConcurrentPerScope !== undefined
          ? admissionSource
          : "built-in-default",
    },
  };
  for (const key of ADMISSION_SETTING_KEYS) {
    const configured = options.providerAdmissionSettings?.[key];
    providerAdmissionRows[`providerAdmission.${key}`] = {
      value: configured ?? DEFAULT_PROVIDER_ADMISSION_CONFIG[key],
      source: configured !== undefined ? admissionSource : "built-in-default",
    };
  }
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
  // What this session's skills may require, resolved ONCE and threaded into
  // every role kit: workflow dependency from the workflows the run actually
  // resolved, plugin dependency from the tool names actually registered (a
  // group name in configuration is a claim, not a registered tool). Absent
  // composition fails closed in the resolver.
  const skillComposition = {
    availableWorkflows: options.selectedWorkflows ?? [BUILT_IN_PIPELINE_WORKFLOW_NAME],
    availablePlugins:
      options.pluginTools !== undefined
        ? pluginNamesFromToolNames(options.pluginTools.map((tool) => tool.name))
        : [...(enabledPlugins as readonly string[])],
  };
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
  // The project's DECLARED gates (issue #227): shipped seven by default or a
  // caller-supplied substitute — plain argv data, never a prompt.
  const gateOverride = options.qualityGates?.gates;
  const resolvedGates = gateOverride !== undefined ? [...gateOverride] : [...DEFAULT_PROJECT_GATES];
  for (const gate of resolvedGates) {
    if (typeof gate.name !== "string" || gate.name.trim() === "")
      throw new Error("qualityGates.gates[].name must be a non-empty string");
    if (!Array.isArray(gate.command) || gate.command.length === 0)
      throw new Error(`qualityGates.gates ${gate.name} must declare a command argv`);
  }
  if (options.qualityGates?.maxOutputChars !== undefined) {
    if (
      !Number.isSafeInteger(options.qualityGates.maxOutputChars) ||
      options.qualityGates.maxOutputChars <= 0
    )
      throw new Error("qualityGates.maxOutputChars must be a positive safe integer");
  }
  for (const [name, value] of Object.entries(surfaceAnalysisLimits)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`surfaceAnalysisLimits.${name} must be a non-negative safe integer`);
  }
  if (options.registryConfig !== undefined && options.provider !== undefined) {
    throw new Error("provider cannot be combined with registryConfig");
  }
  // The `--<role>-model` family COMPOSES with a stored routing config
  // (issue #101 item 3): pinning one role's model must not drop the operator's
  // selected registry, so those flags are deliberately absent from this guard.
  // `--models-profile` is a SELECTION, not a replacement, so it is absent too --
  // it names a profile inside the document the seam already reads.
  if (
    options.modelsProfile !== undefined &&
    options.modelsConfigPath === undefined &&
    options.registryConfig === undefined
  )
    throw new Error("modelsProfile requires modelsConfigPath or registryConfig");
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
  // Sync snapshot of the stored-credential knowledge set (ids only). Only the
  // shipped store can produce it: a foreign/injected store keeps `undefined`,
  // so every provider it serves keeps the env-only preflight.
  const storedIds =
    credentials instanceof FileCredentialStore ? credentials.storedProviderIds() : undefined;

  // Behaviour settings (`settings.yaml`) reach BOTH stamp consumers through one
  // resolution, so the settle writer and the `stamp check` gate can never
  // disagree (D3). Absent settings defer to the marker via "auto".
  const settingsConfig =
    options.settingsConfigPath === undefined
      ? undefined
      : loadSettingsConfigSeam(options.settingsConfigPath);
  const requireStamp = resolveStampRequirement(settingsConfig);

  // The session-manager surface (issue #365 layer 2) reads the same resolved
  // `settings.yaml` the stamp consumers use, so the operator's roots and
  // creation volume are visible beside every other effective setting. An
  // empty root list is the refusal-to-serve default and the row says so.
  const sessionManagerSettings = settingsConfig?.sessionManager;
  const sessionManagerRows: Record<string, { value: string | number | boolean; source: string }> = {
    "sessionManager.allowedRoots": {
      value:
        sessionManagerSettings?.allowedRoots.join(", ") || "(none: the manager refuses to serve)",
      source: sessionManagerSettings?.allowedRoots.length ? "settings" : "built-in-default",
    },
    "sessionManager.maxProjects": {
      value: sessionManagerSettings?.maxProjects ?? DEFAULT_MAX_PROJECTS,
      source: sessionManagerSettings?.maxProjects !== undefined ? "settings" : "built-in-default",
    },
  };

  // THE STORED-CONFIG SEAM (issue #280). It is now the ONLY stored routing
  // source (issue #513 retired the JSON inventory): the branch is entered when
  // `modelsConfigPath` is set and no independent REPLACE-semantic override is
  // in play (the exact complement of the combination guard above). The
  // `--<role>-model` family composes instead of disabling (issue #101 item 3):
  // pinning one role's model keeps the stored routing config and overrides just
  // that role. `models.yaml` present -> it wins; a present-but-unusable YAML is
  // a typed error; ABSENT falls through to the built-in env-preset/codex route,
  // unchanged. Nothing is seeded on first use.
  const useStoredConfig =
    options.modelsConfigPath !== undefined &&
    ![
      options.registryConfig,
      options.profile,
      options.provider,
      options.strongModel,
      options.midModel,
      options.cheapModel,
      options.overrides,
    ].some((value) => value !== undefined);

  let yamlSelection:
    | {
        registry: RegistryConfig;
        profile: Profile;
        name: string;
        reachableProviders: string[];
        source: "default" | "selection";
      }
    | undefined;
  if (useStoredConfig) {
    const models = loadModelsConfigSeam(options.modelsConfigPath as string);
    if (models !== undefined) {
      const projected = toRegistryAndProfile(models, options.modelsProfile);
      yamlSelection = {
        registry: projected.registry,
        profile: projected.profile,
        name: projected.name,
        reachableProviders: projected.reachableProviders,
        source: options.modelsProfile === undefined ? "default" : "selection",
      };
    }
    // models.yaml ABSENT leaves `yamlSelection` undefined so the existing
    // selectProvider flow decides below. The stored `inventories.json` route is
    // gone from the code (issue #513), not merely retired: a file left on disk
    // is read by nothing and is not an error -- there is no second stored
    // routing source to point the operator at, and no migration command to name.
  }

  const provider =
    yamlSelection === undefined && options.registryConfig === undefined
      ? selectProvider(env, options.provider, warn)
      : undefined;
  // NO STORED SELECTION (issue #453). When the resolve cannot find a route
  // -- no models.yaml, no registry config, no explicit provider, and no
  // env-preset key present -- the existing selectProvider flow would
  // fall through to the codex OAuth default. The detached worker entry opts
  // out of that substitution: a worker re-running the same resolve with a
  // different credential store or a different env can land on a route the
  // operator never picked, and that is exactly the divergence this rule
  // refuses. Names and numbers only -- never a credential value, never
  // provider prose. The console with no stored selection keeps its present
  // built-in fallback.
  if (
    options.requireResolvableRoute === true &&
    yamlSelection === undefined &&
    options.registryConfig === undefined &&
    options.provider === undefined &&
    PROVIDER_BY_ENV.every(({ envVar }) => {
      const value = env(envVar);
      return value === undefined || value === "";
    })
  ) {
    // Detail is a names-only list of the absent rungs and the env-var NAMES
    // that could have selected a provider -- never a credential value,
    // never a provider URL, never raw provider prose. Names only.
    const absentRungs = ["models.yaml", "--registry-config", "--provider"].join(", ");
    const envVars = PROVIDER_BY_ENV.map(({ envVar }) => envVar).join(", ");
    throw new ConfigError(
      "route_unresolved",
      `absent:${absentRungs}; env-present:none; env-options:${envVars}`,
      `no routing selection resolved (${absentRungs} all absent and no env-preset provider key present); pass --models-config, --registry-config, --provider, or set one of ${envVars}`,
    );
  }
  const presetSelection = provider === undefined ? undefined : PROVIDER_PRESETS[provider];
  let authoredRegistry: RegistryConfig;
  if (yamlSelection !== undefined) authoredRegistry = yamlSelection.registry;
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
  for (const [name, value] of [
    ["compactionSummaryMaxTokens", options.compactionSummaryMaxTokens],
    ["compactionSummarizerRetryLimit", options.compactionSummarizerRetryLimit],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }

  // PREFLIGHT SCOPE (issue #414). On the models.yaml route the credential
  // preflight covers only the providers the SELECTED routing actually names:
  // the profile's reachable providers plus the providers owning any
  // `--<role>-model` / `--vision-model` override (those COMPOSE with the
  // selection, config contract #101, so they can reach a provider the profile
  // itself does not name). Model -> owner resolution goes through the same
  // validated registry projection the resolver indexes, never the rung's
  // textual prefix. The routes with no stored selection (env preset, explicit
  // `--provider`, `--registry-config`) keep resolving every provider: no option
  // there.
  const preflightCredentialSet = ((): ReadonlySet<string> | undefined => {
    if (yamlSelection === undefined) return undefined;
    const ownerOf = (name: string): string | undefined =>
      registryConfig.providers.find((p) => p.models.some((m) => m.name === name))?.id;
    const ids = new Set<string>(yamlSelection.reachableProviders);
    for (const name of [
      options.orchestratorModel,
      options.plannerModel,
      options.researcherModel,
      options.securityModel,
      options.coderModel,
      options.reviewerModel,
      options.auditorModel,
      options.summarizerModel,
      options.visionModel,
    ]) {
      if (name === undefined) continue;
      const owner = ownerOf(name);
      if (owner !== undefined) ids.add(owner);
      // An unregistered override name stays absent here: the composed-override
      // check below raises unknown_model naming the selection and the model.
    }
    return ids;
  })();

  const registry: ResolvedRegistry = resolveRegistry(registryConfig, {
    env,
    credentials,
    ...(storedIds !== undefined && { storedCredentialIds: storedIds }),
    ...(preflightCredentialSet !== undefined && {
      preflightCredentialIds: preflightCredentialSet,
    }),
  });
  // The providers are validated here and nowhere printed: naming an environment
  // variable and a host is naming the plumbing, not a decision, and the banner
  // below carries the selection and the role->model ladder the operator checks
  // (issue #501). The resolved data keeps its home in the config surface.
  for (const configuredProvider of registryConfig.providers) {
    const firstModel = configuredProvider.models[0];
    if (firstModel === undefined) throw new Error("provider must declare a model");
    registry.getModel(firstModel.name);
  }
  const defaultProfile = buildDefaultProfile({ strong, mid, cheap });
  // A committed project snapshot applies when it names the SAME source the run
  // resolved (#506): a `models.yaml` profile matches a models profile. With the
  // YAML route the snapshot used to be skipped entirely -- the target
  // directory's own calibration could never apply once routing moved to
  // `models.yaml`. The retired JSON-inventory namespace (#513) is gone with the
  // route: a snapshot calibrated against an inventory naming the same string is
  // no longer the same source, because there is no such source to be.
  const selectedSource: { kind: "models-profile"; name: string } | undefined =
    yamlSelection !== undefined ? { kind: "models-profile", name: yamlSelection.name } : undefined;
  // Read only when a source is selected: a snapshot can apply to nothing else,
  // and a target directory's malformed snapshot must not fail a run that could
  // never have used it. A route that CAN use it still fails loudly, as before.
  const projectCalibration =
    options.useProjectCalibration === false ||
    options.profile !== undefined ||
    selectedSource === undefined
      ? undefined
      : readProjectCalibrationSnapshot(options.targetDir);
  const snapshotRef =
    projectCalibration === undefined ? undefined : snapshotSource(projectCalibration);
  const projectProfile =
    projectCalibration !== undefined &&
    snapshotRef !== undefined &&
    selectedSource !== undefined &&
    snapshotRef.kind === selectedSource.kind &&
    snapshotRef.name === selectedSource.name
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
      yamlSelection?.profile ??
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

  // Per-role model overrides COMPOSE with a stored selection, so an override
  // naming a model the selected profile's registry does not register must fail
  // HERE, naming both the selection and the override model, instead of
  // surfacing later as the generic `unknown_model` (which no longer names the
  // selection that made the name wrong). The preset path (no stored selection)
  // keeps the registry's own error, unchanged.
  const selectionName = yamlSelection?.name;
  if (selectionName !== undefined) {
    const registered = (name: string): boolean => {
      try {
        registry.getModel(name);
        return true;
      } catch {
        return false;
      }
    };
    for (const [role, override] of Object.entries(overrides)) {
      if (override === undefined || registered(override.model)) continue;
      throw new RegistryError(
        "unknown_model",
        override.model,
        `override model "${override.model}" for role "${role}" is not registered by the selected profile "${selectionName}"`,
      );
    }
    if (options.visionModel !== undefined && !registered(options.visionModel)) {
      throw new RegistryError(
        "unknown_model",
        options.visionModel,
        `override model "${options.visionModel}" for role "vision" is not registered by the selected profile "${selectionName}"`,
      );
    }
  }

  // Every role resolves through here, so the banner reports exactly the route
  // the run will take.
  //
  // `orchestrator` gained a profile cell of its own so a profile can name its
  // model per complexity and a calibration run can attribute its cost apart
  // from the work it delegates; before that it silently read the coder's cell,
  // which made every measurement of the orchestrator a measurement of the
  // coder. Profiles authored before the cell existed have no orchestrator
  // entry, and an operator-authored profile is configuration we do not get to
  // invalidate -- so a MISSING orchestrator cell falls back to the coder
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
  // built from: under a stored selection whose tiers all collapse onto one
  // default model, the old banner printed `strong "x" mid "x" cheap "x"` for a
  // profile routing every role across several models -- true of nothing.
  // Roles are grouped by the model they resolve to at the default complexity,
  // which is the routing decision an operator checks before letting a run go.
  const layout = new Map<string, ProfileRole[]>();
  // The provider id behind every routed model name, collected while the roles
  // are resolved so the banner can name it (issue #501) without a second
  // registry walk: the layout key is the model's display name, and the
  // provider lives on the resolved model beside it.
  const layoutProvider = new Map<string, string>();
  for (const role of PROFILE_ROLES) {
    let modelName: string;
    try {
      const resolved = resolveRole(role);
      modelName = resolved.model.name;
      layoutProvider.set(modelName, resolved.model.provider);
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
    yamlSelection !== undefined
      ? `models.yaml "${yamlSelection.name}"`
      : `provider "${provider ?? "custom"}"`;
  const routing = [...layout]
    .map(([modelName, roles]) => `${modelName}: ${roles.join(", ")}`)
    .join(" | ");
  // The operator asked for the provider by name (issue #501): a selection of
  // `models.yaml "x"` names a cell, not a destination, and
  // a routing is not checkable without knowing who serves it. The distinct
  // provider ids the routed models actually resolve to -- never a host, never
  // a credential variable name -- are named here, but only where `source` does
  // not already name them: `provider "deepseek"` restating itself is noise.
  const routedProviders = [
    ...new Set(
      [...layout.keys()].flatMap((modelName) =>
        modelName === "unrouted" ? [] : (layoutProvider.get(modelName) ?? []),
      ),
    ),
  ].sort();
  const unnamedProviders = routedProviders.filter((id) => !source.includes(id));
  const providers =
    unnamedProviders.length === 0
      ? ""
      : unnamedProviders.length === 1
        ? ` | provider "${unnamedProviders[0]}"`
        : ` | providers ${unnamedProviders.map((id) => `"${id}"`).join(", ")}`;
  // ONE line, ONCE per process (issue #501): the selection, the provider and
  // the role->model ladder. No built-in default complexity -- the orchestrator
  // classifies each brief and routes on that tier, so a number resolved before
  // any brief was seen described no real turn. The memo keys on the banner's
  // CONTENT, so the per-delegation re-resolutions behind one session (twenty
  // in a measured session, each printing the old two-line banner) stay silent,
  // while a genuinely different routing prints once more.
  printStartupBannerOnce(`ad-coder: ${source}${providers} | ${routing}\n`, warn);
  // The same resolved facts, projected onto the roles general delegation can
  // reach, so a delegation tool's description reuses the banner's data instead
  // of restating role names. A role that stays unwritten in the profile is
  // `unrouted` in the banner and null here: the run may not reach it, and a
  // `run_role` call for it raises the real typed error.
  const delegatedRoute: DelegatedRoute = {
    source,
    complexity: defaultComplexity,
    groups: [...layout]
      .map(([modelName, roles]) => ({
        model: modelName,
        roles: roles.filter((role) => (DELEGATABLE_ROLES as readonly ProfileRole[]).includes(role)),
      }))
      .filter((group) => group.roles.length > 0),
    unreachable: DELEGATABLE_ROLES.filter((role) =>
      // The "unrouted" pseudo-group means NO model -- the roles inside it are
      // exactly the unreachable ones (issue #388): counting it as reachability
      // made a profile that leaves the reviewer unwritten wire a reviewer cover
      // that could only fail. A role is reachable only through a real model.
      [...layout.entries()].every(
        ([modelName, roles]) => modelName === "unrouted" || !roles.includes(role),
      ),
    ),
  };

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
      disabled: options.skillsDisabled,
      projectDir: options.targetDir,
      ...skillComposition,
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
      disabled: options.skillsDisabled,
      projectDir: options.targetDir,
      ...skillComposition,
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
        [
          `compactionThresholdTokens.${name}`,
          {
            value: spec.role.contextBudget.maxTokens - spec.role.contextBudget.reserveTokens,
            source: "derived",
          },
        ],
        [
          `compactionSummaryMaxTokens.${name}`,
          {
            value: options.compactionSummaryMaxTokens ?? Math.floor(spec.model.contextWindow / 3),
            source: options.compactionSummaryMaxTokens !== undefined ? "cli" : "derived-default",
          },
        ],
      ];
    }),
  );

  return {
    targetDir: options.targetDir,
    models: registry.models,
    task: options.task,
    ...(requireStamp !== "auto" && { requireStamp }),
    // Constructed here, for every run resolved through the CLI, because the
    // contract makes detection default-on: a detector nobody builds protects
    // nobody. Its state is per-project and on disk, so a block raised by an
    // unattended run is still standing -- and still liftable by `cost release`
    // -- when the next invocation starts.
    costAnomalyDetector: new CostAnomalyDetector({}, new FileCostAnomalyStore(options.targetDir)),
    ...(providerAdmissionController !== undefined && { providerAdmissionController }),
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
    // The project's DECLARED gates, run after the coder and before review
    // (issue #227). Shipped seven by default; a caller replaces the whole
    // array with its own argv data. Gates are config, never a role.
    qualityGates: {
      gates: resolvedGates,
      ...(options.qualityGates?.maxOutputChars !== undefined && {
        maxOutputChars: options.qualityGates.maxOutputChars,
      }),
    },
    roles,
    delegatedRoute,
    ledgerSink: new MemoryLedgerSink(),
    compaction:
      compactionMode === "disabled-then-halt"
        ? { mode: compactionMode }
        : {
            mode: compactionMode,
            summarizerModel,
            ...(options.compactionSummaryMaxTokens !== undefined && {
              summaryMaxTokens: options.compactionSummaryMaxTokens,
            }),
            ...(options.compactionSummarizerRetryLimit !== undefined && {
              summarizerRetryLimit: options.compactionSummarizerRetryLimit,
            }),
            ...(options.compactionFallbackToRoleModel !== undefined && {
              fallbackToRoleModel: options.compactionFallbackToRoleModel,
            }),
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
      ...providerAdmissionRows,
      ...sessionManagerRows,
      // Set-valued capability visibility (docs/contracts/config.md): the
      // resolved names and where the selection came from. `none` names the
      // explicit off, never a silent absence.
      skills: {
        // The capability state plus the reach set, the way "enabled by default
        // is never silent" reads in `config show`: it says ON/OFF explicitly,
        // then lists id, version, source tier, and digest of what a role can
        // load. An empty list alone cannot say off -- an empty pin -- so
        // `enabled` carries the switch and the layer names who set it.
        value: {
          enabled: options.skillsDisabled !== true,
          skills:
            options.skillInventory === undefined
              ? null
              : options.skillInventory.map((skill) => ({
                  id: skill.id,
                  version: skill.version,
                  source: skill.source,
                  sha256: skill.sha256,
                })),
        },
        // A caller that supplies the resolved set without naming a source is the source.
        source:
          options.skillsSource ??
          (options.skillInventory === undefined ? "built-in-default" : "caller"),
      },
      workflows: {
        // Absent selection means the built-in default (every shipped module
        // ON), but the resolver does not own the list of shipped names, so it
        // names the default instead of inventing an enumeration. A provided
        // but empty set is the explicit off and says 'none'.
        value:
          options.selectedWorkflows === undefined
            ? "built-in-default"
            : options.selectedWorkflows.join(",") || "none",
        // A caller that sets the resolved set without naming a source is the
        // source: a default shape that never came from a default would lie.
        source:
          options.workflowsSource ??
          (options.selectedWorkflows === undefined ? "built-in-default" : "caller"),
      },
      modelsProfile: {
        value: yamlSelection?.name ?? "not-configured",
        source: yamlSelection !== undefined ? "models.yaml" : "built-in-default",
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
      compactionSummarizerRetryLimit: {
        value: options.compactionSummarizerRetryLimit ?? 3,
        source: options.compactionSummarizerRetryLimit !== undefined ? "cli" : "built-in-default",
      },
      compactionFallbackToRoleModel: {
        value: options.compactionFallbackToRoleModel ?? true,
        source: options.compactionFallbackToRoleModel !== undefined ? "cli" : "built-in-default",
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
