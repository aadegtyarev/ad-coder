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
 * The structured verdict a reviewer writes as a filesystem artifact and the
 * pipeline strictly schema-validates. Structured-and-schema-checked is strictly
 * stronger than parsing free text: `status` must be one of two literals,
 * `issues` an array of validated `VerdictIssue`, `summary` a string. See
 * `verdict.ts` for the validator and the reason the artifact exists (the runner
 * exposes no tool-injection seam, so the reviewer cannot CALL a verdict tool).
 */
export interface Verdict {
  status: VerdictStatus;
  issues: VerdictIssue[];
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
}

/**
 * Why an orchestration precondition or a verdict artifact was rejected.
 *
 * - `missing_verdict` / `malformed_verdict`: the reviewer's artifact was absent
 *   or failed strict schema validation -- a hard failure, never a silent pass.
 * - `invalid_max_rounds` / `empty_task`: a caller precondition failed before any
 *   role ran.
 */
export type OrchestrationErrorCode =
  | "missing_verdict"
  | "malformed_verdict"
  | "invalid_max_rounds"
  | "empty_task";

/**
 * Raised when an orchestration precondition fails or an untrusted verdict
 * artifact is missing/malformed. Carries a `code` discriminant and a `detail`
 * string holding ONLY the offending artifact path or number -- never file
 * content, provider messages, or the verdict body. Mirrors `RunnerError`'s
 * house style: numbers and paths, dense WHY in JSDoc, nothing that leaks.
 */
export class OrchestrationError extends Error {
  override readonly name = "OrchestrationError";
  readonly code: OrchestrationErrorCode;
  /** The offending artifact path, or a number rendered as a string. Never content. */
  readonly detail: string;

  constructor(code: OrchestrationErrorCode, detail: string, message: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
