import { readFileSync, type Stats, statSync } from "node:fs";

/**
 * The `/task` filesystem boundary.
 *
 * WHY A SEPARATE MODULE. `runConsole` had grown the paste-CSI machine, the
 * `/task` dispatch, and the byte-ceiling policy as interlocked closures; the
 * `docs/contracts/decomposition.md` rule points filesystem details behind a
 * narrow injected boundary. This module owns loading one task file: opening
 * policy, the byte ceiling, and errno classification. The console owns only
 * the projection of the failure to stderr.
 *
 * WHY STAT FIRST (issue #247). Reading the whole file and checking the ceiling
 * afterwards let an unbounded file block the console before the limit that
 * exists to bound it could act. The stat happens before any read; a file whose
 * stat reports more than `maxInputBytes` is refused without one byte read.
 * The single remaining read is then bounded by that same ceiling, so a bounded
 * stream is unnecessary for this change; the ceiling itself is the bound.
 *
 * WHY ERRNO CLASSES (issue #247). One `task_file_unreadable` code with the
 * advice "check the path and retry" tells an operator whose file exists but
 * denies read permission nothing: re-checking the path cannot fix EACCES.
 * Keep the errno class as its own stable code and let the action follow from
 * it (docs/contracts/errors.md).
 */

/** Public failure projection for a task file that cannot be loaded. */
export interface TaskFileFailure {
  readonly code: TaskFileFailureCode;
  /** Concise safe text naming the failed operation and its cause. */
  readonly message: string;
  /** The next useful action, appropriate to the cause. */
  readonly action: string;
  /** Whether sending the identical `/task` again can succeed. */
  readonly retryable: boolean;
}

export type TaskFileFailureCode =
  | "task_file_not_found"
  | "task_file_denied"
  | "task_file_is_directory"
  | "task_file_unreadable"
  | "resource_limit";

export type TaskFileLoad = { ok: true; text: string } | ({ ok: false } & TaskFileFailure);

/**
 * Narrow injected seam for tests. The real defaults are the Node sync calls;
 * a test can substitute them to prove an over-ceiling file is refused without
 * being read, or to raise an errno the local filesystem cannot produce.
 */
export interface TaskFileDependencies {
  stat?: (path: string) => Stats;
  readFile?: (path: string) => Buffer;
}

/** Load one task file: stat, apply the byte ceiling, then read. */
export function loadTaskFile(
  taskPath: string,
  maxInputBytes: number,
  deps: TaskFileDependencies = {},
): TaskFileLoad {
  const stat = deps.stat ?? statSync;
  const readFile = deps.readFile ?? readFileSync;
  let bytes: Buffer;
  try {
    const stats = stat(taskPath);
    if (stats.size > maxInputBytes) return overCeiling();
    bytes = readFile(taskPath);
    if (Buffer.byteLength(bytes) > maxInputBytes) return overCeiling();
  } catch (cause) {
    return unreadable(cause, taskPath);
  }
  return { ok: true, text: bytes.toString("utf8") };
}

/** The shared failure an over-ceiling file gets, whether stat or read exposes it. */
const overCeiling = (): TaskFileLoad => ({
  ok: false,
  code: "resource_limit",
  message: "/task file exceeds the configured input byte limit",
  action: "send a shorter message, or raise maxInputBytes when embedding runConsole",
  // The identical file cannot fit again.
  retryable: false,
});

/**
 * Translate a filesystem error at the boundary, keeping the errno class and
 * letting the action follow from it (docs/contracts/errors.md). The path text
 * is verbatim operator input the console already echoed; no file content here.
 */
function unreadable(cause: unknown, taskPath: string): TaskFileLoad {
  const errno = (cause as NodeJS.ErrnoException | null)?.code;
  const pathText = taskPath.slice(0, 256);
  const failed = `/task cannot read ${pathText}`;
  if (errno === "ENOENT")
    return {
      ok: false,
      code: "task_file_not_found",
      message: `${failed} (no such file)`,
      action: "check the path and retry with: /task <path>",
      // A corrected path can succeed.
      retryable: true,
    };
  if (errno === "EACCES" || errno === "EPERM")
    return {
      ok: false,
      code: "task_file_denied",
      message: `${failed} (permission denied)`,
      action: `check read permissions on ${pathText} with: ls -l, or retry from an identity that can read it`,
      // The identical /task cannot succeed; a readable path or permission change can.
      retryable: true,
    };
  if (errno === "EISDIR")
    return {
      ok: false,
      code: "task_file_is_directory",
      message: `${failed} (it is a directory)`,
      action: "name a file, not a directory, with: /task <path>",
      retryable: true,
    };
  return {
    ok: false,
    code: "task_file_unreadable",
    // The errno token is the causal detail a machine or operator can act on.
    message: `${failed} (${errno ?? "unknown cause"})`,
    action: "check the path and retry with: /task <path>",
    retryable: true,
  };
}
