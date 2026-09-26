import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { DelegatedRoute } from "../cli/resolve-config";
import type { StampRequirement } from "../config/types";
import type { ContextBudgetPercents } from "../context/budget";
import type { CompactionPolicy } from "../context/compactor";
import type { CostAnomalyDetector } from "../economics/cost-anomaly";
import type { CommandExecutor, GateReport, QualityGate } from "../gates/types";
import type { LedgerSink } from "../ledger/ledger";
import type {
  ToolActivityChannel,
  ToolActivityConfig,
  ToolActivityConsumer,
} from "../observability/tool-activity";
import type { Profile, ProfileRole, SpawnOverride } from "../profiles/types";
import type { RunCoordinatorOptions } from "../project-operations/run-coordinator";
import type { FollowUp } from "../project-operations/types";
import type { ProjectStoreConfig } from "../project-store/types";
import type { ResearchPurpose, RoleBriefSource } from "../prompts/role-briefs";
import type { ProviderAdmissionController } from "../provider-admission";
import type { ResolvedRegistry } from "../registry/types";
import type { Role } from "../role";
import type { Tool } from "../runner/tool";
import type { SessionLimitController } from "../session-limits";
import type { StageCloseoutFact, StageLimitReason, StageLimits } from "./stage-limits";

/**
 * The three verdicts a reviewer round can settle on.
 *
 * `approved` ends the loop; `changes_requested` feeds the reviewer's issues
 * back to the coder for another round; `decomposition_required` escalates the
 * run to an immediate stop (see the stop rule in `session.ts`). There is
 * deliberately NO "error"/"unknown" state: a verdict that cannot be parsed into
 * one of these three literals is a hard `OrchestrationError`, not a silent
 * non-approval, so a malformed artifact can never be read as a pass.
 */
export type VerdictStatus = "approved" | "changes_requested" | "decomposition_required";

/**
 * Severity of a single reviewer issue. A fixed set BECAUSE the verdict is
 * untrusted model-produced JSON: the validator checks membership against these
 * three literals rather than trusting whatever string the model emitted.
 */
export type IssueSeverity = "blocker" | "major" | "minor";

/**
 * One reviewer finding. `what` is model-authored text that will be concatenated
 * into the coder's next prompt as DATA -- never interpolated into a shell, SQL,
 * or path sink (the pipeline treats it as prompt content only).
 */
export interface VerdictIssue {
  severity: IssueSeverity;
  /** Stable, relative file:line or scenario/fixture address for a reproducible finding. */
  location?: string;
  /** Objective observation that proves the finding is closed. */
  closureCriterion?: string;
  /** Bounded model-authored description, carried as untrusted data. */
  what: string;
  /** Optional identity used to distinguish carried findings from new findings. */
  findingId?: string;
  /** Resolution of a carried finding in a subsequent review. */
  resolution?: "closed" | "remains" | "new";
  /** Evidence supporting a closed resolution. */
  evidence?: string;
}

export interface RemovedTestBehavior {
  /** Exact identity from the machine-collected removed-test inventory. */
  removedTestId: string;
  behavior: string;
  fate: "restored" | "moved";
  destination: string;
}

export interface RemovedTestInventoryEntry {
  removedTestId: string;
  path: string;
  line: number;
  text: string;
}

export interface ReviewCoverage {
  surfaceId: string;
  contractIds: string[];
  evidence: string[];
}

/**
 * The structured verdict a reviewer submits via the `submit_verdict` tool call
 * and the pipeline strictly re-validates. Structured-and-schema-checked is
 * strictly stronger than parsing free text: `status` must be one of three
 * literals, `issues` an array of validated `VerdictIssue`, `summary` a string.
 * The tool's TypeBox `parameters` schema is deliberately permissive at the enum
 * leaves so `parseVerdict` in `verdict.ts` stays the authoritative gate -- see
 * that module for the validator.
 */
export interface Verdict {
  status: VerdictStatus;
  issues: VerdictIssue[];
  summary: string;
  /** Exact resolved governance matrix reviewed in this round. */
  coverage?: ReviewCoverage[];
  /** Machine-visible fate of test behaviours removed by the change. */
  removedTests?: RemovedTestBehavior[];
}

/**
 * The three complexity tiers a planner can assign to a task.
 *
 * A fixed set BECAUSE it is untrusted model-produced input: `parsePlan` in
 * `plan.ts` checks membership against these literals rather than trusting the
 * emitted string, exactly as `VerdictStatus` gates the verdict. This tier is a
 * routing SIGNAL for a later complexity-aware model-selection follow-on; this
 * unit only makes it AVAILABLE on `PipelineResult`, it does not consume it.
 */
export type Complexity = "trivial" | "medium" | "complex";

/**
 * How much attack surface the planner judges the task to touch.
 *
 * A fixed set BECAUSE it is untrusted model-produced input: `parsePlan` in
 * `plan.ts` checks membership against these literals rather than trusting the
 * emitted string, exactly as `Complexity` gates the tier. `elevated` is the
 * only value that ARMS the conditional Security phase in `runPipeline` (and only
 * when a `security` role is configured); `none`/`low` are informational. A
 * silent coercion to a wrong value here would let a benign surface read as a
 * dangerous one or the reverse, so the validator MUST throw, never default.
 */
export type SecuritySurface = "none" | "low" | "elevated";

export type ContractCoverageStatus = "covered" | "not_applicable" | "research_required";

export interface SurfaceAnalysisEntry {
  id: string;
  name: string;
  rationale: string;
}

export interface ContractCoverage {
  surfaceId: string;
  status: ContractCoverageStatus;
  contractIds: string[];
  evidence: string[];
  rationale: string;
}

export interface SurfaceAnalysis {
  projectType: string;
  surfaces: SurfaceAnalysisEntry[];
  coverage: ContractCoverage[];
}

/** Optional stricter limits for untrusted Planner artifacts. Zero disables each user limit. */
export interface SurfaceAnalysisLimits {
  maxItems: number;
  maxTextBytes: number;
  maxAggregateBytes: number;
  maxDepth: number;
}

export interface ResearchProvenance {
  destination: string;
  queryId: string;
  timestamp: string;
  summary: string;
  hash: string;
}

export interface ResearchDispatchIntent {
  effectId: string;
  destination: string;
  queryHash: string;
  surfaceIds: string[];
}

/**
 * The structured plan a planner submits via the `submit_plan` tool call and the
 * pipeline strictly re-validates. Structured-and-schema-checked is stronger than
 * parsing the free-text plan: `complexity` must be one of three literals,
 * `securitySurface` one of three literals, and `summary` a string. Like the
 * verdict, the plan is mandatory: an absent or malformed submission is a hard
 * failure before coding. The tool's TypeBox
 * `parameters` schema is deliberately permissive at the enum leaves so
 * `parsePlan` in `plan.ts` stays the authoritative gate.
 */
export interface Plan {
  complexity: Complexity;
  securitySurface: SecuritySurface;
  summary: string;
  /** Exact applicable contract rules, or faithful labeled compression when oversized. */
  contractRequirements: string[];
  /**
   * The product files the planner determined this task touches, injected into
   * the coder's round-1 handoff. Optional in the submission and defaulted to
   * `[]` by `parsePlan`: a planner that names no files degrades cleanly, it
   * never fails the plan.
   */
  affectedFiles: string[];
  surfaceAnalysis: SurfaceAnalysis;
}

/**
 * A role paired with the model it runs on. The pipeline binds one `targetDir`
 * and one `Models` collection for the whole run, but each role may drive a
 * different `model` (a cheap coder, a stronger reviewer).
 */
export interface RoleSpec {
  role: Role;
  model: Model<Api>;
}

/**
 * Complexity-aware model routing for a whole pipeline run.
 *
 * When a `PipelineConfig` carries `routing`, `runPipeline` resolves each turn's
 * model through `resolveProfile((role, complexity) + override)` against
 * `registry` and binds the runner to `registry.models` -- SUPERSEDING (not
 * removing) each `RoleSpec.model` and the top-level `config.models`. Both stay
 * required and valid config; routing simply chooses the live model per turn and
 * the RoleSpec's own `model` is ignored while routing is present. When `routing`
 * is ABSENT the pipeline is byte-for-byte its prior self: each turn runs on its
 * `RoleSpec.model` over `config.models`.
 *
 * `defaultComplexity` (default `'medium'`) routes the pre-complexity planner,
 * whose model must be chosen before the plan reveals a complexity. A profile's
 * planner row should
 * therefore be kept complexity-INVARIANT: the planner is always resolved on
 * `defaultComplexity`, so varying its per-complexity cells has no effect.
 *
 * `overrides` pins a specific model per role, winning over that role's
 * `(role, complexity)` cell (see `resolveProfile`'s override precedence).
 *
 * A caller config error surfaces as its own typed error, unwrapped:
 * `resolveProfile` throws `ProfileError('missing_mapping')` on a gap in the
 * profile and `ProfileError('unknown_model')` on an unregistered model name.
 * These are the caller's, so `runPipeline` lets them propagate as-is rather than
 * re-wrapping them in `OrchestrationError`.
 */
export interface PipelineRouting {
  profile: Profile;
  registry: ResolvedRegistry;
  defaultComplexity?: Complexity;
  overrides?: Partial<Record<ProfileRole, SpawnOverride>>;
  /** Portable per-role budgets, re-derived after each effective routing decision. */
  budgetPercents?: Partial<Record<ProfileRole, ContextBudgetPercents>>;
}

/**
 * Transition-policy defaults for the stepped workflow engine.
 *
 * WHY this exists (docs/contracts/config.md): the two policy decisions the loop
 * makes -- whether a `changes_requested` verdict with rounds remaining advances
 * to another code round or halts, and whether the linear phases (plan ->
 * security -> code -> review) auto-advance or pause for a driver decision -- are
 * values a caller might reasonably want to change, so they are SETTINGS with
 * efficient defaults, never hardcoded constants inlined in the engine.
 *
 * Each field is OPTIONAL and defaults to today's exact behavior, so an absent
 * `WorkflowDefaults` (the `runPipeline` path never sets one) is byte-for-byte
 * the prior pipeline:
 * - `onChangesRequested` (default `'advance'`): on `changes_requested` with
 *   `round < maxRounds`, does the DEFAULT transition advance to the next code
 *   round (`'advance'`) or stop (`'stop'`)? `'advance'` reproduces the loop.
 * - `autoAdvance` (default `true`): are the forward linear edges (plan->next,
 *   security->code, code->review) marked as the default transition (`true`, so
 *   `autoDriver` walks the graph) or is `stop` the default at each linear phase
 *   (`false`, so an auto-driver halts and a human/orchestrator driver chooses)?
 * - `maxRounds` / `defaultComplexity`: stepped-native mirrors of the values a
 *   `PipelineConfig` carries as its required `maxRounds` and
 *   `routing.defaultComplexity`. When both are supplied the top-level config
 *   fields win (they are the validated, authoritative source in the
 *   `runPipeline` path); these let a direct `createWorkflowSession` caller that
 *   has no routing still name a default complexity.
 */
export interface WorkflowDefaults {
  onChangesRequested?: "advance" | "stop";
  autoAdvance?: boolean;
  maxRounds?: number;
  defaultComplexity?: Complexity;
  /** One initial Planner attempt plus, by default, one bounded corrective retry for a missing tool handoff. */
  plannerHandoffAttempts?: 1 | 2;
}

/**
 * Declared-gate wiring for a pipeline run. `gates` defaults to
 * `DEFAULT_PROJECT_GATES`; `executor` defaults to the real spawn executor and
 * tests inject a fake (the same seam `GateRunner` already documents);
 * `maxOutputChars` overrides the report's per-gate capture ceiling
 * (`DEFAULT_GATE_RUNNER_CONFIG`).
 */
export interface QualityGatesConfig {
  gates?: readonly QualityGate[];
  executor?: CommandExecutor;
  maxOutputChars?: number;
}

/**
 * Everything `runPipeline` needs to drive one plan -> (code<->review) run.
 *
 * `planner` is the ONLY optional role: a run may skip planning, but it always
 * has a coder and a reviewer. `maxRounds` is a REQUIRED cap (documented default
 * 3 at the call site, not an implicit default in this type) validated `>= 1` --
 * it bounds the code<->review loop so a reviewer that never approves cannot
 * spin forever. `ledgerSink`, when supplied, is shared across every role-run so
 * the whole pipeline writes one readable ledger; runs are strictly sequential,
 * so a single sink is safe.
 */
export interface PipelineConfig {
  targetDir: string;
  models: Models;
  task: string;
  maxRounds: number;
  /**
   * The resolved review-stamp requirement (issue #280 settings wiring): a
   * non-`auto` value forces the settle writer and the `stamp check` gate the
   * same direction, so the two can never disagree. Absent means `auto`, the
   * marker-governed default, so legacy callers are untouched.
   */
  requireStamp?: StampRequirement;
  /** General plugin tools available to roles whose allow-list names them. Empty disables plugins. */
  pluginTools?: Tool[];
  /** Built-in plugin factory bound to the model actually dispatched for a role turn. */
  pluginToolsForModel?: (model: Model<Api>) => Tool[];
  /** Optional Planner governance limits; every zero value disables that limit. */
  surfaceAnalysisLimits?: SurfaceAnalysisLimits;
  /** Resolved pairing of each delegatable role with its model this session. */
  delegatedRoute?: DelegatedRoute;
  roles: {
    planner?: RoleSpec;
    /** Optional bounded fact-finding role used before Coder for research-required coverage. */
    researcher?: RoleSpec;
    coder: RoleSpec;
    reviewer: RoleSpec;
    /** Whole-project cold-read role; not part of the built-in pipeline graph. */
    auditor?: RoleSpec;
    /**
     * OPTIONAL threat-modelling role. The conditional Security phase runs only
     * when the planner's `securitySurface` is `elevated` AND this role is
     * present; absent, an elevated surface is skipped (a quiet stderr note) and
     * the run proceeds. It reads the plan/tree only -- no write/edit/submit.
     */
    security?: RoleSpec;
    /** Conversation-front role; ignored by the pipeline graph itself. */
    orchestrator?: RoleSpec;
  };
  ledgerSink?: LedgerSink;
  /** Resolved context policy; absent callers receive the core's auto default. */
  compaction?: CompactionPolicy;
  /** Post-rejection handoff policy. Absent callers receive the efficient incremental default. */
  pipelineContext?: PipelineContextConfig;
  /**
   * OPTIONAL complexity-aware model routing. When present, each turn's model is
   * chosen by `resolveProfile` and the runner binds to `routing.registry.models`
   * -- superseding `RoleSpec.model` + `config.models`. When absent, model
   * selection is byte-for-byte the prior behavior (each `RoleSpec.model` over
   * `config.models`). See `PipelineRouting`.
   */
  routing?: PipelineRouting;
  /**
   * OPTIONAL transition-policy overrides for the stepped engine underneath
   * `runPipeline`. Absent (as `runPipeline` always leaves it) every knob takes
   * its today's-behavior default, so the run is byte-for-byte the prior
   * pipeline. See `WorkflowDefaults`.
   */
  defaults?: WorkflowDefaults;
  /** Secret-free resolved values and their winning precedence tier.
   * A set-valued capability projects its members (objects), not just scalars. */
  effectiveConfig?: Readonly<
    Record<
      string,
      {
        value: string | number | boolean | readonly unknown[] | Readonly<Record<string, unknown>>;
        source: string;
      }
    >
  >;
  /** Shared generation-call accounting for every role in this workflow session. */
  sessionLimitController?: SessionLimitController;
  /** Shared cost-per-token anomaly tracking for every role in this session. */
  costAnomalyDetector?: CostAnomalyDetector;
  /**
   * Shared provider-capacity admission boundary (issue #365). Wrapping at the
   * runner's Models seam, outermost, is what makes a saturated scope
   * unbypassable: every generation path goes through this one boundary.
   */
  providerAdmissionController?: ProviderAdmissionController;
  /**
   * The project's DECLARED quality gates (issue #227). Declared as data, once —
   * `gates` defaults to the shipped declaration for this project and a different
   * project substitutes its own list without touching a role or prompt. Absent
   * entirely (legacy callers, tests) means NO gate phase: the pipeline runs
   * byte-for-byte the prior loop. Present with `gates: []` is an explicit empty
   * declaration — the phase still runs and passes trivially so the reviewer's
   * evidence always names the declared source.
   */
  qualityGates?: QualityGatesConfig;
  /** Per-stage limits. Omitted/zero fields preserve unlimited historical behavior. */
  stageLimits?: StageLimits;
  /** Optional role-specific stage-limit overlays, resolved over `stageLimits`. */
  roleStageLimits?: Partial<Record<ProfileRole, StageLimits>>;
  /** Retention and byte limits for all durable state created by this run. */
  projectStoreConfig?: ProjectStoreConfig;
  /** Durable coordinator identity; supply runId to resume an interrupted run. */
  coordinator?: RunCoordinatorOptions;
  activityChannel?: ToolActivityChannel;
  activityConsumer?: ToolActivityConsumer;
  toolActivity?: Partial<ToolActivityConfig>;
  /** Monotonic milliseconds seam for deterministic per-stage durations. */
  monotonicNow?: () => number;
  /** Explicit task purpose that requires the model-inventory Researcher brief. */
  researchPurpose?: ResearchPurpose;
  /** Trusted configurable replacement for the shipped model-inventory brief. */
  researchBrief?: RoleBriefSource;
  observability?: {
    /** Maximum retained read-path sample; zero disables the limit. */
    maxReadPaths?: number;
    /** Maximum UTF-8 bytes per retained path; zero disables the limit. */
    maxReadPathBytes?: number;
  };
}

/**
 * One completed code<->review round: which coder/reviewer runs produced it and
 * the verdict that settled it. Retained for callers that want per-round detail
 * beyond the flattened `PipelineResult`.
 */
export interface RoundRecord {
  round: number;
  coderRunId: string;
  reviewerRunId: string;
  verdict: Verdict;
}

/**
 * The escalation signal a settled run carries when a stop names its reason:
 * the review stop rule (`role_requested` or `blocking_verdicts`) or round-cap
 * exhaustion (`cap_exhausted`). A red gate and an approval carry no signal.
 * `required` names whether the signal mandates the machine decomposition
 * action: `true` for `role_requested` and `blocking_verdicts`, `false` for
 * `cap_exhausted`, which names the limit without classifying the work, so the
 * decomposition lane does not fire on it unasked. `reason` names the settle
 * cause: `role_requested` (a `decomposition_required` verdict),
 * `blocking_verdicts` (a second blocking verdict), or `cap_exhausted` (the
 * code<->review loop reached `maxRounds`); `blockingVerdicts` is the derived
 * count at settle time. Exactly these three keys -- no summary, no issue
 * text, no file content, no provider/model text.
 */
export interface EscalationSignal {
  required: boolean;
  reason: "role_requested" | "blocking_verdicts" | "cap_exhausted";
  blockingVerdicts: number;
}

/**
 * The settled outcome of a whole pipeline run.
 *
 * `outcome: "decomposition_required"` with `approved: false` after
 * `rounds === maxRounds` is a LEGITIMATE result the caller inspects --
 * exhausting the cap is not an error and is never thrown.
 * (A missing or malformed verdict, by contrast, IS a thrown `OrchestrationError`.)
 * `verdicts` and `runIds` are in round order; `runIds` carries every role-run's
 * id (planner, then coder/reviewer per round) for ledger cross-reference.
 */
export interface PipelineResult {
  /** Deterministic terminal meaning; retained alongside `approved` for compatibility. */
  outcome: PipelineOutcome;
  approved: boolean;
  rounds: number;
  verdicts: Verdict[];
  runIds: string[];
  /**
   * The planner's structured complexity tier. `undefined` means there was no
   * planner; a configured planner that omits `submit_plan` fails the run.
   * Present for a later
   * complexity-aware routing follow-on; nothing in this unit reads it.
   */
  complexity?: Complexity;
  /**
   * The planner's structured security surface. `undefined` means there was no
   * planner; omission by a configured planner is a hard failure. `elevated` arms the
   * conditional Security phase; this field reports the submitted value back to
   * the caller regardless of whether that phase ran.
   */
  securitySurface?: SecuritySurface;
  /** Applicable contract rules carried by the planner's structured submission. */
  contractRequirements?: string[];
  /** Safe per-stage resource observations in execution order. */
  stageMetrics: PipelineStageMetrics[];
  /**
   * The LAST declared-gate report (issue #227), when the gate phase ran: the
   * settled run's gate evidence. A red report here explains a non-approved
   * outcome that no verdict explains — the operator reads WHICH blocker
   * fired, red gate versus review, off this field and the verdicts instead
   * of guessing.
   */
  gateReport?: GateReport;
  /**
   * Whether a review actually ran to a settled verdict. `false` names a run
   * that settled (max rounds, red gate, operator stop) WITHOUT any review
   * round: deliberately NOT rendered like "reviewed, no findings" — a run
   * cannot be approved without a review, and the absence is a first-class
   * result here, not a missing verdict field.
   */
  reviewRan?: boolean;
  /**
   * Present when a stop names its reason: the review stop rule
   * (`role_requested` or `blocking_verdicts`, both `required: true`) or
   * round-cap exhaustion (`cap_exhausted`, `required: false`). Absent on
   * approval and a red-gate-only settle.
   */
  escalation?: EscalationSignal;
}

export interface PipelineStageMetrics {
  stage: string;
  /**
   * Paused attempts remain visible so terminal economics include failed work.
   * "closed_out" (issue #327) marks a stage that settled its final response
   * after entering the closeout reserve -- neither an ordinary completion nor
   * a paused attempt.
   */
  status?: "complete" | "paused" | "closed_out";
  /** Structurally published closeout; present only when a reserve was entered. */
  stageCloseout?: StageCloseoutFact;
  /** Canonical public labels; `unknown` when an identifier is unsafe or unavailable. */
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  durationMs?: number;
  input: number;
  cachedInput: number;
  freshInput: number;
  output: number;
  /** Provider-reported subset of output; never estimated. */
  reasoning?: number;
  /** Provider-reported total; never recomputed. */
  costUsd?: number;
  /**
   * Dollars the PROVIDER reported actually billing for this stage (the
   * `ChargeCapture` amount off the wire) -- a different measurement from
   * `costUsd`, which is our price list over tokens. Absent when the provider
   * reported no billed amount, so closeouts state that absence by name rather
   * than printing a zero that reads as a measured amount.
   */
  chargedUsd?: number;
  requestBytes: {
    systemPrompt: number;
    prompt: number;
    toolDefinitions: number;
    total: number;
  };
  readFiles: string[];
  readFilesTotal: number;
  readFilesTruncated: number;
  diffBytes: number;
  /** Attached task brief identity; content and path never enter durable state. */
  roleBrief?: {
    id: string;
    version: string;
    sha256: string;
  };
  /** Digest and redaction counts only; raw patch text is never durable state. */
  diffProjectionSha256?: string;
  diffProjectionBytes?: number;
  diffProjectionRedactedLines?: number;
  contextStrategy: "auto" | "disabled-then-halt";
  /** Context supplied to this pipeline stage; distinct from transcript compaction. */
  pipelineContextStrategy?: PipelineContextSelection;
  /** Stable reason an incremental re-review was widened. */
  pipelineContextFallbackReason?: PipelineContextFallbackReason;
}

/** Accounting snapshot required to continue an interrupted durable role turn. */
export interface StageResumeSnapshot {
  elapsedMs: number;
  modelTurns: number;
  toolTurns: number;
  inputTokens: number;
  lastInputTokens: number;
  costUsd: number;
}

/** A durable role operation that was paused before its stage could settle. */
export interface ActiveWorkflowStage {
  phase: Exclude<WorkflowPhase, "done">;
  step: string;
  runId: string;
  /** Present only after a paused attempt has produced durable accounting. */
  metrics?: PipelineStageMetrics;
  snapshot?: StageResumeSnapshot;
}

export type PipelineContextMode = "incremental" | "full" | "off";
export type PipelineContextSelection = "broad" | "focused" | "full";
export type PipelineContextFallbackReason =
  | "configured_full"
  | "manual_control"
  | "scope_drift"
  | "material_diff"
  | "risk_changed"
  | "insufficient_evidence"
  | "projection_failure"
  | "projection_redacted"
  /** More changed paths than `maxPaths`: a measured ceiling, not a failure (issue #449). */
  | "path_list_truncated";

export interface PipelineContextConfig {
  mode: PipelineContextMode;
  /** Zero disables automatic material-diff escalation. */
  maxFocusedDiffBytes: number;
  /** Mandatory positive ceilings for repository-derived path projections. */
  projection?: PipelineContextProjectionLimits;
}

export interface PipelineContextProjectionLimits {
  maxPaths: number;
  maxPathBytes: number;
  maxAggregateBytes: number;
}

/** Bounded metadata only; raw patches and prompts never enter durable workflow state. */
export interface PipelineContextSnapshot {
  selection: PipelineContextSelection;
  fallbackReason?: PipelineContextFallbackReason;
  changedFiles: string[];
  changedFilesTotal: number;
  /**
   * Paths omitted by the `maxPaths` ceiling -- a real path-list truncation
   * (issue #449). Never a redaction or failure marker.
   */
  changedFilesTruncated: number;
  /** Changed paths that triggered sensitive-path redaction (issue #449), its own fact. */
  redactedPaths?: number;
  /** Untracked files whose projected content was capped by the aggregate ceiling (issue #449). */
  untrackedTruncatedFiles?: number;
  /**
   * True ONLY when a git measurement itself failed (issue #449) -- never set
   * by a ceiling, so a failed measurement can never render as "no changes".
   * Absent in records written before 0.112.0 and read as false.
   */
  projectionFailed?: boolean;
  diffBytes: number;
  /** Bounded digest input used only to notice a changed risk assessment on resume. */
  riskFingerprint?: string;
}

export type PipelineOutcome = "approved" | "decomposition_required";

/**
 * Why an orchestration precondition or a submitted verdict was rejected.
 *
 * - `missing_verdict` / `malformed_verdict`: the reviewer's `submit_verdict`
 *   tool submission was absent (no call) or failed strict validation -- a hard
 *   failure, never a silent pass.
 * - `missing_plan` / `plan_not_json` / `malformed_plan`: the planner omitted
 *   the mandatory governance artifact, answered without a JSON object, or its
 *   submission failed strict validation.
 * - `invalid_max_rounds` / `empty_task`: a caller precondition failed before any
 *   role ran.
 */
/**
 * Char ceilings for the bounded cause fields a pause record may carry.
 *
 * The code ceiling matches the runner's own error-code vocabulary (the longest
 * typed code is far below it); the message ceiling fits the longest
 * harness-authored message a typed error composes (the cost-anomaly block,
 * which embeds provider/model ids and four numbers) with headroom. These are
 * WRITE-side bounds: every pause cause is clipped before it is persisted, so
 * the background event fixture below can upper-bound the serialized event.
 */
export const MAX_PAUSE_CAUSE_CODE_CHARS = 64;
export const MAX_PAUSE_CAUSE_MESSAGE_CHARS = 512;

/**
 * Char ceiling the durable writer (`requiredString` in
 * src/orchestration/background-runs.ts) enforces on every persisted record
 * string -- run ids, owner and worker ids, and the pause `action`, which is
 * the binding case: the longest such string the coordinator composes. This
 * constant is the single source of truth for that limit, so the writer, the
 * action composer (`harnessFailureAction` in
 * src/project-operations/run-coordinator.ts) and the tests all read the same
 * number and move together if it ever changes. The binding risk is a pause
 * whose action exceeds it: durable serialization then rejects the record on
 * read and the pause is no longer clearable (issue #458 review round), so
 * every composed action must fit inside this ceiling by construction.
 */
export const MAX_PERSISTED_STRING_CHARS = 256;

/**
 * The recorded cause of a harness-side stage failure (issue #363).
 *
 * WHY IT EXISTS. The fixed "inspect the provider failure" wording collapsed
 * every non-provider stage failure into one sentence and dropped the cause
 * entirely: an operator (and the retrying stage) could not tell a git-diff
 * measurement failure from a submission refusal from a cost block. The cause
 * names the failing error's own typed code plus its message WHEN that message
 * is harness-authored by construction -- typed harness errors are built in
 * code from fixed phrases and safe tokens, so nothing model- or provider-
 * authored can enter through it. An UNTYPED failure earns a cause too (issue
 * #403): code `untyped_error` with a message built only from the error's
 * constructor name and the first line of its message. That message is
 * UNCONTROLLED text treated as quoted data -- the ceiling and the
 * control-character-then-redact pipeline at the single write side are the
 * accepted residual (non-printable characters are REMOVED first, then
 * credential-like values are redacted, then the clip); it is never semantic
 * filtering, and never provider response bodies beyond that bounded first
 * line. Numbers and codes otherwise, like every pause field.
 */
export interface PipelinePauseCause {
  /** The failing error's own typed code -- a fixed harness token, never free text. */
  code: string;
  /**
   * The failing error's own message, clipped to the ceiling -- visibly for
   * an untyped cause (issue #467): a line longer than the ceiling keeps its
   * head and ends in the fixed `...[clipped]` marker inside the ceiling.
   * For a typed
   * harness error this is its own harness-authored message. For an untyped
   * error the code is the fixed token `untyped_error` and the message is
   * ONLY the bounded, redacted constructor name plus the first message line
   * (uncontrolled text captured as quoted data, never model instructions,
   * never provider response bodies beyond that bounded first line). Two
   * causes sharing the fixed `untyped_error` code are recurrences only when
   * this message is also identical: "same recorded cause, message
   * included".
   */
  message?: string;
  /**
   * How many CONSECUTIVE prior pause records named the same stage and code
   * before this one (0 = first). A recurring identical cause is the loop
   * signature issue #363 asks to make distinguishable from an underestimate.
   */
  recurrence: number;
}

/**
 * The durable pause a coordinator stops on, carried to a background boundary.
 * `phase`/`code`/`action` are the checkpoint's own pause record -- fixed
 * phrases built in code, never model or provider content. `action` is kept
 * within the 256-char ceiling `requiredString`
 * (src/orchestration/background-runs.ts) enforces on every persisted
 * record field, so the action cannot interpolate the bounded cause message
 * itself (which has its own 512-char ceiling). For an untyped stage failure
 * (issue #403) the `action` therefore names only the recorded code token
 * (`untyped_error`) and points the operator at the recorded durable cause;
 * the bounded, redacted message stays in `cause.message`. The research
 * refusal pauses (`unsafe_request`, `research_rejected`, issue #467) follow
 * the same discipline. `limitReason` and
 * `limit` are present exactly when the coordinator recorded limit evidence.
 * `cause` is present exactly when the failing error was a typed harness-side
 * error OR an untyped one (with the fixed `untyped_error` code token, issue
 * #403), or when a research refusal pause settled on one (issue #467), so a
 * harness failure never reads as a provider one.
 */
export interface PipelinePause {
  phase: WorkflowPhase;
  code: string;
  action: string;
  limitReason?: StageLimitReason;
  limit?: number;
  cause?: PipelinePauseCause;
}

/**
 * The workflowState sibling of a pause cause: which stage failed, with which
 * recorded cause, and how many consecutive attempts have failed the same way.
 * `phase` is the failing stage's phase; the rest matches `PipelinePauseCause`
 * so the coordinator can copy one into the other without re-deriving it.
 */
export interface StageFailureRecord extends PipelinePauseCause {
  phase: WorkflowPhase;
}

/**
 * A stage pause reported as a resumable outcome, not a failure (issue #261).
 *
 * WHY A SEPARATE CLASS. A pause had surfaced as `OrchestrationError`
 * (`requirements_unresolved`): the background record then read `failed` /
 * `internal_failure` / `recovery: none` for a state the coordinator itself
 * called `paused`, and the orchestrator could not react -- it could not raise
 * a ceiling it never learned about. Carrying the pause identification plus
 * what the run had already spent (`metrics`, summed from durable stage
 * metrics, paused attempt included) lets every consumer report the pause
 * accurately without re-reading the coordinator record by hand.
 */
export class PipelinePauseError extends Error {
  override readonly name = "PipelinePauseError";
  readonly code = "pipeline_paused" as const;
  /** The coordinator runId; never content. */
  readonly detail: string;

  constructor(
    detail: string,
    readonly pause: PipelinePause,
    readonly metrics: { steps: number; totalCost: number },
  ) {
    super(`${pause.code}: ${pause.action}`);
    this.detail = detail;
  }
}

export type OrchestrationErrorCode =
  | "missing_plan"
  | "plan_not_json"
  | "requirements_unresolved"
  | "missing_verdict"
  | "malformed_verdict"
  | "malformed_plan"
  | "invalid_max_rounds"
  | "empty_task";

/**
 * Raised when an orchestration precondition fails or an untrusted submitted
 * verdict is missing/malformed. Carries a `code` discriminant and a `detail`
 * string holding ONLY the reviewer runId or a number -- never file content,
 * provider messages, or the verdict body. Mirrors `RunnerError`'s house style:
 * numbers and safe tokens, dense WHY in JSDoc, nothing that leaks.
 */
export class OrchestrationError extends Error {
  override readonly name = "OrchestrationError";
  readonly code: OrchestrationErrorCode;
  /** The reviewer runId, or a number rendered as a string. Never content. */
  readonly detail: string;

  constructor(code: OrchestrationErrorCode, detail: string, message: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The phases of the stepped workflow graph, in the order they normally run.
 *
 * `plan` and `security` are conditional (a plan phase only when a planner role
 * is configured; a security phase only on an `elevated` surface WITH a security
 * role). `gates` is conditional (only when `qualityGates` is configured, see
 * `PipelineConfig.qualityGates`) and sits AFTER the coder and BEFORE the
 * reviewer so a red gate returns to the coder with captured output instead of
 * ever reaching review. `code` and `review` alternate for up to `maxRounds`
 * rounds. `done` is the terminal phase -- a state in `done` is never stepped again; its outcome is
 * read via `toPipelineResult`. This enum is the single source of truth for the
 * step graph that used to live as inline control flow inside `runPipeline`.
 */
export type WorkflowPhase = "plan" | "research" | "security" | "code" | "gates" | "review" | "done";

/**
 * The kind of edge a driver can take out of a completed step.
 *
 * - `advance`: move forward along the linear graph (plan->next, security->code,
 *   code->review) or, out of a `changes_requested` review, on to the next code
 *   round.
 * - `rework`: re-run the SAME role for another attempt without moving forward --
 *   from a code phase it re-runs the coder (another `code:N` turn, no review in
 *   between); offered after an `approved` review so a driver can force one more
 *   coder pass. It is NEVER a default transition.
 * - `stop`: settle the run (phase -> `done`). The default on an `approved`
 *   review and on a `changes_requested` review that has exhausted `maxRounds`.
 */
export type TransitionKind = "advance" | "rework" | "stop";

/**
 * One edge a driver may take out of the step that just completed.
 *
 * A `step` returns the FULL set of available transitions with exactly one marked
 * `isDefault` (under the resolved `WorkflowDefaults`); `autoDriver` picks that
 * one, a human/orchestrator driver may pick any. `toPhase`/`toRound` are where
 * the edge leads -- `applyTransition` reads only these two to compute the next
 * state, which is what keeps it a PURE function of `(state, chosen)`.
 */
export interface AvailableTransition {
  kind: TransitionKind;
  isDefault: boolean;
  toPhase: WorkflowPhase;
  toRound: number;
}

/**
 * The explicit, inspectable state of a workflow run BETWEEN steps.
 *
 * This is the value a stepped driver (a human UI, the conversational
 * orchestrator, or `runPipeline`'s auto-driver) threads from one `step` to the
 * next. It carries everything a later phase needs -- the plan summary and the
 * last coder output feed the next prompt; `complexity`/`effective` drive model
 * selection; `verdicts`/`runIds` accumulate the same values the old
 * `PipelineResult` exposed, so `toPipelineResult` can reproduce it exactly.
 * `phase` is the phase the NEXT `step` will run; `done`/`approved` are set by
 * `applyTransition` when a `stop` edge is taken.
 */
export interface WorkflowState {
  phase: WorkflowPhase;
  /** The current code<->review round (1-based); also the label in `code:N`/`review:N`. */
  round: number;
  /** The planner's final text (or `''` with no planner), fed to the round-1 coder. */
  planSummary: string;
  /** Applicable contract rules from the structured planner submission. */
  contractRequirements: string[];
  /** Planner governance artifact retained across code/review and durable resume. */
  surfaceAnalysis?: SurfaceAnalysis;
  /**
   * The files the planner's structured submission named as affected. Injected
   * into the coder's round-1 handoff as framed data; absent or empty means no
   * section, never a failure. Retained for durable resume like its siblings.
   */
  affectedFiles?: string[];
  /** Normalized, bounded research metadata; provider payloads are never retained. */
  researchProvenance?: ResearchProvenance[];
  /** Present only while a coordinator-owned research effect is in flight. */
  researchIntent?: ResearchDispatchIntent;
  /** The most recent coder output, fed to the reviewer that follows it. */
  changeSummary: string;
  /** The planner's structured complexity tier, when it submitted one. */
  complexity?: Complexity;
  /** The planner's structured security surface, when it submitted one. */
  securitySurface?: SecuritySurface;
  /** The security phase's final text (or `''`), threaded into round-1 coder + every reviewer. */
  securityNotes: string;
  /**
   * The complexity every pre-plan role routes on: an explicitly passed tier
   * (the orchestrator's own classification, issues #263/#264) or the declared
   * `routing.defaultComplexity`/built-in `'medium'` fallback. It is never an
   * assessment by itself -- the fallback is a constant nothing validated
   * against the task.
   */
  preComplexity: Complexity;
  /** The complexity every post-plan role routes on (`complexity ?? preComplexity`). */
  effective: Complexity;
  /** Verdicts in round order; `length` is the completed-round count (== result `rounds`). */
  verdicts: Verdict[];
  /** Every role-run's id in run order (planner, security, then coder/reviewer per round). */
  runIds: string[];
  /** Completed-stage observations, retained in stable execution order. */
  stageMetrics?: PipelineStageMetrics[];
  /**
   * The recorded cause of the previous attempt of the CURRENT stage failing
   * (issue #363). Written by the coordinator when a stage failure leaves a
   * resumable pause; read by the next attempt's prompt composition, so a
   * retrying stage converges on the recorded reason instead of repeating an
   * identical rejected submission blind. Cleared by the session when the stage
   * completes. Bounded: fixed code, harness-authored message, recurrence
   * count -- never model or provider text.
   */
  lastStageFailure?: StageFailureRecord;
  /** A paused durable role session, resumed before a new role session is admitted. */
  activeStage?: ActiveWorkflowStage;
  /** Most recent safe handoff decision, retained for deterministic resume. */
  pipelineContext?: PipelineContextSnapshot;
  /**
   * The most recent declared-gate report, in declaration order. Stored so a
   * red report can be handed back to the coder with its captured output and so
   * the settled result names gates as blocking evidence. Outputs are already
   * bounded by the runner's ceiling, so this stays checkpoint-safe.
   */
  lastGateReport?: GateReport;
  /** True once a `stop` edge has settled the run; the driver loop stops stepping. */
  done: boolean;
  /** The settled approval outcome, set by `applyTransition` on a `stop` edge. */
  approved: boolean;
  /** Settled escalation signal, set by the review stop rule or cap exhaustion and carried into `PipelineResult`. */
  escalation?: EscalationSignal;
}

/**
 * What one `step` returns: the state AFTER running the pending role turn (runId
 * appended, verdict/plan recorded, ledger written) but BEFORE any transition is
 * committed, the immediate `result` of the turn for a driver to inspect, and the
 * `transitions` on offer. Committing a transition is a separate, pure
 * `applyTransition(state, chosen)` call -- `step` never advances the phase
 * itself, which is what lets a driver decide.
 */
export interface StepResult {
  state: WorkflowState;
  result: {
    phase: WorkflowPhase;
    runId: string;
    text: string;
    verdict?: Verdict;
    plan?: Plan;
    /** Structured follow-ups captured during this role turn. */
    followUps?: FollowUp[];
  };
  transitions: AvailableTransition[];
}

/**
 * A driver: given the transitions a `step` offers, choose exactly one to commit.
 * `autoDriver` (picks the `isDefault` edge) reproduces `runPipeline`; a stepped
 * UI or the conversational orchestrator supplies its own, e.g. one that pauses
 * on every step or forces a rework.
 */
export type Driver = (transitions: AvailableTransition[]) => AvailableTransition;
