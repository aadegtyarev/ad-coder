import * as fs from "node:fs";
import * as path from "node:path";

export type UpdateErrorCode =
  | "not_checkout"
  | "dirty_checkout"
  | "detached_head"
  | "missing_upstream"
  | "command_failed";

export class UpdateError extends Error {
  constructor(
    readonly code: UpdateErrorCode,
    readonly detail: string,
    message: string,
  ) {
    super(message);
    this.name = "UpdateError";
  }
}

export interface UpdateCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type UpdateCommandRunner = (
  argv: readonly string[],
  cwd: string,
) => Promise<UpdateCommandResult>;

export interface UpdateResult {
  checkoutDir: string;
  branch: string;
  upstream: string;
  previousRevision: string;
  revision: string;
  changed: boolean;
}

export interface UpdateOptions {
  checkoutDir: string;
  run: UpdateCommandRunner;
  onStep?: (step: "pull" | "install" | "link") => void;
}

async function requireCommand(
  run: UpdateCommandRunner,
  cwd: string,
  argv: readonly string[],
  detail: string,
): Promise<string> {
  const result = await run(argv, cwd);
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim().slice(0, 1000);
    throw new UpdateError(
      "command_failed",
      detail,
      `${argv[0]} ${argv[1] ?? ""} failed${reason === "" ? "" : `: ${reason}`}`,
    );
  }
  return result.stdout.trim();
}

/** Update a clean linked-development checkout without invoking a shell. */
export async function updateCheckout(options: UpdateOptions): Promise<UpdateResult> {
  const checkoutDir = fs.realpathSync(options.checkoutDir);
  if (!fs.existsSync(path.join(checkoutDir, ".git")))
    throw new UpdateError(
      "not_checkout",
      checkoutDir,
      "ad-coder update requires a linked Git checkout",
    );
  const root = await requireCommand(
    options.run,
    checkoutDir,
    ["git", "rev-parse", "--show-toplevel"],
    "checkout",
  );
  if (fs.realpathSync(root) !== checkoutDir)
    throw new UpdateError(
      "not_checkout",
      checkoutDir,
      "executable root is not the Git checkout root",
    );
  const dirty = await requireCommand(
    options.run,
    checkoutDir,
    ["git", "status", "--porcelain=v1", "--untracked-files=normal"],
    "status",
  );
  if (dirty !== "")
    throw new UpdateError(
      "dirty_checkout",
      checkoutDir,
      "checkout has uncommitted changes; commit or stash them, then retry",
    );
  const branchResult = await options.run(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    checkoutDir,
  );
  const branch = branchResult.stdout.trim();
  if (branchResult.exitCode !== 0 || branch === "")
    throw new UpdateError(
      "detached_head",
      checkoutDir,
      "checkout is on a detached HEAD; switch to a branch, then retry",
    );
  const upstreamResult = await options.run(
    ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    checkoutDir,
  );
  const upstream = upstreamResult.stdout.trim();
  if (upstreamResult.exitCode !== 0 || upstream === "")
    throw new UpdateError(
      "missing_upstream",
      branch,
      "current branch has no upstream; configure one, then retry",
    );
  const previousRevision = await requireCommand(
    options.run,
    checkoutDir,
    ["git", "rev-parse", "HEAD"],
    "revision",
  );
  options.onStep?.("pull");
  await requireCommand(options.run, checkoutDir, ["git", "pull", "--ff-only"], "pull");
  options.onStep?.("install");
  await requireCommand(
    options.run,
    checkoutDir,
    ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
    "install",
  );
  options.onStep?.("link");
  await requireCommand(options.run, checkoutDir, ["bun", "link"], "link");
  const revision = await requireCommand(
    options.run,
    checkoutDir,
    ["git", "rev-parse", "HEAD"],
    "revision",
  );
  return {
    checkoutDir,
    branch,
    upstream,
    previousRevision,
    revision,
    changed: revision !== previousRevision,
  };
}
