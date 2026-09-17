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

  constructor(
    readonly runId: string,
    /** The bounded, harness-authored failure code that emptied the turn, when one exists. */
    readonly providerCode?: string,
  ) {
    super(
      `the provider returned a failed empty turn; verify authentication and retry` +
        `${providerCode !== undefined ? ` (provider code ${providerCode})` : ""}`,
    );
  }
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

export const MAX_PROVIDER_RETRY_HINT_MS = 86_400_000;

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
  const millisecondHint = value.retryAfterMs ?? value.retry_after_ms;
  const secondHint = value.retryAfterSeconds ?? value.retry_after;
  const resetAtMs = value.resetAtMs ?? value.reset_at_ms;
  let retryAfterMs: number | undefined;
  if (
    typeof millisecondHint === "number" &&
    Number.isSafeInteger(millisecondHint) &&
    millisecondHint > 0 &&
    millisecondHint <= MAX_PROVIDER_RETRY_HINT_MS
  ) {
    retryAfterMs = millisecondHint;
  } else if (typeof secondHint === "number" && Number.isFinite(secondHint) && secondHint > 0) {
    const converted = Math.ceil(secondHint * 1_000);
    if (Number.isSafeInteger(converted) && converted <= MAX_PROVIDER_RETRY_HINT_MS)
      retryAfterMs = converted;
  } else if (
    typeof resetAtMs === "number" &&
    Number.isSafeInteger(resetAtMs) &&
    resetAtMs > nowMs &&
    resetAtMs - nowMs <= MAX_PROVIDER_RETRY_HINT_MS
  ) {
    retryAfterMs = resetAtMs - nowMs;
  }
  return new ProviderLimitError(retryAfterMs);
}

/**
 * The client-error statuses a REJECTION can legitimately carry.
 *
 * 401/403 are deliberately EXCLUDED: those are the credential failures
 * `EmptyTurnError` already names, and re-labelling them "inspect the request"
 * would trade one wrong instruction for another. 5xx is excluded too -- a
 * server fault is not a statement about the request -- and 429 never reaches
 * here because `providerLimitFrom` converts it first.
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
  const match = /^(?:[^():]{0,64} )?\(?(\d{3})\)?: /.exec(message) ?? /^(\d{3}) /.exec(message);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return PROVIDER_REJECTION_STATUSES.has(parsed) ? parsed : undefined;
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
