import * as crypto from "node:crypto";
import * as path from "node:path";
import { ContextCompactionLostError } from "../context/compactor";
import { CostAnomalyBlockedError } from "../economics/cost-anomaly";
import { redactCredentialLike } from "../orchestration/control-plane";
import type { WorkflowSession } from "../orchestration/session";
import {
  applyTransition,
  autoDriver,
  toPipelineResult,
  WorkflowStageFailureError,
  WorkflowStageLimitError,
} from "../orchestration/session";
import {
  ROLE_BY_PHASE,
  STAGE_LIMIT_KEY,
  StageCloseoutError,
  StageLimitError,
  type StageLimitReason,
} from "../orchestration/stage-limits";
import type {
  Driver,
  PipelinePauseCause,
  PipelineResult,
  ResearchDispatchIntent,
  StageFailureRecord,
  StepResult,
  WorkflowPhase,
  WorkflowState,
} from "../orchestration/types";
import {
  MAX_PAUSE_CAUSE_CODE_CHARS,
  MAX_PAUSE_CAUSE_MESSAGE_CHARS,
  MAX_PERSISTED_STRING_CHARS,
  OrchestrationError,
} from "../orchestration/types";
import type { ProjectStore } from "../project-store/project-store";
import type { VersionedState } from "../project-store/types";
import { ProjectStoreError } from "../project-store/types";
import {
  ConfiguredToolsUnavailableError,
  EmptyTurnError,
  ProviderRejectionError,
  ProviderUnavailableError,
  RunnerError,
  SuspendedRunError,
} from "../runner/errors";
import { type BacklogStore, FileBacklogStore } from "./backlog";
import { consolidateFollowUps } from "./consolidate";
import {
  appendDocumentationProposal,
  type DocumentationProposal,
  routeDocumentationFollowUp,
} from "./documentation";
import { ProjectOperationsError } from "./errors";
import { aggregateFollowUps, followUpSemanticId } from "./follow-ups";
import type { FollowUp } from "./types";

export type CoordinatorPhase = "workflow" | "follow-ups" | "decisions" | "closeout" | "complete";
export type DecisionStatus = "pending" | "accepted" | "rejected" | "deferred";

export interface OperatorDecision {
  id: string;
  followUpId: string;
  kind: "contract" | "product";
  status: DecisionStatus;
  authorizationSource?: "operator";
  contractText?: string;
}

export interface ContractReviewRecord {
  decisionId: string;
  status: "pending" | "approved" | "changes_requested" | "decomposition_required";
  runId?: string;
}

export interface CoordinatorCloseout {
  pipeline: PipelineResult;
  followUpIds: string[];
  decisionIds: string[];
}

export interface RunCheckpoint {
  schemaVersion: 1;
  runId: string;
  /** Binds a resumable run to its original task without persisting task contents. */
  taskDigest?: string;
  phase: CoordinatorPhase;
  workflowState: WorkflowState;
  followUps: FollowUp[];
  completedEffects: string[];
  decisions: OperatorDecision[];
  contractReviews: ContractReviewRecord[];
  closeout?: CoordinatorCloseout;
  pendingStep?: StepResult;
  researchEffect?: {
    intent: ResearchDispatchIntent;
    status: "prepared" | "dispatched" | "completed";
  };
  pause?: {
    phase: WorkflowState["phase"];
    code: string;
    action: string;
    limitReason?: StageLimitReason;
    limit?: number;
    cause?: PipelinePauseCause;
  };
}

/**
 * The pause a non-limit stage failure leaves behind.
 *
 * WHY THE CAUSE IS INSPECTED HERE. The checkpoint is often the only thing an
 * operator reads after an unattended run stops, and a fixed "inspect the
 * provider failure" told them nothing about WHICH failure -- a provider that
 * refused a malformed request read exactly like a git-diff measurement that
 * could not run, and the cause itself was dropped entirely (issue #363).
 * `WorkflowStageFailureError` preserves its `sourceError`, so the
 * classification below decides per source:
 *
 * - a provider rejection keeps its own pause and wording (the status is the
 *   diagnosable part and stays in the action),
 * - every typed HARNESS-SIDE error -- the runner's own, an empty turn, a cost
 *   block, unavailable tools, a suspended deferral, a project-operations
 *   rejection such as `invalid_follow_up`, an orchestration precondition, a
 *   stage closeout boundary, a lost context compaction (issue #458) -- is
 *   named AS HARNESS WORK with a bounded `cause`, so the durable record can
 *   say what actually failed and the retrying stage can converge on it,
 * - anything UNTYPED still names itself in durable state (issue #403): a
 *   bounded, redacted cause with the fixed code token `untyped_error`, built
 *   ONLY from the error's constructor name and the first line of its message,
 *   passed through a control-character REMOVAL and credential redaction
 *   BEFORE the char ceiling is applied. The message is uncontrolled text captured as
 *   quoted data for diagnosis (it may be a harness bug rather than a provider
 *   outage); it is never classified as a provider failure.
 *
 * NUMBERS AND CODES ONLY. Typed harness errors are built in code from fixed
 * phrases plus safe tokens (statuses, run ids, paths, counts), so their
 * `code`/`message` are harness-authored by construction and bounded to the
 * char ceilings in orchestration/types.ts. The one exception is the untyped
 * cause's message: it is UNCONTROLLED text (the failing error's constructor
 * and first message line, which may embed provider response fragments), but
 * it is captured as quoted diagnostic data under the same ceilings and after
 * a control-character removal and credential redaction, marked as quoted data
 * both in the pause wording and in the retry-prompt carry-over.
 */
function stageFailurePause(
  phase: WorkflowState["phase"],
  sourceError: unknown,
  priorFailure?: StageFailureRecord,
): { phase: WorkflowState["phase"]; code: string; action: string; cause?: PipelinePauseCause } {
  // The REVIEW stage failing to run is its OWN outcome (issue #227): an
  // operator skimming a generic stage_failed line is exactly how PR #220's
  // unreviewed branch went quiet. Naming it here is what makes a review that
  // did not happen render differently from any other stage failure.
  if (phase === "review") {
    const typedCause = pauseCauseFrom(sourceError, recurrenceOf(priorFailure, phase, sourceError));
    // The same gap #403 closed for the generic `stage_failed` path (review
    // round 4): an unclassified error reaching THIS branch still must name
    // itself in durable state. A provider rejection stays cause-less -- its
    // status already sits in the generic early branch's action and it carries
    // no second surface.
    if (typedCause === undefined && !(sourceError instanceof ProviderRejectionError)) {
      const untypedCause = untypedPauseCause(sourceError);
      const cause = {
        ...untypedCause,
        recurrence: untypedRecurrenceOf(priorFailure, phase, untypedCause),
      };
      // Same 256-char `action` ceiling as the generic stage_failed path (see
      // the untyped branch below): the action names the recorded code and
      // points the operator at the recorded durable cause under
      // `pause.cause`; the message itself stays in `cause.message`.
      return {
        phase,
        code: "review_not_run",
        action:
          cause.recurrence > 0
            ? `the review stage did not run to a verdict with an untyped error (${cause.code}); the same cause has been recorded ${cause.recurrence + 1} consecutive times -- see cause (this may be a harness bug rather than a provider outage), then resume the review explicitly`
            : `the review stage did not run to a verdict with an untyped error (${cause.code}); see the recorded durable cause (this may be a harness bug rather than a provider outage), then resume the review explicitly`,
        cause,
      };
    }
    return {
      phase,
      code: "review_not_run",
      action:
        "the review stage did not run to a verdict; inspect the reviewer's registration and " +
        "configuration, then resume the review explicitly",
      ...(typedCause === undefined ? {} : { cause: typedCause }),
    };
  }
  if (sourceError instanceof ProviderRejectionError) {
    return {
      phase,
      code: "provider_rejected",
      action:
        `the provider rejected the request with HTTP ${sourceError.status}; ` +
        "inspect the request this stage sends (model id, tool schemas, parameters), then retry the stage explicitly",
    };
  }
  // A typed harness-side error keeps its own recorded cause (issue #363).
  const typedCause = pauseCauseFrom(sourceError, recurrenceOf(priorFailure, phase, sourceError));
  if (typedCause === undefined) {
    // An untyped error is uncontrolled text, but the record must still say
    // WHAT failed (issue #403): a bounded constructor + first-line cause with
    // the fixed `untyped_error` code token is persisted, recurrence included so
    // a repeated identical untyped failure shows the loop signature like its
    // typed siblings. The recurrence comparison for an untyped cause requires
    // the recorded MESSAGE to match too -- every untyped error shares the one
    // code token, so code-only comparison would call two different failures a
    // loop (see untypedRecurrenceOf).
    //
    // The `action` MUST stay within the 256-char ceiling that `requiredString`
    // (src/orchestration/background-runs.ts) enforces on every persisted
    // record field, including action. The cause message is clipped to 512
    // chars on the write side, so any action that interpolated the message
    // was already longer than 256 for a 512-char cause -- the background run
    // record and the coordinator checkpoint became unreadable. The action
    // names the recorded code and points the operator at the recorded
    // durable cause under `pause.cause`; the message itself stays in
    // `cause.message`, where its own 512-char ceiling already decodes fine.
    const untypedCause = untypedPauseCause(sourceError);
    const cause = {
      ...untypedCause,
      recurrence: untypedRecurrenceOf(priorFailure, phase, untypedCause),
    };
    return {
      phase,
      code: "stage_failed",
      action:
        cause.recurrence > 0
          ? `the stage failed with an untyped error (${cause.code}); the same cause has been recorded ${cause.recurrence + 1} consecutive times -- see the recorded cause (this may be a harness bug rather than a provider outage), then retry the stage explicitly`
          : `the stage failed with an untyped error (${cause.code}); see the recorded durable cause (this may be a harness bug rather than a provider outage), then retry the stage explicitly`,
      cause,
    };
  }
  return {
    phase,
    code: "stage_failed",
    action: harnessFailureAction(sourceError, typedCause),
    cause: typedCause,
  };
}

/**
 * How many consecutive prior records named the same stage and code. The loop
 * signature issue #363 asks to make distinguishable from an underestimate: a
 * stage_failed pause whose cause keeps repeating is a loop, not a ceiling an
 * operator could raise.
 */
function recurrenceOf(
  prior: StageFailureRecord | undefined,
  phase: WorkflowState["phase"],
  sourceError: unknown,
): number {
  const cause = pauseCauseFrom(sourceError, 0);
  if (cause === undefined) return 0;
  return prior !== undefined && prior.phase === phase && prior.code === cause.code
    ? prior.recurrence + 1
    : 0;
}

/**
 * The recurrence count for an UNTYPED cause, resolved OUTSIDE
 * `pauseCauseFrom` (issue #403): every untyped error shares the fixed code
 * token `untyped_error`, so a code-only comparison would call two unrelated
 * failures a loop. The comparison therefore also requires the recorded
 * message to be identical (the constructor + first-line composition already
 * bounds it); a mismatch -- a different concrete failure -- restarts the
 * count at 0 instead of fabricating a loop signature.
 */
function untypedRecurrenceOf(
  prior: StageFailureRecord | undefined,
  phase: WorkflowState["phase"],
  cause: PipelinePauseCause,
): number {
  return prior !== undefined &&
    prior.phase === phase &&
    prior.code === cause.code &&
    prior.message === cause.message
    ? prior.recurrence + 1
    : 0;
}

/**
 * A constructor name usable inside the untyped cause record: a plain bounded
 * identifier (letters, digits, underscore, dash -- a dash keeps the common
 * HTTP/driver-style class names readable). Anything else -- empty,
 * non-string, whitespace, punctuation, control characters, a message
 * smuggled into a forged name, or an over-length run of text -- is not a
 * class name and gets the fixed token `Unknown` (issue #403 review round;
 * same discipline as the console's `ERROR_CLASS_TOKEN` in src/cli/console.ts,
 * #412).
 */
const PAUSE_CONSTRUCTOR_TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * The fixed marker a visibly clipped untyped cause message ends in (issue
 * #467): when the composed first line exceeds the shared 512-char pause-cause
 * ceiling, the head is kept and this marker is appended WITHIN the ceiling,
 * so a cut is legible in the durable record instead of a silent slice.
 * Printable ASCII only, like every byte of the composed message.
 */
const PAUSE_CAUSE_CLIP_MARKER = "...[clipped]";

/**
 * The bounded, redacted cause an UNTYPED error earns (issue #403), with the
 * fixed code token `untyped_error`. The message is ONLY the error's
 * constructor name plus the first line of its message -- never model text,
 * never a provider response body. The composition is exact and ordered:
 * compose, then REMOVE every character outside printable ASCII (delete, not
 * substitute -- first-line collation alone does not sanitize control bytes;
 * terminal-escape and carriage-return injection otherwise survives, and a
 * substituted `?` could sit inside a credential token and defeat the
 * redaction pattern), then redact credential-like values, and only then clip
 * to the message ceiling -- redacting after the clip could leave a truncated
 * but reconstructible credential prefix on the boundary.
 *
 * The read is HOSTILE-PROOF (review round, mirroring `describeErrorClass` in
 * src/cli/console.ts and the ERROR_CLASS_TOKEN discipline in
 * docs/contracts/errors.md, issue #412): no own property of the thrown value
 * is trusted. The constructor name is read only through the PROTOTYPE chain
 * (`Object.getPrototypeOf`), so a forged own `constructor` cannot inject
 * text into the record, and every hostile read -- the prototype walk, the
 * `constructor` access, the `message` access, the `String` coercion (each
 * can THROW through a Proxy trap or a throwing getter) -- is guarded to
 * yield a fixed fallback instead of crashing the coordinator's catch: the
 * name falls back to `Unknown` when it is absent, refusing, or fails the
 * bounded-identifier check, and the message line falls back to the empty
 * string (line absent from the record) when it cannot be read. Total and
 * deterministic by construction: every input yields a fixed token from a
 * small closed set, never its own output. A first line longer than the
 * ceiling is clipped VISIBLY: the head survives and the fixed
 * `...[clipped]` marker is appended inside the ceiling (issue #467), so the
 * record never drops text without saying so -- and two identical inputs
 * still compose identical messages, which the recurrence comparison needs.
 */
function untypedPauseCause(sourceError: unknown): PipelinePauseCause {
  const composed = `${boundedConstructorName(sourceError)}: ${boundedFirstMessageLine(sourceError)}`;
  // Order (review round 2, issue #403): remove non-printable bytes FIRST so a
  // control byte inside a credential token cannot defeat the redaction
  // pattern, THEN redact, THEN clip. The clip is VISIBLE (issue #467): a
  // first line longer than the ceiling keeps its head and ends in the fixed
  // marker, still within the ceiling, so a cut is always legible in the
  // record instead of a silent slice.
  const stripped = redactCredentialLike(composed.replace(/[^\x20-\x7E]/g, "")).trimEnd();
  const message =
    stripped.length > MAX_PAUSE_CAUSE_MESSAGE_CHARS
      ? `${stripped.slice(0, MAX_PAUSE_CAUSE_MESSAGE_CHARS - PAUSE_CAUSE_CLIP_MARKER.length)}${PAUSE_CAUSE_CLIP_MARKER}`
      : stripped;
  return {
    code: "untyped_error",
    ...(message === "" ? {} : { message }),
    recurrence: 0,
  };
}

/**
 * The constructor name through the PROTOTYPE chain only. An own (or an
 * otherwise overridden) `constructor` property is never read, because it is
 * exactly how a forged name would be supplied; the prototype's constructor
 * is the one the value was actually built by. Every step can throw (a Proxy
 * traps `getPrototypeOf` and each `get`), and every throw -- as well as any
 * non-identifier name -- yields the fixed token `Unknown`.
 */
function boundedConstructorName(sourceError: unknown): string {
  try {
    const prototypeName: unknown = Object.getPrototypeOf(sourceError)?.constructor?.name;
    if (typeof prototypeName === "string" && PAUSE_CONSTRUCTOR_TOKEN.test(prototypeName))
      return prototypeName;
  } catch {
    // A value that refuses the question never names itself.
  }
  return "Unknown";
}

/**
 * The FIRST line of the error's message, guarded per read: the `message`
 * property access and the `String` coercion each can run through a Proxy
 * trap or a getter and THROW, and a throw yields the empty string -- the
 * message line is then simply absent from the record, and the constructor
 * name still names the failure -- instead of crashing the stage-failure
 * catch that is building it.
 */
function boundedFirstMessageLine(sourceError: unknown): string {
  try {
    const raw: unknown = (sourceError as { message?: unknown }).message;
    try {
      return String(raw ?? "").split("\n")[0] ?? "";
    } catch {
      return "";
    }
  } catch {
    return "";
  }
}

/**
 * Copy a recorded pause cause onto the workflowState, so the NEXT attempt of
 * this stage is told why the previous one failed (issue #363). The phase
 * travels with it because the record outlives the pause: the retrying attempt
 * reads it from the checkpoint's workflowState, never from the pause itself.
 */
function recordStageFailure(
  state: WorkflowState,
  phase: WorkflowState["phase"],
  cause: PipelinePauseCause,
): WorkflowState {
  return {
    ...state,
    lastStageFailure: {
      phase,
      code: cause.code,
      ...(cause.message === undefined ? {} : { message: cause.message }),
      recurrence: cause.recurrence,
    },
  };
}

/**
 * The action a typed harness-side failure earns. WHY A BUDGET BOUNDARY CANNOT
 * USE THE GENERIC INSTRUCTION (issue #458): "resolve the recorded cause, then
 * retry the stage explicitly" is advice for a fault the retry itself can
 * clear. A stage closeout boundary is the opposite -- the stage reached the
 * reserve its own ceiling grants the deliverable, so the ceiling an operator
 * RAISES is the remedy -- and a context whose compaction is spent cannot be
 * retried at all: the same prompt against the same session fails the same
 * way, and only reopening the session from its durable state gives the stage
 * a context that can fit. The two boundary errors word their own remedy; the
 * recurrence tail stays the loop signature every other cause already carries
 * (issue #363); every other typed source keeps the generic wording verbatim.
 *
 * THE PERSISTED CEILING (issue #458 review round): the durable writer rejects
 * any persisted record string over `MAX_PERSISTED_STRING_CHARS`
 * (`requiredString`, src/orchestration/background-runs.ts), and the closeout
 * action interpolates two GROWING pieces -- the detail StageLimits composes
 * from the configured limits (valid limits accept Number.MAX_SAFE_INTEGER, so
 * its numbers reach 16 digits each) and the recurrence count, whose digits
 * grow as a loop repeats. The lead-in is therefore dropped ("the stage
 * entered its " -- the reason token opening the action already says what
 * happened), which keeps every composition of valid inputs within the
 * ceiling. If a composition would still not fit, the detail is the ONLY piece
 * that is shortened, and never silently: the head survives and the fixed
 * `...[clipped]` marker is appended inside the parentheses (the same visible
 * clip the untyped cause message uses, issue #467), while the reason, the
 * remedy and the recurrence tail -- the three things the operator needs, and
 * what distinguishes a loop from a raiseable ceiling -- always survive
 * intact. For every valid reason token (the closed four-token union of
 * `StageCloseoutReason`) and every safe-integer count, the room left for the
 * detail stays positive, so the bound is total: the action never exceeds the
 * ceiling, and a pause never fails durable serialization.
 *
 * The SAME budget governs the context-compaction action, and for the same
 * reason (issue #458 second review round): its recurrence tail grows too, and
 * an unbounded composition measured 206 characters without the tail against
 * 264 with it. Both boundary classes therefore compose as head + detail +
 * tail + recurrence tail through ONE rule -- the detail is the only piece a
 * too-long composition may lose, it is cut visibly, and the reason, the remedy
 * and the loop signature survive intact.
 */
function harnessFailureAction(sourceError: unknown, cause: PipelinePauseCause): string {
  const recurrenceSuffix =
    cause.recurrence > 0
      ? `; the same cause has now been recorded ${cause.recurrence + 1} consecutive times`
      : "";
  if (sourceError instanceof StageCloseoutError) {
    const head = `${sourceError.reason} closeout reserve (`;
    const tail = `); raise or disable the ${sourceError.reason} stage ceiling for this role, then resume explicitly`;
    const composed = head + sourceError.detail + tail + recurrenceSuffix;
    if (composed.length <= MAX_PERSISTED_STRING_CHARS) return composed;
    // Deliberate, visible bound (see above): shorten only the detail, keep its
    // head, say so with the marker inside the parentheses. `Math.max` keeps the
    // slice non-negative even for a hostile reason token; for the closed union
    // of real ones the room is always well above zero.
    const roomForDetail = Math.max(
      0,
      MAX_PERSISTED_STRING_CHARS -
        (head.length + tail.length + recurrenceSuffix.length + PAUSE_CAUSE_CLIP_MARKER.length),
    );
    return `${head}${sourceError.detail.slice(0, roomForDetail)}${PAUSE_CAUSE_CLIP_MARKER}${tail}${recurrenceSuffix}`;
  }
  if (sourceError instanceof ContextCompactionLostError) {
    // The same budget as the closeout branch, for the same reason: the
    // recurrence tail grows, so a composition that fits on the first pause can
    // still cross the ceiling on a repeated one (the second review round
    // measured exactly that -- 206 characters without the tail, 264 with it).
    // The conditional aside about WHICH summarizer to choose is this cause's
    // only shorten-able detail: the reason (the context cannot be compacted),
    // the remedy (reopen from durable state) and the tail that turns a fault
    // into a loop signature always survive, and a cut is always visible.
    const head =
      "the stage's context can no longer be compacted; reopen the session from its durable state (";
    const detail = "choosing a different summarizer model when the summarizer itself failed";
    const tail = ") -- retrying the same prompt cannot succeed";
    const composed = head + detail + tail + recurrenceSuffix;
    if (composed.length <= MAX_PERSISTED_STRING_CHARS) return composed;
    const roomForDetail = Math.max(
      0,
      MAX_PERSISTED_STRING_CHARS -
        (head.length + tail.length + recurrenceSuffix.length + PAUSE_CAUSE_CLIP_MARKER.length),
    );
    return `${head}${detail.slice(0, roomForDetail)}${PAUSE_CAUSE_CLIP_MARKER}${tail}${recurrenceSuffix}`;
  }
  return cause.recurrence > 0
    ? `the stage failed inside the harness (${cause.code}); the same cause has now been recorded ` +
        `${cause.recurrence + 1} consecutive times -- resolve it, then retry the stage explicitly`
    : `the stage failed inside the harness (${cause.code}); resolve the recorded cause, then retry the stage explicitly`;
}

/**
 * The bounded cause a typed HARNESS-SIDE error earns, or undefined for any
 * source this discipline will not classify on its own (a provider rejection,
 * whose status already sits in the action; an untyped error, whose bounded
 * redacted cause is built by `untypedPauseCause` instead). The recurrence
 * count is passed in by the caller, which owns the checkpoint comparison
 * (same stage + same code as the previously recorded cause).
 */
function pauseCauseFrom(sourceError: unknown, recurrence: number): PipelinePauseCause | undefined {
  // StageCloseoutError and ContextCompactionLostError are harness-side BUDGET
  // boundaries, not provider faults (issue #458): the first is the reserve a
  // stage's own ceiling grants its deliverable, the second a context the
  // harness's own summarization can no longer fit. Both are built in code from
  // fixed phrases plus safe tokens, so their `code`/`message` satisfy the
  // numbers-and-codes-only discipline above, and the cause travels exactly as
  // `empty_turn` already does.
  const typed =
    sourceError instanceof RunnerError ||
    sourceError instanceof EmptyTurnError ||
    sourceError instanceof ProviderUnavailableError ||
    sourceError instanceof CostAnomalyBlockedError ||
    sourceError instanceof ConfiguredToolsUnavailableError ||
    sourceError instanceof SuspendedRunError ||
    sourceError instanceof ProjectOperationsError ||
    sourceError instanceof OrchestrationError ||
    sourceError instanceof StageCloseoutError ||
    sourceError instanceof ContextCompactionLostError;
  if (!typed) return undefined;
  return {
    code: sourceError.code.slice(0, MAX_PAUSE_CAUSE_CODE_CHARS),
    ...(sourceError.message === ""
      ? {}
      : { message: sourceError.message.slice(0, MAX_PAUSE_CAUSE_MESSAGE_CHARS) }),
    recurrence,
  };
}

export interface RunCoordinatorOptions {
  runId?: string;
  task?: string;
  /** Fail instead of silently creating a new checkpoint for a mistyped resume id. */
  resumeExisting?: boolean;
  decisionLimit?: number;
  checkpointByteLimit?: number;
  /** Required for a non-file backlog authority; the coordinator never falls back. */
  backlogStore?: BacklogStore;
  /** Process-local cooperative cancellation probe; never persisted. */
  interrupted?: () => boolean;
}

export const DEFAULT_RUN_COORDINATOR_OPTIONS = {
  decisionLimit: 0,
  checkpointByteLimit: 0,
} as const;
const MANDATORY_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;

function assertCheckpointSize(
  value: RunCheckpoint,
  configuredLimit: number,
  enforceConfigured = true,
): void {
  const checkpointBytes = Buffer.byteLength(JSON.stringify(value));
  if (checkpointBytes > MANDATORY_CHECKPOINT_MAX_BYTES)
    throw new ProjectOperationsError("resource_limit", "mandatoryCheckpointByteLimit");
  if (enforceConfigured && configuredLimit > 0 && checkpointBytes > configuredLimit)
    throw new ProjectOperationsError("resource_limit", "checkpointByteLimit");
}

export interface CoordinatorRunResult {
  status: "awaiting_decision" | "paused" | "complete";
  checkpoint: RunCheckpoint;
  result?: PipelineResult;
}

export interface DecisionResolution {
  source: "operator";
  action: "accept" | "reject" | "defer";
  contractText?: string;
}

export interface ResearchPauseResolution {
  source: "operator" | "host_config";
  action: "retry";
}

export type CoordinatorDriver = (
  transitions: Parameters<Driver>[0],
) => ReturnType<Driver> | Promise<ReturnType<Driver>>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateContractText(text: unknown, id: string): string {
  if (
    typeof text !== "string" ||
    text.trim() === "" ||
    text !== text.trim() ||
    /[\r\n\0]/.test(text) ||
    text.includes("<!--")
  )
    throw new ProjectOperationsError("invalid_follow_up", id);
  return text;
}

/**
 * The pause codes an explicit operator/host act may clear, shared by every
 * front that implements such an act (the orchestrator's `resume_pipeline`, the
 * CLI's `drive --resume-run`). `resumeStage` below is the authority: this table
 * MUST list exactly the codes its guard accepts from source `operator` or
 * `host_config`, or a front would clear a pause the coordinator refuses to
 * resume -- or refuse one it accepts. The table test in
 * test/project-operations.test.ts drives both sides and fails if they drift.
 */
export const PAUSES_CLEARED_BY_AN_EXPLICIT_ACT = [
  "stage_limit",
  "stage_failed",
  "provider_rejected",
  "interrupted",
  "review_not_run",
  "plan_not_submitted",
  "plan_not_json",
] as const;

export function clearsOnExplicitAct(code: string | undefined): boolean {
  return (
    code !== undefined && (PAUSES_CLEARED_BY_AN_EXPLICIT_ACT as readonly string[]).includes(code)
  );
}

/** Deterministic, non-model owner of workflow progress and project closeout. */
export class RunCoordinator {
  private persisted: VersionedState<RunCheckpoint>;
  private readonly checkpointPath: string;
  private readonly decisionLimit: number;
  private readonly checkpointByteLimit: number;
  private readonly backlogStore: BacklogStore | undefined;
  private readonly interrupted: (() => boolean) | undefined;

  constructor(
    private readonly session: WorkflowSession,
    private readonly store: ProjectStore,
    options: RunCoordinatorOptions = {},
  ) {
    const runId = options.runId ?? crypto.randomUUID();
    this.decisionLimit = options.decisionLimit ?? DEFAULT_RUN_COORDINATOR_OPTIONS.decisionLimit;
    this.checkpointByteLimit =
      options.checkpointByteLimit ?? DEFAULT_RUN_COORDINATOR_OPTIONS.checkpointByteLimit;
    this.backlogStore = options.backlogStore;
    this.interrupted = options.interrupted;
    for (const [name, value] of [
      ["decisionLimit", this.decisionLimit],
      ["checkpointByteLimit", this.checkpointByteLimit],
    ] as const)
      if (!Number.isSafeInteger(value) || value < 0)
        throw new ProjectOperationsError("invalid_config", name);
    this.store.validateId(runId);
    this.checkpointPath = path.join(store.layout.runs, `coordinator-${runId}.json`);
    const taskDigest =
      options.task === undefined
        ? undefined
        : crypto.createHash("sha256").update(options.task).digest("hex");
    try {
      this.persisted = store.readVersionedJson<RunCheckpoint>(this.checkpointPath);
      if (this.persisted.value.schemaVersion !== 1 || this.persisted.value.runId !== runId)
        throw new ProjectOperationsError("invalid_config", runId);
      if (
        taskDigest !== undefined &&
        this.persisted.value.taskDigest !== undefined &&
        this.persisted.value.taskDigest !== taskDigest
      )
        throw new ProjectOperationsError("invalid_config", "resume task does not match checkpoint");
      // Legacy checkpoints predate task binding. The explicit operator resume is
      // the migration boundary: bind once, then reject every later mismatch.
      if (options.resumeExisting && taskDigest !== undefined && !this.persisted.value.taskDigest) {
        this.persisted = store.writeVersionedJson(
          this.checkpointPath,
          { ...this.persisted.value, taskDigest },
          this.persisted.version,
        );
      }
    } catch (error) {
      if (!(error instanceof ProjectStoreError) || error.code !== "not_found") throw error;
      if (options.resumeExisting) throw new ProjectOperationsError("not_found", runId);
      const initial: RunCheckpoint = {
        schemaVersion: 1,
        runId,
        ...(taskDigest === undefined ? {} : { taskDigest }),
        phase: "workflow",
        workflowState: session.initialState(),
        followUps: [],
        completedEffects: [],
        decisions: [],
        contractReviews: [],
      };
      assertCheckpointSize(initial, this.checkpointByteLimit, false);
      this.persisted = store.writeVersionedJson(this.checkpointPath, initial, 0);
    }
  }

  get checkpoint(): RunCheckpoint {
    return clone(this.persisted.value);
  }

  get checkpointFile(): string {
    return this.checkpointPath;
  }

  resumeResearch(resolution: ResearchPauseResolution): void {
    const checkpoint = this.persisted.value;
    if (resolution.source !== "operator" || checkpoint.pause?.phase !== "research")
      throw new ProjectOperationsError("unauthorized_resolution", checkpoint.runId);
    const next = { ...checkpoint };
    delete next.pause;
    if (next.researchEffect?.status === "dispatched")
      next.researchEffect = { intent: next.researchEffect.intent, status: "prepared" };
    this.save(next);
  }

  /** Clear a stage-budget pause after the operator supplies a larger/disabled budget. */
  resumeStage(resolution: ResearchPauseResolution): void {
    const checkpoint = this.persisted.value;
    const pause = checkpoint.pause;
    const pauseCode = pause?.code;
    if (
      (resolution.source !== "operator" && resolution.source !== "host_config") ||
      (pauseCode !== "stage_limit" &&
        pauseCode !== "stage_failed" &&
        // A provider rejection is the same class of pause as `stage_failed` --
        // it is that pause with the cause named -- so it must stay resumable by
        // the same operator act, or naming the cause would cost recoverability.
        pauseCode !== "provider_rejected" &&
        pauseCode !== "interrupted" &&
        // A review that never ran is a red pause like a red gate: the same
        // explicit operator act is what lets the review be attempted again.
        pauseCode !== "review_not_run" &&
        // A plan that never arrived is resumable for the same reason a review
        // that never ran is (issue #315): the stage can be attempted again.
        pauseCode !== "plan_not_submitted" &&
        pauseCode !== "plan_not_json")
    )
      throw new ProjectOperationsError("unauthorized_resolution", checkpoint.runId);
    if (pauseCode !== "stage_limit") {
      const next = { ...checkpoint };
      delete next.pause;
      this.save(next);
      return;
    }
    const reason = pause?.limitReason;
    const priorLimit = pause?.limit;
    if (reason === undefined || priorLimit === undefined)
      throw new ProjectOperationsError("invalid_config", "stage pause lacks limit evidence");
    // One table shared with the orchestrator's raise path: the field checked
    // here and the field written there must be the same one, or a raise would
    // satisfy this check without changing what the stage actually measures.
    const key = STAGE_LIMIT_KEY[reason];
    // ...and the same OBJECT, which is the half this originally missed (#208).
    // A raise lands on the role that ran the paused stage -- the orchestrator
    // raises `planner` when the plan stage exhausts its budget -- so reading the
    // session-wide ceiling saw an unchanged number and refused a correct raise,
    // leaving the run unresumable however large the new ceiling was. Observed
    // live: two resumes with raiseLimit 900000 both rejected against the 180000
    // default. The phase names the role, so nothing extra has to be persisted
    // and checkpoints written before this fix still resolve.
    const pausedRole = ROLE_BY_PHASE[checkpoint.workflowState.phase as WorkflowPhase];
    const roleLimit =
      pausedRole === undefined ? undefined : this.session.roleStageLimits?.[pausedRole]?.[key];
    const resumedLimit = roleLimit ?? this.session.stageLimits?.[key] ?? 0;
    if (resumedLimit !== 0 && resumedLimit <= priorLimit)
      throw new ProjectOperationsError("invalid_config", `unchanged ${reason} stage limit`);
    const next = { ...checkpoint };
    delete next.pause;
    this.save(next);
  }

  private save(value: RunCheckpoint): void {
    assertCheckpointSize(value, this.checkpointByteLimit);
    try {
      this.persisted = this.store.writeVersionedJson(
        this.checkpointPath,
        value,
        this.persisted.version,
      );
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "version_conflict")
        throw new ProjectOperationsError("checkpoint_conflict", value.runId);
      throw error;
    }
  }

  async step(
    driver: CoordinatorDriver = autoDriver,
    onStep?: (result: StepResult) => void | Promise<void>,
  ): Promise<StepResult | undefined> {
    const result = await this.prepareStep();
    if (result === undefined) return undefined;
    await onStep?.(result);
    const chosen = await driver(result.transitions);
    this.commitTransition(chosen);
    return result;
  }

  async prepareStep(): Promise<StepResult | undefined> {
    let checkpoint = this.persisted.value;
    if (checkpoint.phase !== "workflow" || checkpoint.workflowState.done) return undefined;
    if (checkpoint.pause !== undefined) return undefined;
    if (checkpoint.pendingStep !== undefined) return clone(checkpoint.pendingStep);
    if (this.interrupted?.()) {
      this.save({
        ...checkpoint,
        pause: {
          phase: checkpoint.workflowState.phase,
          code: "interrupted",
          action: "resume the interrupted workflow explicitly",
        },
      });
      return undefined;
    }
    if (checkpoint.workflowState.phase === "research") {
      if (checkpoint.researchEffect?.status === "dispatched") {
        this.save({
          ...checkpoint,
          pause: {
            phase: "research",
            code: "ambiguous_dispatch",
            action: "reconcile the provider effect by its effectId, then resume explicitly",
          },
        });
        return undefined;
      }
      if (checkpoint.researchEffect === undefined) {
        let intent: ResearchDispatchIntent | undefined;
        try {
          intent = this.session.prepareResearch?.(checkpoint.workflowState);
        } catch (error) {
          // Issue #467: the failure is uncontrolled text, and the raw message
          // interpolated into `action` made any message over 256 chars
          // UNDECODABLE on round-trip (`requiredString` in
          // src/orchestration/background-runs.ts rejects the whole record) --
          // the same failure mode #403 fixed for the untyped stage action.
          // Same fix shape: the bounded, redacted message lives in the
          // recorded durable cause under `pause.cause`; the action names the
          // pause's code token and the cause's and never carries the message,
          // so it stays within the 256-char ceiling for ANY thrown value.
          const cause = pauseCauseFrom(error, 0) ?? untypedPauseCause(error);
          this.save({
            ...checkpoint,
            pause: {
              phase: "research",
              code: "unsafe_request",
              action: `the research request could not be prepared safely (unsafe_request); see the recorded durable cause (${cause.code}), narrow the request, then resume explicitly`,
              cause,
            },
          });
          return undefined;
        }
        if (intent === undefined) {
          this.save({
            ...checkpoint,
            pause: {
              phase: "research",
              code: "researcher_unavailable",
              action: "configure roles.researcher and resume",
            },
          });
          return undefined;
        }
        this.save({
          ...checkpoint,
          workflowState: { ...checkpoint.workflowState, researchIntent: intent },
          researchEffect: { intent, status: "prepared" },
        });
        checkpoint = this.persisted.value;
      }
      this.save({
        ...checkpoint,
        researchEffect: {
          ...(checkpoint.researchEffect as NonNullable<RunCheckpoint["researchEffect"]>),
          status: "dispatched",
        },
      });
      checkpoint = this.persisted.value;
    }
    let result: StepResult;
    try {
      result = await this.session.step(checkpoint.workflowState);
    } catch (error) {
      if (this.interrupted?.()) {
        this.save({
          ...this.persisted.value,
          pause: {
            phase: checkpoint.workflowState.phase,
            code: "interrupted",
            action: "resume the interrupted workflow explicitly",
          },
        });
        return undefined;
      }
      if (error instanceof StageLimitError) {
        const activePhase = checkpoint.workflowState.phase;
        const resumablePhase =
          activePhase === "plan" ||
          activePhase === "security" ||
          activePhase === "code" ||
          activePhase === "review";
        const failedState =
          error instanceof WorkflowStageLimitError
            ? {
                ...checkpoint.workflowState,
                runIds: [...checkpoint.workflowState.runIds, error.runId],
                stageMetrics: [...(checkpoint.workflowState.stageMetrics ?? []), error.metrics],
                ...(!resumablePhase
                  ? {}
                  : {
                      activeStage: {
                        phase: activePhase,
                        step: error.metrics.stage,
                        runId: error.runId,
                        metrics: error.metrics,
                        ...(error.snapshot === undefined
                          ? {}
                          : {
                              snapshot: {
                                elapsedMs: error.snapshot.elapsedMs,
                                modelTurns: error.snapshot.modelTurns,
                                toolTurns: error.snapshot.toolTurns,
                                inputTokens: error.snapshot.inputTokens,
                                lastInputTokens: error.snapshot.lastInputTokens,
                                costUsd: error.snapshot.costUsd,
                              },
                            }),
                      },
                    }),
              }
            : checkpoint.workflowState;
        this.save({
          ...this.persisted.value,
          workflowState: failedState,
          pause: {
            phase: checkpoint.workflowState.phase,
            code: "stage_limit",
            action: `increase or disable the ${error.reason} stage limit, then resume explicitly`,
            limitReason: error.reason,
            limit: error.limit,
          },
        });
        return undefined;
      }
      if (
        error instanceof WorkflowStageFailureError &&
        checkpoint.workflowState.phase !== "research"
      ) {
        const pause = stageFailurePause(
          checkpoint.workflowState.phase,
          error.sourceError,
          checkpoint.workflowState.lastStageFailure,
        );
        this.save({
          ...this.persisted.value,
          workflowState: {
            ...checkpoint.workflowState,
            runIds: [...checkpoint.workflowState.runIds, error.runId],
            stageMetrics: [...(checkpoint.workflowState.stageMetrics ?? []), error.metrics],
            // The cause reaches the NEXT attempt: the retrying stage reads it
            // from its prompt and converges instead of repeating the identical
            // rejected submission (issue #363). Typed harness-side causes are
            // recorded as-is; an untyped cause arrives bounded and redacted
            // (constructor + first line, code `untyped_error`, issue #403).
            // A provider rejection records nothing: its status already sits
            // in the action and carries no second surface.
            ...(pause.cause === undefined
              ? {}
              : recordStageFailure(
                  checkpoint.workflowState,
                  checkpoint.workflowState.phase,
                  pause.cause,
                )),
          },
          pause,
        });
        return undefined;
      }
      if (
        error instanceof OrchestrationError &&
        (error.code === "missing_verdict" || error.code === "malformed_verdict") &&
        checkpoint.workflowState.phase === "review"
      ) {
        // A verdict the Reviewer could not produce is a RED review, not a
        // missing one: the run pauses with its own code so "review did not
        // happen" never renders like "review ran, no findings", and the
        // explicit operator resume is what re-attempts the review.
        const cause = pauseCauseFrom(
          error,
          recurrenceOf(checkpoint.workflowState.lastStageFailure, "review", error),
        );
        this.save({
          ...checkpoint,
          // A rejected verdict submission is exactly the typed rejection
          // criterion #363(1) names: the retrying reviewer must see WHICH
          // field was refused or it repeats the identical rejected verdict.
          workflowState:
            cause === undefined
              ? checkpoint.workflowState
              : recordStageFailure(checkpoint.workflowState, "review", cause),
          pause: {
            phase: "review",
            code: "review_not_run",
            action: `the review stage did not run (${error.code}); inspect the reviewer's registration and configuration, then resume the review explicitly`,
            ...(cause === undefined ? {} : { cause }),
          },
        });
        return undefined;
      }
      if (
        error instanceof OrchestrationError &&
        // `missing_plan` ONLY: a planner that called the tool with bad data is a
        // different failure, and `malformed_plan` names the field that was
        // refused. Pausing on that would send the operator looking for a planner
        // that never ran instead of at the field to correct -- the same
        // confusion the session's own comment warns about.
        (error.code === "missing_plan" || error.code === "plan_not_json") &&
        checkpoint.workflowState.phase === "plan"
      ) {
        // Same reasoning as the review pause above, for the stage that comes
        // first (issue #315). A planner that spends its handoff attempts without
        // calling `submit_plan` throws here, and with no branch for it the error
        // escaped every handler: the checkpoint kept its pre-stage value, the
        // run never settled, and the `run_pipeline` tool call that started it
        // stayed pending forever. Observed live -- two planner attempts ending
        // `stop` with no tool call, then 48 minutes of silence that looked
        // exactly like work in progress. A pause is recoverable; silence is the
        // one outcome a caller cannot act on.
        const cause = pauseCauseFrom(
          error,
          recurrenceOf(checkpoint.workflowState.lastStageFailure, "plan", error),
        );
        this.save({
          ...checkpoint,
          workflowState:
            cause === undefined
              ? checkpoint.workflowState
              : recordStageFailure(checkpoint.workflowState, "plan", cause),
          pause: {
            phase: "plan",
            code: error.code === "plan_not_json" ? "plan_not_json" : "plan_not_submitted",
            action:
              error.code === "plan_not_json"
                ? "the planner answered in prose without a JSON object (plan_not_json); call submit_plan with the complete required object, then resume the plan explicitly"
                : `the planner did not submit a plan (${error.code}); inspect the planner's registration and configuration, then resume the plan explicitly`,
            ...(cause === undefined ? {} : { cause }),
          },
        });
        return undefined;
      }
      if (checkpoint.workflowState.phase !== "research") throw error;
      const failedState =
        error instanceof WorkflowStageFailureError
          ? {
              ...checkpoint.workflowState,
              runIds: [...checkpoint.workflowState.runIds, error.runId],
              stageMetrics: [...(checkpoint.workflowState.stageMetrics ?? []), error.metrics],
            }
          : checkpoint.workflowState;
      // Issue #467: the same bounded-cause discipline as the untyped stage
      // action (issue #403). The raw message interpolated into `action` made
      // any message over 256 chars UNDECODABLE on round-trip; the wrapper is
      // unwrapped first -- exactly like `stageFailurePause` above -- so the
      // cause names the REAL failure, and the action names the pause's code
      // token and the cause's without ever carrying the message.
      const source = error instanceof WorkflowStageFailureError ? error.sourceError : error;
      const cause = pauseCauseFrom(source, 0) ?? untypedPauseCause(source);
      this.save({
        ...this.persisted.value,
        workflowState: failedState,
        pause: {
          phase: "research",
          code: "research_rejected",
          action: `the research stage failed (research_rejected); see the recorded durable cause (${cause.code}), inspect and retry the research response explicitly`,
          cause,
        },
      });
      return undefined;
    }
    const followUps = consolidateFollowUps(
      aggregateFollowUps(
        [...checkpoint.followUps, ...(result.result.followUps ?? [])],
        this.store.projectOperations,
      ),
      this.store.projectOperations,
    );
    const contractReviews =
      result.result.verdict?.status === "approved"
        ? checkpoint.contractReviews.map((record) =>
            record.status === "changes_requested"
              ? { ...record, status: "approved" as const, runId: result.result.runId }
              : record,
          )
        : checkpoint.contractReviews;
    const completedResearch =
      checkpoint.workflowState.phase === "research" ? checkpoint.researchEffect : undefined;
    this.save({
      ...checkpoint,
      followUps,
      contractReviews,
      pendingStep: result,
      ...(completedResearch !== undefined && {
        researchEffect: { intent: completedResearch.intent, status: "completed" as const },
        completedEffects: [
          ...new Set([...checkpoint.completedEffects, completedResearch.intent.effectId]),
        ].sort(),
      }),
    });
    return clone(result);
  }

  commitTransition(chosen: ReturnType<Driver>): WorkflowState {
    const checkpoint = this.persisted.value;
    const pending = checkpoint.pendingStep;
    if (pending === undefined) throw new ProjectOperationsError("invalid_transition", chosen.kind);
    const offered = pending.transitions.find(
      (transition) =>
        transition.kind === chosen.kind &&
        transition.toPhase === chosen.toPhase &&
        transition.toRound === chosen.toRound,
    );
    if (offered === undefined) throw new ProjectOperationsError("invalid_transition", chosen.kind);
    const workflowState = applyTransition(pending.state, offered);
    const next: RunCheckpoint = {
      ...checkpoint,
      workflowState,
      phase: workflowState.done ? "follow-ups" : "workflow",
    };
    delete next.pendingStep;
    this.save(next);
    if (workflowState.done) {
      this.processFollowUps();
      if (this.persisted.value.phase === "closeout") this.closeout();
    }
    return clone(workflowState);
  }

  private recordEffect(checkpoint: RunCheckpoint, key: string): void {
    if (checkpoint.completedEffects.includes(key)) return;
    this.save({
      ...checkpoint,
      completedEffects: [...checkpoint.completedEffects, key].sort(),
    });
  }

  private ensureDecision(followUp: FollowUp, kind: OperatorDecision["kind"]): void {
    const checkpoint = this.persisted.value;
    const followUpId = followUpSemanticId(followUp);
    const id = crypto
      .createHash("sha256")
      .update(`decision:${followUpId}`)
      .digest("hex")
      .slice(0, 32);
    if (checkpoint.decisions.some((decision) => decision.id === id)) return;
    if (this.decisionLimit > 0 && checkpoint.decisions.length >= this.decisionLimit)
      throw new ProjectOperationsError("resource_limit", "decisionLimit");
    this.save({
      ...checkpoint,
      decisions: [...checkpoint.decisions, { id, followUpId, kind, status: "pending" }],
    });
  }

  private processFollowUps(): void {
    let checkpoint = this.persisted.value;
    if (checkpoint.phase !== "follow-ups") return;
    for (const followUp of checkpoint.followUps) {
      const id = followUpSemanticId(followUp);
      const effect = `follow-up:${id}`;
      if (this.persisted.value.completedEffects.includes(effect)) continue;
      if (followUp.kind === "contract") {
        this.ensureDecision(followUp, "contract");
        this.recordEffect(this.persisted.value, effect);
        continue;
      }
      if (followUp.kind === "backlog") {
        const backlog =
          this.backlogStore ??
          (this.store.projectOperations.backlogBackend === "github"
            ? undefined
            : new FileBacklogStore(this.store));
        if (backlog === undefined)
          throw new ProjectOperationsError("github_unavailable", "backlogStore");
        try {
          backlog.create(followUp, id.slice(0, 32));
        } catch (error) {
          if (!(error instanceof ProjectStoreError) || error.code !== "version_conflict")
            throw error;
          backlog.get(id.slice(0, 32));
        }
        this.recordEffect(this.persisted.value, effect);
        continue;
      }
      try {
        const proposal = routeDocumentationFollowUp(
          this.store.layout.targetDir,
          followUp,
          this.store.projectOperations,
        );
        appendDocumentationProposal(proposal, id);
        this.recordEffect(this.persisted.value, effect);
      } catch (error) {
        if (!(error instanceof ProjectOperationsError) || error.code !== "unsafe_destination")
          throw error;
        this.ensureDecision(followUp, "product");
        this.recordEffect(this.persisted.value, effect);
      }
    }
    checkpoint = this.persisted.value;
    this.save({ ...checkpoint, phase: checkpoint.decisions.length > 0 ? "decisions" : "closeout" });
  }

  private acceptedContractProposal(followUp: FollowUp, text: string): DocumentationProposal {
    const routed = routeDocumentationFollowUp(
      this.store.layout.targetDir,
      followUp,
      this.store.projectOperations,
    );
    return { ...routed, content: `- ${text}\n` };
  }

  async resolveDecision(id: string, resolution: DecisionResolution): Promise<void> {
    if (resolution.source !== "operator")
      throw new ProjectOperationsError("unauthorized_resolution", id);
    let checkpoint = this.persisted.value;
    const index = checkpoint.decisions.findIndex((decision) => decision.id === id);
    const current = checkpoint.decisions[index];
    if (current === undefined) throw new ProjectOperationsError("not_found", id);
    if (
      current.status !== "pending" &&
      !(current.status === "accepted" && current.kind === "contract")
    )
      return;
    const next: OperatorDecision =
      current.status === "pending"
        ? {
            ...current,
            status:
              resolution.action === "accept"
                ? "accepted"
                : resolution.action === "reject"
                  ? "rejected"
                  : "deferred",
            authorizationSource: "operator",
          }
        : current;
    if (resolution.action === "accept" && current.kind === "contract")
      next.contractText = validateContractText(resolution.contractText, id);
    if (current.status === "pending") {
      const decisions = [...checkpoint.decisions];
      decisions[index] = next;
      this.save({ ...checkpoint, decisions });
    }
    if (next.status !== "accepted" || next.kind !== "contract") return;

    checkpoint = this.persisted.value;
    const followUp = checkpoint.followUps.find(
      (item) => followUpSemanticId(item) === next.followUpId,
    );
    if (followUp === undefined || followUp.kind !== "contract")
      throw new ProjectOperationsError("not_found", next.followUpId);
    const contractText = next.contractText as string;
    appendDocumentationProposal(
      this.acceptedContractProposal(followUp, contractText),
      `contract-${id}`,
    );
    const state: WorkflowState = {
      ...checkpoint.workflowState,
      contractRequirements: [
        ...new Set([...checkpoint.workflowState.contractRequirements, contractText]),
      ],
      done: false,
      approved: false,
      phase: "review",
    };
    const contractReviews = checkpoint.contractReviews.some((record) => record.decisionId === id)
      ? checkpoint.contractReviews
      : [
          ...checkpoint.contractReviews,
          { decisionId: id, status: "pending" } as ContractReviewRecord,
        ];
    this.save({
      ...checkpoint,
      workflowState: state,
      contractReviews,
    });
    const review = await this.session.reviewCurrent(state);
    const verdict = review.result.verdict;
    if (verdict === undefined) throw new ProjectOperationsError("unresolved_review", id);
    const reviewRecord: ContractReviewRecord = {
      decisionId: id,
      status: verdict.status,
      runId: review.result.runId,
    };
    const reviews = this.persisted.value.contractReviews.map((record) =>
      record.decisionId === id ? reviewRecord : record,
    );
    const followUps = consolidateFollowUps(
      aggregateFollowUps(
        [...this.persisted.value.followUps, ...(review.result.followUps ?? [])],
        this.store.projectOperations,
      ),
      this.store.projectOperations,
    );
    if (verdict.status === "approved") {
      this.save({
        ...this.persisted.value,
        workflowState: { ...review.state, phase: "done", done: true, approved: true },
        contractReviews: reviews,
        followUps,
        phase: "follow-ups",
      });
      return;
    }
    const advance = review.transitions.find((transition) => transition.toPhase === "code");
    if (advance === undefined) {
      this.save({
        ...this.persisted.value,
        workflowState: review.state,
        contractReviews: reviews,
        followUps,
      });
      throw new ProjectOperationsError("unresolved_review", id);
    }
    this.save({
      ...this.persisted.value,
      workflowState: applyTransition(review.state, advance),
      contractReviews: reviews,
      followUps,
      phase: "workflow",
    });
  }

  private closeout(): CoordinatorRunResult {
    const checkpoint = this.persisted.value;
    if (checkpoint.closeout !== undefined)
      return {
        status: "complete",
        checkpoint: clone(checkpoint),
        result: checkpoint.closeout.pipeline,
      };
    const pending = checkpoint.decisions.filter((decision) => decision.status === "pending");
    if (pending.length > 0) return { status: "awaiting_decision", checkpoint: clone(checkpoint) };
    if (!checkpoint.workflowState.done)
      return { status: "awaiting_decision", checkpoint: clone(checkpoint) };
    if (checkpoint.contractReviews.some((record) => record.status !== "approved"))
      throw new ProjectOperationsError("unresolved_review", checkpoint.runId);
    const pipeline = toPipelineResult(checkpoint.workflowState);
    const closeout: CoordinatorCloseout = {
      pipeline,
      followUpIds: checkpoint.followUps.map(followUpSemanticId).sort(),
      decisionIds: checkpoint.decisions.map((decision) => decision.id).sort(),
    };
    const complete: RunCheckpoint = { ...checkpoint, phase: "complete", closeout };
    this.save(complete);
    return { status: "complete", checkpoint: clone(this.persisted.value), result: pipeline };
  }

  async run(
    driver: CoordinatorDriver = autoDriver,
    onStep?: (result: StepResult) => void | Promise<void>,
  ): Promise<CoordinatorRunResult> {
    while (this.persisted.value.phase === "workflow") {
      const stepped = await this.step(driver, onStep);
      if (stepped === undefined && this.persisted.value.pause !== undefined)
        return { status: "paused", checkpoint: this.checkpoint };
    }
    if (this.persisted.value.phase === "follow-ups") this.processFollowUps();
    if (this.persisted.value.phase === "decisions") {
      for (const decision of this.persisted.value.decisions) {
        if (
          decision.status === "accepted" &&
          decision.kind === "contract" &&
          !this.persisted.value.contractReviews.some(
            (record) => record.decisionId === decision.id && record.status === "approved",
          )
        )
          await this.resolveDecision(decision.id, {
            source: "operator",
            action: "accept",
            ...(decision.contractText !== undefined && { contractText: decision.contractText }),
          });
      }
      const resumedPhase: CoordinatorPhase = this.checkpoint.phase;
      if (resumedPhase === "follow-ups") this.processFollowUps();
      if (resumedPhase === "workflow") return this.run(driver, onStep);
      const pending = this.persisted.value.decisions.some(
        (decision) => decision.status === "pending",
      );
      if (pending) return { status: "awaiting_decision", checkpoint: this.checkpoint };
      this.save({ ...this.persisted.value, phase: "closeout" });
    }
    return this.closeout();
  }
}

export function createRunCoordinator(
  session: WorkflowSession,
  store: ProjectStore,
  options: RunCoordinatorOptions = {},
): RunCoordinator {
  return new RunCoordinator(session, store, options);
}
