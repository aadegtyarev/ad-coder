import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { LedgerSink } from "../ledger/ledger";
import type { Profile, ProfileRole, SpawnOverride } from "../profiles/types";
import type { ResolvedRegistry } from "../registry/types";
import type { Role } from "../role";

/**
 * The two verdicts a reviewer round can settle on.
 *
 * `approved` ends the loop; `changes_requested` feeds the reviewer's issues
 * back to the coder for another round. There is deliberately NO third
 * "error"/"unknown" state: a verdict that cannot be parsed into one of these
 * two literals is a hard `OrchestrationError`, not a silent non-approval, so a
 * malformed artifact can never be read as a pass.
 */
export type VerdictStatus = "approved" | "changes_requested";

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
  what: string;
}

/**
 * The structured verdict a reviewer submits via the `submit_verdict` tool call
 * and the pipeline strictly re-validates. Structured-and-schema-checked is
 * strictly stronger than parsing free text: `status` must be one of two
 * literals, `issues` an array of validated `VerdictIssue`, `summary` a string.
 * The tool's TypeBox `parameters` schema is deliberately permissive at the enum
 * leaves so `parseVerdict` in `verdict.ts` stays the authoritative gate -- see
 * that module for the validator.
 */
export interface Verdict {
  status: VerdictStatus;
  issues: VerdictIssue[];
  summary: string;
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

/**
 * The structured plan a planner submits via the `submit_plan` tool call and the
 * pipeline strictly re-validates. Structured-and-schema-checked is stronger than
 * parsing the free-text plan: `complexity` must be one of three literals,
 * `securitySurface` one of three literals, and `summary` a string. UNLIKE the
 * verdict, the plan is SOFT -- an absent `submit_plan` call leaves
 * `PipelineResult.complexity` undefined and the run proceeds on the free-text
 * plan; only a MALFORMED submission is a hard failure. The tool's TypeBox
 * `parameters` schema is deliberately permissive at the enum leaves so
 * `parsePlan` in `plan.ts` stays the authoritative gate.
 */
export interface Plan {
  complexity: Complexity;
  securitySurface: SecuritySurface;
  summary: string;
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
 * `defaultComplexity` (default `'medium'`) does double duty: it routes the
 * PRE-complexity roles -- the planner, whose model must be chosen before the
 * plan reveals a complexity -- AND it is the fallback for every later role when
 * the planner never submits a complexity (an absent `submit_plan` is a SOFT
 * signal, not an error). A profile's planner (pre-complexity) row should
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
  roles: {
    planner?: RoleSpec;
    coder: RoleSpec;
    reviewer: RoleSpec;
    /**
     * OPTIONAL threat-modelling role. The conditional Security phase runs only
     * when the planner's `securitySurface` is `elevated` AND this role is
     * present; absent, an elevated surface is skipped (a quiet stderr note) and
     * the run proceeds. It reads the plan/tree only -- no write/edit/submit.
     */
    security?: RoleSpec;
  };
  ledgerSink?: LedgerSink;
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
 * The settled outcome of a whole pipeline run.
 *
 * `approved: false` after `rounds === maxRounds` is a LEGITIMATE result the
 * caller inspects -- exhausting the cap is not an error and is never thrown.
 * (A missing or malformed verdict, by contrast, IS a thrown `OrchestrationError`.)
 * `verdicts` and `runIds` are in round order; `runIds` carries every role-run's
 * id (planner, then coder/reviewer per round) for ledger cross-reference.
 */
export interface PipelineResult {
  approved: boolean;
  rounds: number;
  verdicts: Verdict[];
  runIds: string[];
  /**
   * The planner's structured complexity tier, when it called `submit_plan`.
   * `undefined` means there was no planner, or the planner ran but never called
   * `submit_plan` -- a SOFT signal, absence is not an error (a MALFORMED call,
   * by contrast, is a thrown `malformed_plan`). Present for a later
   * complexity-aware routing follow-on; nothing in this unit reads it.
   */
  complexity?: Complexity;
  /**
   * The planner's structured security surface, when it called `submit_plan`.
   * `undefined` means there was no planner, or the planner ran but never called
   * `submit_plan` -- a SOFT signal, absence is not an error (a MALFORMED call,
   * by contrast, is a thrown `malformed_plan`). `elevated` is what arms the
   * conditional Security phase; this field reports the submitted value back to
   * the caller regardless of whether that phase ran.
   */
  securitySurface?: SecuritySurface;
}

/**
 * Why an orchestration precondition or a submitted verdict was rejected.
 *
 * - `missing_verdict` / `malformed_verdict`: the reviewer's `submit_verdict`
 *   tool submission was absent (no call) or failed strict validation -- a hard
 *   failure, never a silent pass.
 * - `malformed_plan`: the planner's `submit_plan` submission failed strict
 *   validation (bad `complexity` literal or non-string `summary`) -- a hard
 *   failure. There is deliberately NO `missing_plan`: an ABSENT plan is a SOFT
 *   undefined-complexity, not an error, because complexity is an optimization
 *   signal the run does not need for correctness.
 * - `invalid_max_rounds` / `empty_task`: a caller precondition failed before any
 *   role ran.
 */
export type OrchestrationErrorCode =
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
 * role). `code` and `review` alternate for up to `maxRounds` rounds. `done` is
 * the terminal phase -- a state in `done` is never stepped again; its outcome is
 * read via `toPipelineResult`. This enum is the single source of truth for the
 * step graph that used to live as inline control flow inside `runPipeline`.
 */
export type WorkflowPhase = "plan" | "security" | "code" | "review" | "done";

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
  /** The most recent coder output, fed to the reviewer that follows it. */
  changeSummary: string;
  /** The planner's structured complexity tier, when it submitted one. */
  complexity?: Complexity;
  /** The planner's structured security surface, when it submitted one. */
  securitySurface?: SecuritySurface;
  /** The security phase's final text (or `''`), threaded into round-1 coder + every reviewer. */
  securityNotes: string;
  /** The complexity every pre-plan role routes on (routing.defaultComplexity ?? 'medium'). */
  preComplexity: Complexity;
  /** The complexity every post-plan role routes on (`complexity ?? preComplexity`). */
  effective: Complexity;
  /** Verdicts in round order; `length` is the completed-round count (== result `rounds`). */
  verdicts: Verdict[];
  /** Every role-run's id in run order (planner, security, then coder/reviewer per round). */
  runIds: string[];
  /** True once a `stop` edge has settled the run; the driver loop stops stepping. */
  done: boolean;
  /** The settled approval outcome, set by `applyTransition` on a `stop` edge. */
  approved: boolean;
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
