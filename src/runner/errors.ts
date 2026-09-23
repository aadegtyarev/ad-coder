import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Why a targetDir was rejected. A discriminant the caller can branch on. */
export type RunnerErrorCode =
  | "missing"
  | "not_found"
  | "not_a_directory"
  | "invalid_run_id"
  | "unsafe_ledger_dir"
  | "tool_name_collision"
  | "diff_metric_failed";

/** A provider settled a failed turn without usable assistant output. */
export class EmptyTurnError extends Error {
  override readonly name = "EmptyTurnError";
  readonly code = "empty_turn" as const;
  /**
   * The HTTP status the PROVIDER reported for the empty turn, when its failure
   * message carried it in one of the anchored shapes below. RECORDING, not
   * classification: unlike `providerRejectionStatusFrom` the full 400..599
   * range is accepted, because this field answers "what did the provider
   * report" -- it never moves a class boundary (#356 owns those). Bounded
   * unconditionally in the constructor so the projection allow-list audit can
   * name it.
   */
  readonly providerStatus: number | undefined;
  /**
   * The provider's OWN bounded error code token (`[A-Za-z0-9_.-]{1,64}`),
   * distinct from `providerCode`, which carries the HARNESS composed code
   * (e.g. `assistant_error`). Keeping the two apart is what lets an operator
   * tell "the harness emptied the turn" from "the provider said insufficient
   * credits" -- the confusion at the heart of #418.
   */
  readonly providerErrorCode: string | undefined;

  constructor(
    readonly runId: string,
    /** The bounded, harness-authored failure code that emptied the turn, when one exists. */
    readonly providerCode?: string,
    /** The provider-reported HTTP status, recording-only, bounded 400..599. */
    providerStatus?: number,
    /** The provider's own strict-charset error code token, when one was extractable. */
    providerErrorCode?: string,
  ) {
    // Every carried field is bounded HERE, at the single point the projection
    // allow-list audit (orchestrator safeErrorText) can name: a non-integer or
    // out-of-range status and a non-token code are DROPPED, never truncated
    // and never thrown about -- the classification does not depend on them.
    const boundedStatus =
      typeof providerStatus === "number" &&
      Number.isSafeInteger(providerStatus) &&
      providerStatus >= 400 &&
      providerStatus <= 599
        ? providerStatus
        : undefined;
    const boundedProviderErrorCode =
      providerErrorCode !== undefined && PROVIDER_ERROR_CODE_BOUND.test(providerErrorCode)
        ? providerErrorCode
        : undefined;
    const credentialed =
      boundedStatus === undefined || boundedStatus === 401 || boundedStatus === 403;
    // The 2026-09-19 boundary is preserved verbatim: absent a non-credential
    // provider status, the message is exactly today's. With one, the message
    // must NOT repeat the credential advice: `auth status` already answers
    // that question, and a 402 billing refusal sent to check the key kept the
    // cause undiagnosable (#418). The rewrite splices ONLY bounded values --
    // no provider prose, never the response body.
    super(
      credentialed
        ? `the provider returned a failed empty turn; verify authentication and retry` +
            `${providerCode !== undefined ? ` (provider code ${providerCode})` : ""}`
        : `the provider returned a failed empty turn with HTTP ${boundedStatus as number}` +
            `${providerCode !== undefined ? ` (provider code ${providerCode})` : ""}` +
            `${boundedProviderErrorCode !== undefined ? ` (provider error code ${boundedProviderErrorCode})` : ""}` +
            `; check the provider account for HTTP ${boundedStatus as number} and retry`,
    );
    this.providerStatus = boundedStatus;
    this.providerErrorCode = boundedProviderErrorCode;
  }
}

/**
 * A strict-charset provider error-code token; anything else is dropped, never
 * truncated (`docs/contracts/errors.md`, 2026-09-19 issue #418). Exported as
 * the CANONICAL bound: every other boundary that renders a typed `code` into a
 * bounded line reuses this one instead of inventing a second bound (the wake
 * drain in `src/orchestration/wake.ts`).
 */
export const PROVIDER_ERROR_CODE_BOUND = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * pi-agent-core exhausted its own provider retry policy without receiving a
 * provider status, error token, assistant text, or usage.  Its
 * `assistant_error` label is an envelope code, not evidence that credentials
 * failed.  Keep this separate from `EmptyTurnError`, which owns the
 * credential-classified 401/403 and genuine empty-answer paths.
 */
export class ProviderUnavailableError extends Error {
  override readonly name = "ProviderUnavailableError";
  readonly code = "provider_unavailable" as const;
  readonly retryable = true as const;
  /** Authored diagnostic code extracted from a known SDK error shape, if any. */
  readonly diagnosticCode: ProviderFailureDiagnostic | undefined;

  constructor(
    readonly runId: string,
    diagnosticCode?: ProviderFailureDiagnostic,
  ) {
    const boundedDiagnostic =
      diagnosticCode !== undefined && PROVIDER_FAILURE_DIAGNOSTICS.has(diagnosticCode)
        ? diagnosticCode
        : undefined;
    super(
      "the provider operation failed without a usable answer or HTTP status" +
        (boundedDiagnostic === undefined ? "" : ` (diagnostic ${boundedDiagnostic})`) +
        "; retry the run, or select another configured model or provider",
    );
    this.diagnosticCode = boundedDiagnostic;
  }
}

/**
 * Provider text is uncontrolled: SDKs can append response bodies, URLs, and
 * echoed request values. Only a fixed code for a recognisable SDK transport
 * or finish-reason shape may leave this boundary. No substring of the source
 * message is copied into a diagnostic.
 */
export type ProviderFailureDiagnostic =
  | "fetch_failed"
  | "connection_reset"
  | "connection_refused"
  | "connection_timeout"
  | "dns_unavailable"
  | "response_timeout"
  | "response_body_missing"
  | "response_incomplete"
  | "provider_network_error"
  | "provider_content_filter";

const PROVIDER_FAILURE_DIAGNOSTICS = new Set<ProviderFailureDiagnostic>([
  "fetch_failed",
  "connection_reset",
  "connection_refused",
  "connection_timeout",
  "dns_unavailable",
  "response_timeout",
  "response_body_missing",
  "response_incomplete",
  "provider_network_error",
  "provider_content_filter",
]);

export function providerFailureDiagnosticFrom(
  error: unknown,
): ProviderFailureDiagnostic | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return undefined;
  if (/^(?:TypeError: )?fetch failed$/.test(message)) return "fetch_failed";
  if (/\b(?:ECONNRESET|UND_ERR_SOCKET)\b/.test(message)) return "connection_reset";
  if (/\bECONNREFUSED\b/.test(message)) return "connection_refused";
  if (/\b(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/.test(message)) return "connection_timeout";
  if (/\b(?:ENOTFOUND|EAI_AGAIN)\b/.test(message)) return "dns_unavailable";
  if (/\bUND_ERR_HEADERS_TIMEOUT\b/.test(message)) return "response_timeout";
  if (message === "No response body") return "response_body_missing";
  if (message === "Stream ended without finish_reason") return "response_incomplete";
  if (message === "Provider finish_reason: network_error") return "provider_network_error";
  if (message === "Provider finish_reason: content_filter") return "provider_content_filter";
  return undefined;
}

/**
 * Match only pi-agent-core's generic settled envelope after every owned
 * provider class has been checked. A status or a bounded provider token is
 * evidence that belongs to `EmptyTurnError`'s existing projection instead.
 */
export function isStatuslessAssistantError(
  harnessCode: unknown,
  cause: ProviderErrorCause | undefined,
  hasZeroUsage: boolean,
): boolean {
  return harnessCode === "assistant_error" && cause === undefined && hasZeroUsage;
}

/** A failed assistant turn is unbilled only when every reported usage field is zero. */
export function hasZeroAssistantUsage(
  usage:
    | {
        input?: number;
        cacheRead?: number;
        cacheWrite?: number;
        output?: number;
        reasoning?: number;
        cost?: { total?: number };
      }
    | undefined,
): boolean {
  return (
    (usage?.input ?? 0) === 0 &&
    (usage?.cacheRead ?? 0) === 0 &&
    (usage?.cacheWrite ?? 0) === 0 &&
    (usage?.output ?? 0) === 0 &&
    (usage?.reasoning ?? 0) === 0 &&
    (usage?.cost?.total ?? 0) === 0
  );
}

/**
 * A provider response settled as a deferred suspension instead of a settled
 * turn: the conveniences this boundary serves (single-turn `runRole`, one
 * workflow step) do not resume deferrals.
 *
 * WHY A TYPED CLASS. This failure used to be a bare `Error` with a run id in
 * its text, so -- until the errors boundary learns to trust it -- it collapsed
 * into the generic internal-error string (#236: an intermittent failure whose
 * cause stayed invisible while `safeErrorText` swallowed every unrecognised
 * error). An intermittent deferral reads exactly like an `EmptyTurnError` from
 * the outside; typing it is what makes `retry succeeded after a delay`
 * diagnosable instead of anecdotal.
 */
export class SuspendedRunError extends Error {
  override readonly name = "SuspendedRunError";
  readonly code = "suspended" as const;

  constructor(readonly runId: string) {
    super(
      `run ${runId} suspended; deferred provider response is not resumed by this call; ` +
        "retry the call, or resume the run through its runner",
    );
  }
}

/**
 * A provider REFUSED the request before running the model, naming an HTTP
 * status.
 *
 * WHY A SEPARATE TYPE FROM `EmptyTurnError`. Both settle with empty assistant
 * text and zero usage, so the runner cannot tell them apart from the transcript
 * alone -- and collapsing them told the operator to "verify authentication"
 * when a 400 over a malformed tool schema had nothing to do with credentials.
 * The errors contract requires provider rejection and missing credentials to
 * stay distinguishable, so the settled status is what separates them: a status
 * present means the provider answered and refused, and an answer is not a
 * credential problem.
 *
 * CARRIES A NUMBER, NEVER A BODY. Only the numeric status crosses this
 * boundary. The provider's response body is uncontrolled text the contract
 * forbids propagating into an error, so it is read for the status and dropped.
 */
export class ProviderRejectionError extends Error {
  override readonly name = "ProviderRejectionError";
  readonly code = "provider_rejected" as const;

  constructor(
    readonly runId: string,
    readonly status: number,
  ) {
    super(
      `the provider rejected the request with HTTP ${status} before running the model; ` +
        "inspect the request this role sends -- model id, tool schemas, parameters -- and retry",
    );
  }
}

/**
 * The bounded provider cause recorded past the classification boundaries
 * (issue #418).
 *
 * RECORDING, NOT CLASSIFICATION. Every field is optional and each says what
 * the provider REPORTED -- not what a class owns. There is deliberately no
 * allow-list here: a 402 billing refusal is neither a rejection, nor a quota,
 * nor a credential failure, and any of those filters would re-create the
 * #418 undiagnosability by dropping the field exactly when the boundary
 * falls through to the generic empty turn.
 */
export interface ProviderErrorCause {
  /** The provider-reported HTTP status: a safe integer validated to 400..599. */
  readonly status?: number;
  /** The provider's own strict-charset error code token (`[A-Za-z0-9_.-]{1,64}`). */
  readonly code?: string;
}

/**
 * Extract the bounded provider cause from an uncontrolled settled failure, or
 * `undefined` when it names neither a status nor a structured code token.
 *
 * ONLY THE BOUNDED PAIR CROSSES. `status` is read from a structured
 * `status`/`statusCode` field (a safe integer, 400..599) or from the two
 * anchored message shapes via `anchoredProviderStatusFrom`; `code` is
 * `extractProviderCodeToken`'s strict-charset token. The message -- and with
 * it every echoed request value, every URL and every body -- is read for
 * those two fields and dropped: an operator reading the result can state
 * "all presets fail with 402 / insufficient_credits" and nothing more, which
 * is exactly the contract for a durable artifact (#418).
 *
 * ACCEPTS BOTH SETTLED SHAPES. A pi-agent-core `result.error` (`{ code,
 * message }`) and a settled assistant message read as
 * `{ message: errorMessage }` -- the ledger projects its row from the latter
 * alone.
 */
export function providerErrorCauseFrom(error: unknown): ProviderErrorCause | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const message = typeof value.message === "string" ? value.message : undefined;
  // Structured field first (the same trust order as every other reader), then
  // the anchored message shapes; the validated 400..599 band rejects "000",
  // "069", and any longer number the anchoring already refused to truncate.
  const structured = value.status ?? value.statusCode;
  let status: number | undefined =
    typeof structured === "number" &&
    Number.isSafeInteger(structured) &&
    structured >= 400 &&
    structured <= 599
      ? structured
      : undefined;
  if (status === undefined && message !== undefined) {
    const parsed = anchoredProviderStatusFrom(message);
    if (parsed !== undefined && parsed >= 400 && parsed <= 599) status = parsed;
  }
  const code = message !== undefined ? extractProviderCodeToken(message) : undefined;
  if (status === undefined && code === undefined) return undefined;
  return {
    ...(status !== undefined && { status }),
    ...(code !== undefined && { code }),
  };
}

/** A role referenced tools that were not registered in the selected plugin set. */
export class ConfiguredToolsUnavailableError extends Error {
  override readonly name = "ConfiguredToolsUnavailableError";
  readonly code = "configured_tools_unavailable" as const;

  constructor(
    readonly runId: string,
    cause?: unknown,
  ) {
    super(
      "role tools are unavailable in the selected plugin configuration; enable the required plugin or remove those tools from the role profile, then retry",
      { cause },
    );
  }
}

/** A caller deliberately stopped a live role run after durable closeout began. */
export class RunInterruptedError extends Error {
  override readonly name = "RunInterruptedError";
  readonly code = "interrupted" as const;

  constructor(readonly runId: string) {
    super("role run was interrupted and can be resumed");
  }
}

/**
 * Raised when a runner precondition fails before any harness is built. Carries
 * a `code` discriminant and the offending `path` (or run id) ONLY -- never file
 * content, provider messages, or secrets. Matches the house style of
 * `ContextBudgetError`: numbers and paths, dense WHY, nothing that leaks.
 */
export class RunnerError extends Error {
  override readonly name = "RunnerError";
  readonly code: RunnerErrorCode;
  /** The offending targetDir path, or the rejected run id. */
  readonly path: string;

  constructor(code: RunnerErrorCode, offending: string, message: string) {
    super(message);
    this.code = code;
    this.path = offending;
  }
}

/** Safe, bounded provider-capacity signal used by durable orchestration. */
export class ProviderLimitError extends Error {
  override readonly name = "ProviderLimitError";
  readonly code = "provider_limit" as const;

  constructor(readonly retryAfterMs?: number) {
    super("provider capacity is temporarily exhausted");
  }
}

/**
 * A provider REFUSED the request because the account's quota/rate limit is
 * spent -- an HTTP 429 that reached the settled-empty-turn boundary through the
 * MESSAGE, not through a structured `status`/`statusCode` field or a
 * `Retry-After` header. Structured 429s are converted to `ProviderLimitError`
 * earlier; this class is the message-embedded sibling of the same refusal.
 *
 * WHY A SEPARATE TYPE. `ProviderLimitError` carries only an optional delay and
 * is produced by `providerLimitFrom`, which reads ONLY structured
 * status/retry/retry-after fields. pi-agent-core's `providerError` composes
 * `{ code, message }` with no status field, so a 429 embedded in the message
 * (`"429: {"error":{...}}"`) sails past every structured conversion and lands
 * here instead. Collapsing it into `EmptyTurnError` told the operator to
 * "verify authentication" about a valid credential whose quota is spent
 * (#356) -- a wrong cause and an impossible remedy. This class keeps the
 * refusal distinguishable by code, HTTP status, the provider's own bounded
 * error token, and the reset window when the provider supplied one.
 *
 * CARRIES ONLY BOUNDED FIELDS. `status` is the numeric 429. `providerCode` is
 * a strict-charset token (`[A-Za-z0-9_.-]{1,64}`) extracted from the response
 * body's structured error field -- never the body's prose, never a URL, never
 * a `message` value. `retryAfterMs` is a safe-integer delay bounded by
 * `MAX_PROVIDER_RETRY_HINT_MS`, read from the same validated structured hints
 * `providerLimitFrom` accepts. The uncontrolled body is read for those fields
 * and dropped, exactly as the errors contract requires.
 */
export class ProviderQuotaError extends Error {
  override readonly name = "ProviderQuotaError";
  readonly code = "provider_quota" as const;
  readonly status = 429 as const;

  constructor(
    readonly runId: string,
    /** The bounded provider error code/type, when one was extractable. */
    readonly providerCode?: string,
    /** The reset window the provider supplied, in ms, when one was carried. */
    readonly retryAfterMs?: number,
  ) {
    super(
      `the provider refused the request with HTTP 429 (quota/rate limit exhausted)` +
        `${providerCode !== undefined ? ` (provider code ${providerCode})` : ""}` +
        `${retryAfterMs !== undefined ? `; resets in ${Math.ceil(retryAfterMs / 1_000)}s` : ""}` +
        "; wait for the reset window, or check the plan and usage, then retry",
    );
  }
}

export const MAX_PROVIDER_RETRY_HINT_MS = 86_400_000;

/**
 * A settled turn the caller cannot use: the final assistant message carries no
 * answer text and no tool call -- most often a generation truncated by the
 * output-length limit, where the model spent the whole budget on reasoning and
 * was cut off before producing anything (#368: two `run_role coder` dispatches
 * returned `complete ... (no text)` with `isError: false`, and the failure was
 * discoverable only by reading the raw session jsonl).
 *
 * WHY A TYPED CLASS. The harness settles such a turn as `status: "completed"`
 * -- the provider answered -- so every existing settled-FAILURE classification
 * (empty turn, rejection, quota) is gated behind a status check that never
 * fires, and silence reaches the caller as an empty success. A caller cannot
 * distinguish "the worker had nothing to say" from "the worker was cut off
 * mid-thought", and cannot act on either. This class keeps the failure
 * distinguishable by code, the provider's own bounded stop reason, and the
 * token counts the truncated message itself reported.
 *
 * TWO SETTLE SHAPES REACH IT. When the spent output REACHED the intended
 * limit, pi-agent-core sees no recoverable length stop and settles the turn
 * `completed` with whatever content exists -- the #368 incident. When the stop
 * came BELOW the limit, pi makes one bounded compact-and-retry attempt; a
 * retry that truncates again settles the turn `failed` with a generic
 * `assistant_error` -- which the empty-turn fallback would report as "verify
 * authentication". Both shapes classify here: the second at the same boundary,
 * after the quota and rejection attributions that own refusals.
 *
 * CARRIES ONLY BOUNDED FIELDS. `stopReason` is a strict-charset token
 * (`[A-Za-z0-9_-]{1,32}`, e.g. `length`) read from the settled message and
 * dropped when it does not match -- a hostile or foreign transcript value can
 * never cross. `outputTokens`/`reasoningTokens` are safe non-negative integers
 * from the message's own usage. Everything else -- the thinking prose, any
 * other transcript content -- stays where it is.
 *
 * RETRYABLE, BUT NOT AS-IS. The same output budget truncates the same
 * reasoning-heavy turn again; the remedy is a raised output budget or bounded
 * thinking, then retry.
 */
export class GenerationTruncatedError extends Error {
  override readonly name = "GenerationTruncatedError";
  readonly code = "generation_truncated" as const;
  /** The bounded stop reason the settled message carried, when one matched. */
  readonly stopReason: string | undefined;
  /** Output tokens the truncated message reported spending, when it carried them. */
  readonly outputTokens: number | undefined;
  /** Reasoning tokens the truncated message reported, when the provider split them out. */
  readonly reasoningTokens: number | undefined;

  constructor(
    readonly runId: string,
    stopReason?: string,
    outputTokens?: number,
    reasoningTokens?: number,
  ) {
    // Every carried field is bounded HERE, at the single point the allow-list
    // audit (orchestrator safeErrorText) can name: a non-matching stop reason
    // and a non-integer count are dropped, never truncated and never thrown
    // about -- the classification itself does not depend on them.
    const boundedStopReason =
      stopReason !== undefined && STOP_REASON_TOKEN_RE.test(stopReason) ? stopReason : undefined;
    const boundedOutput = boundedTokenCount(outputTokens);
    const boundedReasoning = boundedTokenCount(reasoningTokens);
    const cause =
      boundedStopReason === "length"
        ? `the generation was cut off by the output-token limit` +
          `${boundedOutput !== undefined ? ` after ${boundedOutput} output tokens` : ""}` +
          `${boundedReasoning !== undefined ? ` (${boundedReasoning} on reasoning)` : ""}` +
          " with no answer and no tool call"
        : `the generation settled with no answer and no tool call` +
          `${boundedStopReason !== undefined ? ` (stopReason ${boundedStopReason})` : ""}`;
    // Same advice for every shape: a same-budget retry is expected to truncate
    // the same reasoning-heavy turn again, so the remedy is a changed budget,
    // not a blind retry (#368).
    super(`${cause}; raise the output budget or bound thinking, then retry`);
    this.stopReason = boundedStopReason;
    this.outputTokens = boundedOutput;
    this.reasoningTokens = boundedReasoning;
  }
}

/** A strict-charset stop-reason token, e.g. `length`. Anything else never crosses. */
const STOP_REASON_TOKEN_RE = /^[A-Za-z0-9_-]{1,32}$/;

function boundedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const PROVIDER_LIMIT_CODES = new Set([
  "rate_limit_exceeded",
  "rate_limit",
  "quota_exceeded",
  "insufficient_quota",
  "resource_exhausted",
]);

/** Convert only bounded structured provider fields; raw messages and bodies are ignored. */
export function providerLimitFrom(
  error: unknown,
  nowMs = Date.now(),
): ProviderLimitError | undefined {
  if (error instanceof ProviderLimitError) return error;
  if (error === null || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const status = value.status ?? value.statusCode;
  const rawCode = value.code;
  if (status !== 429 && !(typeof rawCode === "string" && PROVIDER_LIMIT_CODES.has(rawCode))) {
    return undefined;
  }
  const retryAfterMs = boundedRetryHintMs(value as Record<string, unknown>, nowMs);
  return new ProviderLimitError(retryAfterMs);
}

/**
 * Resolve a provider-supplied reset hint into a bounded millisecond delay, or
 * `undefined` when none of the recognised fields carries a safe value. Shared
 * by `providerLimitFrom` (structured 429) and `providerQuotaFrom`
 * (message-embedded 429) so both boundaries validate the same way, and a reset
 * window can never exceed `MAX_PROVIDER_RETRY_HINT_MS`.
 */
function boundedRetryHintMs(value: Record<string, unknown>, nowMs: number): number | undefined {
  const millisecondHint = value.retryAfterMs ?? value.retry_after_ms;
  const secondHint = value.retryAfterSeconds ?? value.retry_after;
  const resetAtMs = value.resetAtMs ?? value.reset_at_ms;
  if (
    typeof millisecondHint === "number" &&
    Number.isSafeInteger(millisecondHint) &&
    millisecondHint > 0 &&
    millisecondHint <= MAX_PROVIDER_RETRY_HINT_MS
  ) {
    return millisecondHint;
  }
  if (typeof secondHint === "number" && Number.isFinite(secondHint) && secondHint > 0) {
    const converted = Math.ceil(secondHint * 1_000);
    if (Number.isSafeInteger(converted) && converted <= MAX_PROVIDER_RETRY_HINT_MS)
      return converted;
  }
  if (
    typeof resetAtMs === "number" &&
    Number.isSafeInteger(resetAtMs) &&
    resetAtMs > nowMs &&
    resetAtMs - nowMs <= MAX_PROVIDER_RETRY_HINT_MS
  ) {
    return resetAtMs - nowMs;
  }
  return undefined;
}

/**
 * The client-error statuses a REJECTION can legitimately carry.
 *
 * 401/403 are deliberately EXCLUDED: those are the credential failures
 * `EmptyTurnError` already names, and re-labelling them "inspect the request"
 * would trade one wrong instruction for another. 5xx is excluded too -- a
 * server fault is not a statement about the request -- and 429 never reaches
 * here because a structured 429 is converted by `providerLimitFrom` first and a
 * message-embedded 429 is converted by `providerQuotaFrom` first: the quota
 * boundary runs BEFORE this rejection boundary (#356).
 */
const PROVIDER_REJECTION_STATUSES = new Set([400, 404, 405, 409, 413, 415, 422]);

/**
 * Recover the HTTP status a settled provider failure was refused with, or
 * `undefined` when the failure names no status this runner will attribute.
 *
 * SOURCES, IN ORDER OF TRUST. A structured `status`/`statusCode` field is read
 * directly when one is present. In practice it never is on this path --
 * pi-agent-core's `providerError` composes `{ code, message }` and carries no
 * status field and no `details` -- so the message is the only channel, and the
 * patterns below are what actually decide every attribution.
 *
 * TWO MESSAGE SHAPES, because pi-ai does not compose provider errors one way.
 *
 * 1. `formatProviderError` -- `"<status>: <body>"` or
 *    `"<prefix> (<status>): <body>"`. Used by the openai-completions,
 *    -responses and codex-responses adapters, i.e. two of the three `ApiKind`s
 *    this registry resolves.
 *
 * 2. The provider SDK's own `APIError.message` -- `"<status> <body>"`, a SPACE
 *    and no colon. This is the third `ApiKind`: `anthropic-messages` never
 *    calls `formatProviderError` at all; its catch block assigns the raw SDK
 *    message. Matching only shape 1 left every Anthropic-native model -- and
 *    every OpenRouter model overriding to `anthropic-messages` -- falling
 *    through to `EmptyTurnError`, telling the operator to check their
 *    credentials about a request the provider had refused on its merits. That
 *    is precisely the misattribution this function exists to end, so a fix
 *    covering only two of three APIs would not have fixed it.
 *
 * Shape 2 is anchored at the start and bounded to exactly three digits
 * followed by a space, so it reads a leading status and not a longer number
 * ("2024 ..." fails, because the fourth digit is where a space must be). It
 * deliberately also accepts the SDK's body-less `"<status> status code (no
 * body)"`: the status is the whole output here, and a 400 with an empty body
 * is still a 400 the provider refused -- excluding it would hand that run back
 * to the credential advice this function exists to stop. Nothing else
 * in the message is read, and the body is never returned -- this function's
 * whole output is a number from a fixed allow-list.
 */
export function providerRejectionStatusFrom(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const structured = value.status ?? value.statusCode;
  if (typeof structured === "number" && PROVIDER_REJECTION_STATUSES.has(structured)) {
    return structured;
  }
  const message = value.message;
  if (typeof message !== "string") return undefined;
  const parsed = anchoredProviderStatusFrom(message);
  return parsed !== undefined && PROVIDER_REJECTION_STATUSES.has(parsed) ? parsed : undefined;
}

/**
 * Read the 3-digit leading status from one of the two anchored message shapes
 * (`"<status>: <body>"`, its `<prefix> (<status>): <body>` variant, or the
 * SDK's `"<status> <body>"`), WITHOUT choosing a class for it.
 *
 * SHARED ANCHORED READER. `providerRejectionStatusFrom` and
 * `providerQuotaFrom` inline the same two patterns; `providerErrorCauseFrom`
 * reads the same channel, so the reading lives in one place and all three
 * boundaries see identical messages identically. The narrative on the two
 * message shapes above carries over unchanged: anchored at the start so a
 * three-digit number inside prose never matches, bounded to exactly three
 * digits so "2024 ..." fails at the fourth character, and the body is never
 * returned -- the whole output is a number.
 *
 * UNFILTERED BY DELIBERATE DESIGN. Callers classify; this only records.
 * `providerRejectionStatusFrom` filters to its allow-list AFTER this returns,
 * and every other caller validates the range itself, so loosening the read
 * here cannot widen a classification.
 */
export function anchoredProviderStatusFrom(message: string): number | undefined {
  const match = /^(?:[^():]{0,64} )?\(?(\d{3})\)?: /.exec(message) ?? /^(\d{3}) /.exec(message);
  if (match === null) return undefined;
  return Number(match[1]);
}

/**
 * Keys whose string value names the provider's own error code/type, ordered
 * most-specific-first (see `extractProviderCodeToken`).
 */
const PROVIDER_CODE_TOKEN_KEYS = ["code", "error_code", "error_type", "type"] as const;

const PROVIDER_CODE_TOKEN_RE = new RegExp(
  `"(?:${PROVIDER_CODE_TOKEN_KEYS.join("|")})"\\s*:\\s*"([A-Za-z0-9_.-]{1,64})(?![A-Za-z0-9_.-])\\s*"`,
  "g",
);

/**
 * Extract the provider's own error code/type from an uncontrolled response
 * body, as a strict-charset token, or `undefined` when no such token exists.
 *
 * ONLY a value matching `[A-Za-z0-9_.-]{1,64}` is ever returned: every other
 * character class -- spaces (prose), `/` and `:` (URLs), quotes and braces
 * (more body) -- fails the match and is dropped. A token longer than 64 chars
 * fails the `{1,64}` bound AND the trailing `(?![A-Za-z0-9_.-])` guard, so a
 * long identifier can never be returned truncated. The body is otherwise never
 * read: `message` values, URLs, and free prose stay in the body they came from.
 *
 * The bare token `"error"` is skipped: in Anthropic's error envelope
 * (`{"type":"error","error":{...}}`) it is the generic discriminator, not the
 * provider's code, and reporting it would re-create the `assistant_error`
 * misattribution this class exists to end. Skipping (not stopping) is what lets
 * the real nested token (`"error":{"type":"..."}`) be found after it.
 */
export function extractProviderCodeToken(body: string): string | undefined {
  for (const match of body.matchAll(PROVIDER_CODE_TOKEN_RE)) {
    const token = match[1] as string;
    if (token !== "error") return token;
  }
  return undefined;
}

/**
 * What a message-embedded 429 refusal carries past the quota boundary. `status`
 * is always the literal 429 that produced the classification; `providerCode`
 * and `retryAfterMs` are present only when the provider actually supplied them
 * in a structured, bounded form.
 */
export interface ProviderQuotaSignal {
  readonly status: 429;
  readonly providerCode?: string;
  readonly retryAfterMs?: number;
}

/**
 * Classify a settled provider failure as a quota/rate-limit refusal (HTTP 429),
 * or `undefined` when the failure is not a 429 at all.
 *
 * READ ONLY ABOUT QUOTA. This is the message-embedded sibling of
 * `providerLimitFrom`: it answers "is this a 429, and what does the provider
 * name and the reset window?" for a refusal that reached the settled boundary
 * through the message. A structured `status`/`statusCode` of 429 is also
 * honoured for symmetry with `providerLimitFrom`, but in practice that case is
 * converted earlier and never arrives here.
 *
 * The status is read from the same two anchored message shapes
 * `providerRejectionStatusFrom` reads -- shape 1 `"429: <body>"` (and the
 * prefixed variant) and shape 2 `"429 <body>"` -- plus a structured
 * status/statusCode equal to 429. 401/403/5xx are simply not 429 and return
 * `undefined`, leaving those to the credential and rejection boundaries that
 * already own them. The bounded provider token and the reset window are read
 * from the body/structured fields and nothing else crosses.
 */
export function providerQuotaFrom(
  error: unknown,
  nowMs = Date.now(),
): ProviderQuotaSignal | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const structured = value.status ?? value.statusCode;
  let isStatus429: boolean;
  if (typeof structured === "number") {
    isStatus429 = structured === 429;
  } else {
    const message = value.message;
    if (typeof message !== "string") return undefined;
    const match = anchoredProviderStatusFrom(message);
    isStatus429 = match !== undefined && match === 429;
  }
  if (!isStatus429) return undefined;
  const message = typeof value.message === "string" ? value.message : undefined;
  const providerCode = message === undefined ? undefined : extractProviderCodeToken(message);
  const retryAfterMs = boundedRetryHintMs(value as Record<string, unknown>, nowMs);
  return {
    status: 429,
    ...(providerCode !== undefined && { providerCode }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  };
}

/**
 * The structural slice of a settled assistant message the truncation boundary
 * reads. Deliberately structural -- `unknown` fields with runtime checks -- so
 * both a live pi-ai `AssistantMessage` and a replayed session entry pass
 * WITHOUT importing pi-ai into this module, and a hostile transcript shape
 * (wrong roles, non-string tokens, fractional counts) fails the checks instead
 * of the type system.
 */
export interface SettledTurnMessage {
  readonly role: unknown;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
  readonly content: readonly (
    | { readonly type: "text"; readonly text: unknown }
    | { readonly type: "thinking"; readonly thinking?: unknown }
    | {
        readonly type: "toolCall";
        readonly id?: unknown;
        readonly name?: unknown;
        readonly arguments?: unknown;
      }
  )[];
  readonly usage?: { readonly output?: unknown; readonly reasoning?: unknown };
}

/**
 * What an unusable settled assistant message carries past the truncation
 * boundary: every field optional, every field bounded by the constructor of
 * `GenerationTruncatedError` when it becomes one.
 */
export interface GenerationTruncationSignal {
  readonly stopReason?: string;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * The marker pi-agent-core stamps on a message committed after its one bounded
 * compact-and-retry attempt for a length stop failed to produce a usable
 * generation: the retry truncated again, and `normalizeError` rewrote the
 * message to an error stop with this constant. Matched by EXACT equality -- it
 * is a library-authored constant, never provider prose, so a provider wording
 * its own overflow error differently stays with the failure classifications.
 */
const PI_OVERFLOW_RECOVERY_MARKER = "Assistant request exceeded the context window";

/**
 * Classify the settled turn's final assistant message as an unusable,
 * truncated generation, or `undefined` when the message carries something the
 * caller can act on.
 *
 * THE TRIGGER IS SILENCE WITH EVIDENCE OF A CUT. A final assistant message
 * with neither answer text nor a tool call produced nothing the caller can
 * use. But not every silence is a truncation: an empty settled answer (no
 * content, or an empty text block, stopped cleanly) is the silent no-op the
 * workflow layer already classifies, and re-labelling it would move a pinned
 * boundary. The trigger therefore requires the generation's OWN evidence that
 * content was cut -- reasoning that ran and never reached an answer
 * (`thinking` content, the #368 shape), or the provider's own `length` stop.
 * A text block (even a partial one) or a tool call IS usable content and
 * returns `undefined` -- a truncated final answer is degraded, not absent,
 * and stays today's behavior; the ledger's `stopReason` column already
 * records it.
 *
 * FAILURE MARKERS ARE NOT TRUNCATIONS. A message whose stop is `error`,
 * `aborted`, or `pending` is a failed or unfinished request, not a settled
 * generation that came up short -- those belong to the settled-FAILURE
 * classifications (empty turn, rejection, quota) and keep their advice.
 * Without this exclusion a credential refusal (401/403 arrives as an
 * error-stopped message) would be re-labelled a truncation. The ONE exception
 * is pi-agent-core's exhausted length-recovery marker: there the error stop is
 * the bookkeeping for a generation that RAN twice and produced thinking both
 * times but no answer -- the truncation is the cause, the marker only proves
 * it, and the reported stop reason is the `length` the recovery was recovering.
 *
 * READS NOTHING BUT THE MESSAGE. No transcript, no ledger, no request state:
 * the caller supplies the final assistant message and this answers whether it
 * was usable, with only bounded evidence about why it was not.
 */
export function truncatedGenerationFrom(
  message: SettledTurnMessage | undefined,
): GenerationTruncationSignal | undefined {
  if (message === undefined || message.role !== "assistant") return undefined;
  if (
    message.stopReason === "error" ||
    message.stopReason === "aborted" ||
    message.stopReason === "pending"
  ) {
    // pi-agent-core commits an exhausted length-recovery as an error-stopped
    // message with the generation's own thinking content still on it. That is
    // a truncated generation -- the tokens were spent on reasoning that never
    // answered -- so classify it instead of letting the empty-turn fallback
    // advise "verify authentication" about a credential that is fine (#368).
    if (
      message.stopReason === "error" &&
      message.errorMessage === PI_OVERFLOW_RECOVERY_MARKER &&
      message.content.some((block) => block.type === "thinking")
    ) {
      const outputTokens = boundedTokenCount(message.usage?.output);
      const reasoningTokens = boundedTokenCount(message.usage?.reasoning);
      return {
        stopReason: "length",
        ...(outputTokens !== undefined && { outputTokens }),
        ...(reasoningTokens !== undefined && { reasoningTokens }),
      };
    }
    return undefined;
  }
  const hasText = message.content.some(
    (block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
  );
  if (hasText) return undefined;
  if (message.content.some((block) => block.type === "toolCall")) return undefined;
  // Silence with no evidence of a cut is the silent no-op the workflow layer
  // already owns; a truncated generation left reasoning behind, or the
  // provider named the output limit itself.
  const lengthStopped = message.stopReason === "length";
  if (!lengthStopped && !message.content.some((block) => block.type === "thinking")) {
    return undefined;
  }
  const stopReason =
    typeof message.stopReason === "string" && STOP_REASON_TOKEN_RE.test(message.stopReason)
      ? message.stopReason
      : undefined;
  const outputTokens = boundedTokenCount(message.usage?.output);
  const reasoningTokens = boundedTokenCount(message.usage?.reasoning);
  return {
    ...(stopReason !== undefined && { stopReason }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
  };
}

/**
 * The run id becomes a file-name component of the ledger path, so it is
 * validated the same way the Ledger validates it -- BEFORE any path is built
 * from it. The runner cannot rely on the Ledger constructor's throw ordering:
 * `FileLedgerSink` computes the path eagerly, so a malformed run id must be
 * refused here or it could form a traversal path the sink then holds.
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Reject a run id that cannot safely become a ledger file name. */
export function assertRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RunnerError(
      "invalid_run_id",
      runId,
      `runId must match ${String(RUN_ID_PATTERN)} (it is used as a file name)`,
    );
  }
  return runId;
}

/**
 * Reject a combined tool set that registers the same name twice.
 *
 * Run over the FULL built-in + custom array BEFORE the harness is constructed so
 * a collision surfaces as a typed, numbers-and-paths-only `RunnerError` rather
 * than the harness's raw `TypeError('Duplicate tool name')`. Catches every
 * collision class: a custom tool shadowing a built-in (bash/read/write/edit) AND
 * two custom tools sharing a name. The error's `path` carries only the colliding
 * tool name -- a caller-supplied identifier, exactly like `invalid_run_id`
 * carries the rejected run id -- never tool content or arguments.
 */
export function assertUniqueToolNames(tools: readonly { name: string }[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new RunnerError(
        "tool_name_collision",
        tool.name,
        `duplicate tool name "${tool.name}"; a custom tool may not shadow a built-in or another custom tool`,
      );
    }
    seen.add(tool.name);
  }
}

/**
 * Resolve a caller-supplied targetDir to an absolute, existing directory.
 *
 * targetDir is the working directory the agent's tools and the ledger operate
 * in. It is TRUSTED INPUT the same way `resolveScriptPath` treats its path
 * argument: these checks confirm the operator pointed at a real directory, they
 * are NOT a sandbox. The directory's CONTENT is untrusted (see the runner's
 * credential-boundary JSDoc). A symlinked targetDir is resolved to its real
 * path via `fs.realpathSync`, so the agent and the ledger operate on the same
 * location the operator can inspect, not a redirected one.
 */
export function resolveTargetDir(input: string | undefined): string {
  if (input === undefined || input.trim() === "") {
    throw new RunnerError("missing", String(input ?? ""), "targetDir must be a non-empty path");
  }
  const expanded =
    input === "~" || input.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), input.slice(1))
      : input;
  const resolved = path.resolve(expanded);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    // realpathSync throws on a nonexistent path; report it as not_found with
    // the resolved (pre-realpath) path. The error object itself is dropped: it
    // carries an errno and the same path, nothing the caller needs beyond the
    // typed code below.
    throw new RunnerError("not_found", resolved, `targetDir does not exist: ${resolved}`);
  }
  const stat = fs.statSync(real);
  if (!stat.isDirectory()) {
    throw new RunnerError("not_a_directory", real, `targetDir is not a directory: ${real}`);
  }
  return real;
}

/**
 * Refuse to write the ledger through a symlinked path component.
 *
 * `FileLedgerSink` enforces `O_NOFOLLOW` on the FINAL component only; its
 * `mkdirSync(recursive)` and the `chmod 0o700` that follows both follow
 * symlinks on INTERMEDIATE components. Because the ledger now lands under an
 * untrusted targetDir, a pre-planted symlink at `<targetDir>/.ad-coder` (or
 * `.../ledger`) would redirect the ledger write -- and that chmod -- outside
 * targetDir. `absTargetDir` is already `realpath`-resolved, so we only need to
 * walk the base-dir components below it: each existing one must be a real
 * directory, never a symlink. A component that does not exist yet is safe --
 * `mkdirSync(recursive)` creates it as a real directory.
 */
export function assertLedgerDirWithinTarget(absTargetDir: string, ledgerBaseDir: string): void {
  const parts = ledgerBaseDir.split(path.sep).filter((part) => part.length > 0);
  let current = absTargetDir;
  for (const part of parts) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      // Not created yet; mkdirSync(recursive) will make it a real directory.
      return;
    }
    if (stat.isSymbolicLink()) {
      throw new RunnerError(
        "unsafe_ledger_dir",
        current,
        `ledger path component is a symlink; refusing to write outside targetDir: ${current}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new RunnerError(
        "unsafe_ledger_dir",
        current,
        `ledger path component is not a directory: ${current}`,
      );
    }
  }
}
