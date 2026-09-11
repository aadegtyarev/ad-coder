import * as fs from "node:fs";
import * as path from "node:path";

/** Why a targetDir was rejected. A discriminant the caller can branch on. */
export type RunnerErrorCode =
  | "missing"
  | "not_found"
  | "not_a_directory"
  | "invalid_run_id"
  | "unsafe_ledger_dir"
  | "tool_name_collision";

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
  const resolved = path.resolve(input);
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
