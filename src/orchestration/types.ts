import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { LedgerSink } from "../ledger/ledger";
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
