import * as fs from "node:fs";
import * as path from "node:path";

export type UpdateErrorCode =
  | "not_checkout"
  | "dirty_checkout"
  | "detached_head"
  | "missing_upstream"
  | "invalid_revision"
  | "install_mismatch"
  | "install_unverifiable"
  | "command_failed";

export interface UpdateErrorOptions {
  /** Whether repeating the identical update can succeed without operator action. */
  readonly retryable?: boolean;
  /** The next action that recovers from this failure, when one exists. */
  readonly nextAction?: string;
  /** The causal error, preserved for programmatic callers only. */
  readonly cause?: unknown;
}

export class UpdateError extends Error {
  readonly retryable: boolean;
  readonly nextAction: string | undefined;

  constructor(
    readonly code: UpdateErrorCode,
    readonly detail: string,
    message: string,
    options: UpdateErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "UpdateError";
    this.retryable = options.retryable ?? false;
    this.nextAction = options.nextAction;
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
  mode: "linked-checkout" | "global-github";
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
  onStep?: (step: "resolve" | "pull" | "install" | "link" | "verify") => void;
  /**
   * Read the revision currently installed at a package directory. Injected so a
   * global install can be verified without a real Bun installation present.
   */
  readInstalledRevision?: (packageDir: string) => string | null;
}

const GITHUB_REMOTE = "git@github.com:aadegtyarev/ad-coder.git";
const GITHUB_PACKAGE = "github:aadegtyarev/ad-coder";
const SAFE_GIT_REVISION = /^[0-9a-f]{40}$/;
const BUN_TAG_FILE = ".bun-tag";
const SAFE_INSTALLED_REVISION = /^[0-9a-f]{7,40}$/;

/**
 * Read the revision Bun recorded for an installed global package, or null when
 * no revision can be established. Absence is never reported as a match: the
 * caller turns it into a typed failure rather than a success-shaped result
 * (`docs/contracts/errors.md`).
 */
export function readInstalledRevision(packageDir: string): string | null {
  let tag: string;
  try {
    tag = fs.readFileSync(path.join(packageDir, BUN_TAG_FILE), "utf8").trim();
  } catch {
    return null;
  }
  const revision = tag.slice(tag.lastIndexOf("-") + 1);
  return SAFE_INSTALLED_REVISION.test(revision) ? revision : null;
}

/** Whether an installed (possibly abbreviated) revision identifies the resolved one. */
function identifies(installed: string, resolved: string): boolean {
  return resolved.startsWith(installed);
}

async function requireCommand(
  run: UpdateCommandRunner,
  cwd: string,
  argv: readonly string[],
  detail: string,
): Promise<string> {
  let result: UpdateCommandResult;
  try {
    result = await run(argv, cwd);
  } catch (error) {
    // A runner that cannot spawn at all is translated at this boundary rather
    // than escaping untyped; the causal error stays attached for programmatic
    // callers (`docs/contracts/errors.md`).
    throw new UpdateError("command_failed", detail, `${argv[0]} could not be run`, {
      retryable: false,
      nextAction: `ensure ${argv[0]} is installed and on PATH, then rerun ad-coder update`,
      cause: error,
    });
  }
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim().slice(0, 1000);
    throw new UpdateError(
      "command_failed",
      detail,
      `${argv[0]} ${argv[1] ?? ""} failed${reason === "" ? "" : `: ${reason}`}`,
      {
        retryable: false,
        nextAction: `run ${argv.join(" ")} in ${cwd} to see the full failure, then rerun ad-coder update`,
      },
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
      {
        retryable: false,
        nextAction:
          "reinstall globally with `bun add --global github:aadegtyarev/ad-coder#main`, or run ad-coder update from a linked checkout",
      },
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
      {
        retryable: false,
        nextAction:
          "relink development with `bun link` from the checkout root, then rerun ad-coder update",
      },
    );
  const dirty = await requireCommand(
    options.run,
    checkoutDir,
    ["git", "status", "--porcelain=v1", "--untracked-files=normal"],
    "status",
  );
  if (dirty !== "")
    throw new UpdateError("dirty_checkout", checkoutDir, "checkout has uncommitted changes", {
      retryable: true,
      nextAction: "commit or stash them, then rerun ad-coder update",
    });
  const branchResult = await options.run(
    ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
    checkoutDir,
  );
  const branch = branchResult.stdout.trim();
  if (branchResult.exitCode !== 0 || branch === "")
    throw new UpdateError("detached_head", checkoutDir, "checkout is on a detached HEAD", {
      retryable: true,
      nextAction: "switch to a branch, then rerun ad-coder update",
    });
  const upstreamResult = await options.run(
    ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    checkoutDir,
  );
  const upstream = upstreamResult.stdout.trim();
  if (upstreamResult.exitCode !== 0 || upstream === "")
    throw new UpdateError("missing_upstream", branch, `branch ${branch} has no upstream`, {
      retryable: true,
      nextAction: `set one with \`git branch --set-upstream-to origin/${branch}\`, then rerun ad-coder update`,
    });
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
    mode: "linked-checkout",
    checkoutDir,
    branch,
    upstream,
    previousRevision,
    revision,
    changed: revision !== previousRevision,
  };
}

/** Update either a development checkout or a global Bun GitHub installation. */
export async function updateAdCoder(options: UpdateOptions): Promise<UpdateResult> {
  const packageDir = fs.realpathSync(options.checkoutDir);
  if (fs.existsSync(path.join(packageDir, ".git"))) return updateCheckout(options);

  options.onStep?.("resolve");
  const remote = await requireCommand(
    options.run,
    packageDir,
    ["git", "ls-remote", GITHUB_REMOTE, "refs/heads/main"],
    "resolve",
  );
  const revision = remote.split(/\s+/u)[0] ?? "";
  if (!SAFE_GIT_REVISION.test(revision))
    throw new UpdateError(
      "invalid_revision",
      "main",
      "GitHub returned an invalid main revision; installation was not changed",
      {
        retryable: true,
        nextAction:
          "check network and GitHub access with `git ls-remote git@github.com:aadegtyarev/ad-coder.git refs/heads/main`, then rerun ad-coder update",
      },
    );
  const readRevision = options.readInstalledRevision ?? readInstalledRevision;
  const previousRevision = readRevision(packageDir);
  options.onStep?.("install");
  await requireCommand(
    options.run,
    packageDir,
    ["bun", "add", "--global", "--force", `${GITHUB_PACKAGE}#${revision}`],
    "install",
  );
  // A zero exit from `bun add` is not evidence: a stale lockfile pin makes Bun
  // reinstall the previous revision and still succeed. Verify what landed.
  options.onStep?.("verify");
  const installedRevision = readRevision(packageDir);
  if (installedRevision === null)
    throw new UpdateError(
      "install_unverifiable",
      packageDir,
      `bun add reported success but the installed revision could not be read from ${BUN_TAG_FILE}; the installation may be unchanged`,
      {
        retryable: false,
        nextAction: `inspect the global install with \`bun pm -g ls\`, then reinstall with \`bun add --global --force ${GITHUB_PACKAGE}#${revision}\``,
      },
    );
  if (!identifies(installedRevision, revision))
    throw new UpdateError(
      "install_mismatch",
      installedRevision,
      `bun add reported success but left ${installedRevision} installed instead of ${revision.slice(0, 12)}`,
      {
        retryable: false,
        nextAction:
          "remove the stale ad-coder entry from ~/.bun/install/global/bun.lock, then rerun ad-coder update",
      },
    );
  return {
    mode: "global-github",
    checkoutDir: packageDir,
    branch: "main",
    upstream: GITHUB_REMOTE,
    previousRevision: previousRevision ?? "unknown",
    revision,
    // An unreadable previous revision cannot prove the install was already
    // current, so the verified install is reported as a change.
    changed: previousRevision === null || !identifies(previousRevision, revision),
  };
}
