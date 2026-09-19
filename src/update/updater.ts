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
  | "identity_unknown"
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
  mode: "linked-checkout" | "global-github" | "global-registry";
  checkoutDir: string;
  branch: string;
  upstream: string;
  previousRevision: string;
  revision: string;
  changed: boolean;
}

/**
 * The one plain-text line the update command prints for a finished run: the
 * outcome, the branch token, and the revision, named for what it holds -- a
 * whole registry version or an abbreviated Git commit (issue #364). A version
 * is never sliced: twelve characters of `0.67.0-dev.23` are the different
 * well-formed version `0.67.0-dev.2`, which read a current install as a
 * downgrade. Only a validated full-length sha is abbreviated; anything else is
 * printed whole rather than truncated into a plausible different value.
 */
export function formatUpdateResult(result: UpdateResult): string {
  const status = result.changed ? "updated" : "already current";
  const referent = result.mode === "global-registry" ? "version" : "commit";
  const value = SAFE_GIT_REVISION.test(result.revision)
    ? result.revision.slice(0, 12)
    : result.revision;
  return `ad-coder: ${status} ${result.branch} (${referent} ${value})`;
}

/** The `{name, version}` subset of the running package's package.json. */
export interface InstalledManifest {
  name?: unknown;
  version?: unknown;
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
  /**
   * Read the running package's own package.json. Injected so the registry
   * install path can establish the running identity and verify what landed
   * without touching a real install (issue #341).
   */
  readPackageManifest?: (packageDir: string) => InstalledManifest | null;
}

const GITHUB_REMOTE = "git@github.com:aadegtyarev/ad-coder.git";
const GITHUB_PACKAGE = "github:aadegtyarev/ad-coder";
const REGISTRY_UPSTREAM = "npm";
const SAFE_GIT_REVISION = /^[0-9a-f]{40}$/;
const BUN_TAG_FILE = ".bun-tag";
const SAFE_INSTALLED_REVISION = /^[0-9a-f]{7,40}$/;
const SAFE_PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

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

/** Read the installed package.json, or null when it cannot be established. */
export function readInstalledManifest(packageDir: string): InstalledManifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
    ) as InstalledManifest;
  } catch {
    return null;
  }
}

/** Whether an installed (possibly abbreviated) revision identifies the resolved one. */
function identifies(installed: string, resolved: string): boolean {
  return resolved.startsWith(installed);
}

function readManifest(options: UpdateOptions, packageDir: string): InstalledManifest | null {
  return (options.readPackageManifest ?? readInstalledManifest)(packageDir);
}

function manifestString(manifest: InstalledManifest | null, field: "name" | "version") {
  const value = manifest?.[field];
  return typeof value === "string" ? value : null;
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

/**
 * Update a global install that Bun recorded with a .bun-tag, i.e. one installed
 * from this GitHub repository. The tag is the proof of identity: whatever the
 * manifest says, a tagged install came from the GitHub package, so the install
 * command targets that package and verification reads the tag back.
 */
async function updateGitHubInstall(
  options: UpdateOptions,
  packageDir: string,
): Promise<UpdateResult> {
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

/**
 * Update a registry install (`ad-coder` or `ad-coder-dev` from npm). There is no
 * .bun-tag to verify against, so the install targets the RUNNING package by name
 * -- never a hard-coded one -- and verification reads the version the package
 * root's package.json actually carries afterwards. A zero exit from `bun add` is
 * not evidence; a stale lockfile pin can leave the previous version installed
 * and still exit zero, which fails here rather than reporting success.
 *
 * What the registry offers is resolved first, because "the version did not move"
 * on its own cannot tell a stale install from one that was already current:
 * without the resolved version an up-to-date install would read as a failure.
 */
async function updateRegistryInstall(
  options: UpdateOptions,
  packageDir: string,
  manifest: InstalledManifest | null,
): Promise<UpdateResult> {
  const name = manifestString(manifest, "name");
  const previousVersion = manifestString(manifest, "version");
  if (name === null || previousVersion === null)
    throw new UpdateError(
      "identity_unknown",
      packageDir,
      "the running package's name and version could not be read from its package.json; nothing was installed",
      {
        retryable: false,
        nextAction:
          "reinstall with `bun add --global ad-coder` (or `bun add --global ad-coder-dev` for the development channel), then rerun ad-coder update",
      },
    );
  options.onStep?.("resolve");
  const resolved = await requireCommand(
    options.run,
    packageDir,
    ["bun", "pm", "view", name, "version"],
    "resolve",
  );
  // The answer is the last whitespace-separated token, so a banner Bun prints on
  // the same stream cannot be mistaken for a version.
  const latest = resolved.split(/\s+/u).at(-1) ?? "";
  if (!SAFE_PACKAGE_VERSION.test(latest))
    throw new UpdateError(
      "invalid_revision",
      name,
      `the registry returned no usable version for ${name}; installation was not changed`,
      {
        retryable: true,
        nextAction: `check network and registry access with \`bun pm view ${name} version\`, then rerun ad-coder update`,
      },
    );
  if (latest === previousVersion)
    return {
      mode: "global-registry",
      checkoutDir: packageDir,
      branch: "latest",
      upstream: REGISTRY_UPSTREAM,
      previousRevision: previousVersion,
      revision: latest,
      // Already current: the resolved version is the installed one, so nothing
      // was installed and nothing is reported as changed.
      changed: false,
    };
  options.onStep?.("install");
  await requireCommand(
    options.run,
    packageDir,
    ["bun", "add", "--global", "--force", `${name}@latest`],
    "install",
  );
  // A zero exit from `bun add` is not evidence here either: verify that the
  // package root now carries the version the registry resolved.
  options.onStep?.("verify");
  const installedVersion = manifestString(readManifest(options, packageDir), "version");
  if (installedVersion === null)
    throw new UpdateError(
      "install_unverifiable",
      packageDir,
      `bun add reported success but the installed version could not be read from ${packageDir}/package.json; the installation may be unchanged`,
      {
        retryable: false,
        nextAction: `inspect the global install with \`bun pm -g ls\`, then reinstall with \`bun add --global --force ${name}@latest\``,
      },
    );
  if (installedVersion !== latest)
    throw new UpdateError(
      "install_mismatch",
      installedVersion,
      `bun add reported success but left ${name} at ${installedVersion} instead of ${latest}`,
      {
        retryable: false,
        nextAction: `remove the stale ${name} entry from ~/.bun/install/global/bun.lock, then rerun ad-coder update`,
      },
    );
  return {
    mode: "global-registry",
    checkoutDir: packageDir,
    branch: "latest",
    upstream: REGISTRY_UPSTREAM,
    previousRevision: previousVersion,
    revision: installedVersion,
    // Verification proved the version moved, so a registry update is a change.
    changed: true,
  };
}

/**
 * Update whichever installation is actually running: a linked Git checkout, a
 * Bun GitHub install (.bun-tag), or a registry install of the running package
 * name. The updater never installs a package whose name differs from the one
 * running (issue #341).
 */
export async function updateAdCoder(options: UpdateOptions): Promise<UpdateResult> {
  const packageDir = fs.realpathSync(options.checkoutDir);
  if (fs.existsSync(path.join(packageDir, ".git"))) return updateCheckout(options);
  if (fs.existsSync(path.join(packageDir, BUN_TAG_FILE)))
    return updateGitHubInstall(options, packageDir);
  return updateRegistryInstall(options, packageDir, readManifest(options, packageDir));
}
