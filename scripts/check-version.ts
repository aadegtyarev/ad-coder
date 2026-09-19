// Version gate (issue #424): every PR must raise package.json version STRICTLY
// above the base branch (`origin/main`), and a PR title that names a version in
// parentheses `(0.99.0)` must name exactly the tree's version. This backs the
// compatibility contract (docs/contracts/compatibility.md, 2026-09-12): every
// change merged into main carries a NEW SemVer -- PR #421 landed a merge-commit
// title reading (0.96.0) while its tree said 0.95.1, and nothing checked the
// relation to the base branch. Policy is unconditional: NO per-label exceptions
// (no docs-only, no chore), so the gate has no skip besides main itself.
import * as fs from "node:fs";
import * as path from "node:path";

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  rest: string;
}
export type Decision =
  | { ok: true; version: string; baseVersion?: string; titleVersion?: null }
  | { ok: false; message: string };

/** Parse a full SemVer string into numeric segments; null when invalid. */
function parseSemver(version: string): SemVer | null {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null;
  const core = version.split("-")[0];
  if (core === undefined) return null;
  const rest = version.split("-")[1] ?? "";
  const [major, minor, patch] = core.split(".").map(Number);
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major, minor, patch, rest };
}

/** Numeric segment comparison: 0.95.1 < 0.96.0 < 0.99.0; prerelease loses by spec. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return Number.NaN;
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (pa.rest !== pb.rest) {
    if (pa.rest === "") return 1;
    if (pb.rest === "") return -1;
    return pa.rest < pb.rest ? -1 : 1;
  }
  return 0;
}

/** First `(x.y.z...)` token from a PR title; null when the title has none. */
export function extractTitleVersion(title: string | null | undefined): string | null {
  if (typeof title !== "string" || title.length === 0) return null;
  const match = /\(\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\)/.exec(title);
  const version = match?.[1];
  return version === undefined ? null : version;
}

/** Pure skip rule: does this event run on main, where the bump check is meaningless? */
export function isMainContext(input: {
  eventName?: string | null;
  gitRef?: string | null;
  currentBranch?: string | null;
}): boolean {
  if (input.eventName === "push" && input.gitRef === "refs/heads/main") return true;
  return input.currentBranch === "main";
}

/** Pure decision: both required checks applied, in order, with actionable messages. */
export function decide(input: {
  version: string;
  baseVersion: string | null;
  title: string | null | undefined;
}): Decision {
  const { version, title } = input;
  const tree = parseSemver(version);
  if (tree === null)
    return {
      ok: false,
      message: `package.json version ${version} is not valid SemVer; fix it before merging.`,
    };
  const base = input.baseVersion === null ? null : parseSemver(input.baseVersion);
  if (input.baseVersion === null)
    return {
      ok: false,
      message:
        "base branch version unknown: origin/main could not be resolved. " +
        "Run `git fetch origin main`, then re-run `check:version`.",
    };
  if (base === null)
    return {
      ok: false,
      message: `origin/main package.json version ${input.baseVersion} is not valid SemVer; run \`git fetch origin main\` and retry.`,
    };
  if (compareSemver(version, input.baseVersion) <= 0)
    return {
      ok: false,
      message:
        `package.json version ${version} is NOT strictly above base (${input.baseVersion}). ` +
        `Raise the version in package.json strictly above ${input.baseVersion} and add a matching dated CHANGELOG.md heading ` +
        "(compatibility contract: every PR raises the version, no exceptions).",
    };
  const titleVersion = extractTitleVersion(title);
  if (titleVersion !== null && titleVersion !== version)
    return {
      ok: false,
      message:
        `PR-title version (${titleVersion}) does not match package.json version ${version}; ` +
        `make the parenthesized version in the PR title say ${version}.`,
    };
  return { ok: true, version, baseVersion: input.baseVersion, titleVersion: null };
}

function readTreeVersion(): string | null {
  const root = path.resolve(import.meta.dir, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  return typeof manifest.version === "string" ? manifest.version : null;
}

function readBaseVersion(): string | { error: string } | null {
  const ref = Bun.spawnSync(["git", "rev-parse", "--verify", "origin/main"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ref.exitCode !== 0)
    return {
      error:
        "origin/main could not be resolved, so the version gate cannot compare against the base branch. " +
        "Run `git fetch origin main`, then re-run `check:version`.",
    };
  const show = Bun.spawnSync(["git", "show", `${ref.stdout.toString().trim()}:package.json`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (show.exitCode !== 0)
    return {
      error:
        "failed to read package.json from origin/main; run `git fetch origin main` and re-run `check:version`.",
    };
  const json = JSON.parse(show.stdout.toString()) as { version?: unknown };
  return typeof json.version === "string" ? json.version : null;
}

async function main(): Promise<number> {
  const branch = Bun.spawnSync(["git", "branch", "--show-current"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (
    isMainContext({
      eventName: process.env.GITHUB_EVENT_NAME ?? null,
      gitRef: process.env.GITHUB_REF ?? null,
      currentBranch: branch.exitCode === 0 ? branch.stdout.toString().trim() : null,
    })
  ) {
    process.stdout.write(
      "check:version: skipped on main -- the bump check is relative to base and meaningless there.\n",
    );
    return 0;
  }

  const titleIndex = process.argv.indexOf("--title");
  const titleArg = titleIndex >= 0 ? process.argv[titleIndex + 1] : undefined;
  let title: string | null | undefined;
  let titleSource: string;
  if (titleArg !== undefined) {
    title = titleArg;
    titleSource = "--title argument";
  } else if (typeof process.env.PR_TITLE === "string" && process.env.PR_TITLE.length > 0) {
    title = process.env.PR_TITLE;
    titleSource = "PR_TITLE env";
  } else if (
    process.env.GITHUB_EVENT_NAME === "pull_request" &&
    process.env.GITHUB_EVENT_PATH !== undefined
  ) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    title = typeof event.pull_request?.title === "string" ? event.pull_request.title : null;
    titleSource = "GITHUB_EVENT_PATH pull_request.title";
  } else {
    title = null;
    titleSource = "";
  }
  const hasTitle = typeof title === "string" && title.length > 0;

  const baseResult = readBaseVersion();
  const baseVersion = typeof baseResult === "string" ? baseResult : null;
  const version = readTreeVersion();

  let decision: Decision;
  if (baseResult !== null && typeof baseResult === "object") {
    decision = { ok: false, message: baseResult.error };
  } else if (version === null) {
    decision = { ok: false, message: "package.json has no string version field." };
  } else {
    decision = decide({ version, baseVersion, title: hasTitle ? title : null });
  }

  if (!decision.ok) {
    process.stderr.write(`check:version: ${decision.message}\n`);
    return 1;
  }
  const titleNote = hasTitle
    ? `title version matches`
    : "no PR title available -- title check skipped";
  process.stdout.write(
    `check:version: ${decision.version} is strictly above base ${decision.baseVersion}; ` +
      `${titleSource ? `${titleNote} (${titleSource})` : titleNote}.\n`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main());
