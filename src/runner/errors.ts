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

  constructor(readonly runId: string) {
    super("the provider returned a failed empty turn; verify authentication and retry");
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
