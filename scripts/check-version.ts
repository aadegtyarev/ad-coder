// Version gate (issues #424 and #383): every PR must raise package.json version STRICTLY
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

//
// The version ladder has an owner (issue #383): the number a branch will land
// must be derivable at any moment from what main carries and what other open
// branches declare, so nobody has to remember the ladder and two open branches
// cannot land the same version without the gate refusing. Claims come from
// LOCAL git refs only -- no network, no other worktrees -- so the gate runs
// unchanged from any lane's own checkout. A ref already an ancestor of the
// base is not an open claim (ancestry, not dates: merged or stale work never
// locks the ladder), and an unreadable git state is named, never a silent pass.
export type GitRun = (
  args: string[],
) => { exitCode: number; stdout: string; stderr: string } | null;

/** One open branch's declared version, read from its tree's package.json. */
export interface OpenClaim {
  ref: string;
  version: string;
}

export type ClaimsResult =
  | { ok: true; claims: OpenClaim[]; note?: string }
  | { ok: false; message: string };

const GIT_UNAVAILABLE =
  "git is unavailable, so open-branch version claims cannot be read and the claim gate cannot " +
  "pass silently. Run `check:version` where git is on PATH.";

/**
 * Named state reported when HEAD is detached and no CI variable carries a
 * branch name: self cannot be known, so every ref is evaluated as a potential
 * foreign claim and the pass is not silent.
 */
const DETACHED_NO_NAME_NOTE =
  "HEAD is detached and no branch name is available (GITHUB_HEAD_REF, GITHUB_REF_NAME and " +
  "CI_COMMIT_REF_NAME are all unset), so self could not be determined and every open ref was " +
  "evaluated as a potential foreign claim.";

/** Detached fallback: first non-empty CI branch name, in that priority order. */
function envBranchName(env: Record<string, string | undefined>): string | null {
  for (const key of ["GITHUB_HEAD_REF", "GITHUB_REF_NAME", "CI_COMMIT_REF_NAME"] as const) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Enumerate open claims: candidate refs under refs/heads and refs/remotes/origin,
 * minus self -- self is the checkout's branch and its refs/remotes/origin twin
 * and is NEVER identified by commit identity (round-2 review fix, issue #383):
 * in a detached checkout an unrelated open ref that merely shares HEAD's commit
 * must stay a live claim. The branch name is the locally checked-out branch;
 * when HEAD is detached it comes from the CI environment -- GITHUB_HEAD_REF,
 * then GITHUB_REF_NAME, then CI_COMMIT_REF_NAME, empty values skipped. Detached
 * with no name in any of them: no ref is treated as self and the state is named
 * (`note`), never silent -- every ref is evaluated as a potential foreign claim,
 * so a genuine duplicate is still refused and a legitimate landing is not
 * blocked by mere commit coincidence. Then main and origin/main (the base) are
 * minus, and every ref already an ancestor of the base (merged or stale). Git
 * and env are injected so tests need no real branches and no network;
 * unavailable git or an unreadable ref is a named failure, never a silent pass.
 */
export function readOpenClaims(
  git: GitRun,
  env: Record<string, string | undefined> = {},
): ClaimsResult {
  const listing = git([
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads",
    "refs/remotes/origin",
  ]);
  if (listing === null) return { ok: false, message: GIT_UNAVAILABLE };
  if (listing.exitCode !== 0)
    return {
      ok: false,
      message: `git for-each-ref failed, so open claims cannot be enumerated: ${listing.stderr.trim()}`,
    };
  const refs = listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const sep = line.indexOf(" ");
      return sep < 0 ? line : line.slice(0, sep);
    });
  const baseRev = git(["rev-parse", "--verify", "refs/remotes/origin/main"]);
  if (baseRev === null) return { ok: false, message: GIT_UNAVAILABLE };
  if (baseRev.exitCode !== 0)
    return {
      ok: false,
      message:
        "refs/remotes/origin/main could not be resolved, so merged refs cannot be told from open " +
        "claims. Run `git fetch origin main`, then re-run `check:version`.",
    };
  const base = baseRev.stdout.trim();
  const symref = git(["symbolic-ref", "-q", "--short", "HEAD"]);
  if (symref === null) return { ok: false, message: GIT_UNAVAILABLE };
  const local = symref.exitCode === 0 ? symref.stdout.trim() : "";
  const branch = local.length > 0 ? local : envBranchName(env);
  const claims: OpenClaim[] = [];
  for (const ref of refs) {
    if (
      branch !== null &&
      (ref === `refs/heads/${branch}` || ref === `refs/remotes/origin/${branch}`)
    )
      continue;
    if (ref === "refs/heads/main" || ref === "refs/remotes/origin/main") continue;
    const ancestry = git(["merge-base", "--is-ancestor", ref, base]);
    if (ancestry === null) return { ok: false, message: GIT_UNAVAILABLE };
    if (ancestry.exitCode === 0) continue;
    if (ancestry.exitCode > 1)
      return {
        ok: false,
        message: `git merge-base --is-ancestor failed for ${ref}, so its claim is unknown: ${ancestry.stderr.trim()}`,
      };
    const show = git(["show", `${ref}:package.json`]);
    if (show === null) return { ok: false, message: GIT_UNAVAILABLE };
    if (show.exitCode !== 0)
      return {
        ok: false,
        message: `package.json on ${ref} could not be read, so its claim is unknown: ${show.stderr.trim()}`,
      };
    let version: unknown;
    try {
      version = (JSON.parse(show.stdout) as { version?: unknown }).version;
    } catch {
      return {
        ok: false,
        message: `package.json on ${ref} is not valid JSON, so its claim is unknown; fix or land the branch.`,
      };
    }
    if (typeof version !== "string" || version.length === 0)
      return {
        ok: false,
        message: `package.json on ${ref} has no string version field, so its claim is unknown; fix or land the branch.`,
      };
    claims.push({ ref, version });
  }
  if (branch === null) return { ok: true, claims, note: DETACHED_NO_NAME_NOTE };
  return { ok: true, claims };
}

/**
 * The ladder the PASSING gate derived, in the gate's own output shape (issue
 * #383, review round 5): the base it compared against and every foreign open
 * claim it evaluated, each with the version that ref declares, and an explicit
 * `none` when there were no others. The outcome the issue asks for is that the
 * number a branch will land is answerable from the tree alone -- and answering
 * it from the gate's own output, rather than by re-running git by hand, is what
 * makes that property usable. Deterministic: `readOpenClaims` walks refs in
 * `for-each-ref` order, which is refname order.
 */
export function ladderLedger(input: { baseVersion: string; claims: readonly OpenClaim[] }): string {
  const claimed =
    input.claims.length === 0
      ? "none"
      : input.claims.map((claim) => `${claim.ref} declares ${claim.version}`).join(", ");
  return `base origin/main declares ${input.baseVersion}; open claims evaluated: ${claimed}`;
}

/** Highest open claim by SemVer order; null when no claim parses. */
export function highestOpenClaim(claims: readonly OpenClaim[]): string | null {
  let best: string | null = null;
  for (const claim of claims) {
    if (parseSemver(claim.version) === null) continue;
    if (best === null || compareSemver(claim.version, best) > 0) best = claim.version;
  }
  return best;
}

/** Pure decision: is the candidate already claimed by another open branch? */
export function decideClaimConflict(input: {
  candidate: string;
  claims: readonly OpenClaim[];
}): Decision {
  const claiming = input.claims.filter((claim) => claim.version === input.candidate);
  if (claiming.length === 0) return { ok: true, version: input.candidate };
  const refs = claiming.map((claim) => claim.ref).join(", ");
  const highest = highestOpenClaim(input.claims);
  const fix =
    highest !== null
      ? `above the highest open claim (${highest})`
      : "above every version other open branches declare";
  return {
    ok: false,
    message:
      `package.json version ${input.candidate} is already claimed by another open branch: ${refs}. ` +
      "The ladder is derived, not remembered: main carries the base and every open branch declares " +
      "its number, so two branches cannot land the same one. " +
      `Raise this branch's version in package.json ${fix}, or land the claiming branch first, ` +
      "then re-run `check:version`.",
  };
}

/** Production seam: run a git command; null only when git itself is unusable. */
function runGit(args: string[]): ReturnType<GitRun> {
  try {
    const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch {
    return null;
  }
}

function readTreeVersion(): string | null {
  const root = path.resolve(import.meta.dir, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  return typeof manifest.version === "string" ? manifest.version : null;
}

/**
 * Named refusal when git itself cannot run at the gate's direct reads (base
 * version, current branch): a missing or unusable git executable is a named,
 * actionable failure -- never an unhandled crash.
 */
const GATE_GIT_UNAVAILABLE =
  "git is unavailable, so the base version and current branch cannot be read and the version gate cannot " +
  "pass silently. Run `check:version` where git is on PATH.";

/**
 * Read the base version from origin/main's package.json. Git is injected for
 * tests and defaults to the production seam; unavailable git is a named error,
 * never a throw.
 */
export function readBaseVersion(git: GitRun = runGit): string | { error: string } | null {
  const ref = git(["rev-parse", "--verify", "origin/main"]);
  if (ref === null) return { error: GATE_GIT_UNAVAILABLE };
  if (ref.exitCode !== 0)
    return {
      error:
        "origin/main could not be resolved, so the version gate cannot compare against the base branch. " +
        "Run `git fetch origin main`, then re-run `check:version`.",
    };
  const show = git(["show", `${ref.stdout.trim()}:package.json`]);
  if (show === null) return { error: GATE_GIT_UNAVAILABLE };
  if (show.exitCode !== 0)
    return {
      error:
        "failed to read package.json from origin/main; run `git fetch origin main` and re-run `check:version`.",
    };
  const json = JSON.parse(show.stdout) as { version?: unknown };
  return typeof json.version === "string" ? json.version : null;
}

/**
 * The gate's process boundary, injected for tests (issue #383 round-6 review).
 * It exists so a test can run the executable path itself -- `main` with an
 * injected git runner, environment and writers -- because a formatter-only test
 * keeps passing after the print that exposes the ladder to the operator is
 * removed, which is the regression this gate is here to catch.
 */
export interface GateIo {
  git: GitRun;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultGateIo: GateIo = {
  git: runGit,
  env: process.env,
  out: (line) => process.stdout.write(line),
  err: (line) => process.stderr.write(line),
};

export async function main(io: GateIo = defaultGateIo): Promise<number> {
  const branch = io.git(["branch", "--show-current"]);
  if (branch === null) {
    io.err(`check:version: ${GATE_GIT_UNAVAILABLE}\n`);
    return 1;
  }
  const currentBranch = branch.exitCode === 0 ? branch.stdout.trim() || null : null;
  if (
    isMainContext({
      eventName: io.env.GITHUB_EVENT_NAME ?? null,
      gitRef: io.env.GITHUB_REF ?? null,
      currentBranch,
    })
  ) {
    io.out(
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
  } else if (typeof io.env.PR_TITLE === "string" && io.env.PR_TITLE.length > 0) {
    title = io.env.PR_TITLE;
    titleSource = "PR_TITLE env";
  } else if (
    io.env.GITHUB_EVENT_NAME === "pull_request" &&
    io.env.GITHUB_EVENT_PATH !== undefined
  ) {
    const event = JSON.parse(fs.readFileSync(io.env.GITHUB_EVENT_PATH, "utf8"));
    title = typeof event.pull_request?.title === "string" ? event.pull_request.title : null;
    titleSource = "GITHUB_EVENT_PATH pull_request.title";
  } else {
    title = null;
    titleSource = "";
  }
  const hasTitle = typeof title === "string" && title.length > 0;

  const baseResult = readBaseVersion(io.git);
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
    io.err(`check:version: ${decision.message}\n`);
    return 1;
  }
  // Ladder owner (issue #383): the number must also be free of claims by other
  // open branches, derived from local refs; an unreadable state is named above.
  const claims = readOpenClaims(io.git, io.env);
  if (!claims.ok) {
    io.err(`check:version: ${claims.message}\n`);
    return 1;
  }
  // Round-2 review fix (#383): a detached checkout without a CI branch name
  // cannot know self, so every ref is a potential foreign claim; that state is
  // named here rather than passed silently, and a refusal below still stands.
  if (claims.note !== undefined) io.err(`check:version: ${claims.note}\n`);
  const claimDecision = decideClaimConflict({
    candidate: decision.version,
    claims: claims.claims,
  });
  if (!claimDecision.ok) {
    io.err(`check:version: ${claimDecision.message}\n`);
    return 1;
  }
  const titleNote = hasTitle
    ? `title version matches`
    : "no PR title available -- title check skipped";
  io.out(
    `check:version: ${decision.version} is strictly above base ${decision.baseVersion} ` +
      `and unclaimed by other open branches; ${titleSource ? `${titleNote} (${titleSource})` : titleNote}.\n`,
  );
  // Round-5 review fix (#383): the pass prints the ladder it derived, so the
  // number this branch will land is readable from the gate's own output instead
  // of being re-derived with git by hand. `decide` refuses an unresolved base,
  // so this guard cannot fire for the version gate itself -- it exists because
  // the ladder would be meaningless without the base it compared against, and a
  // gate that cannot state its ladder must refuse rather than print a pass.
  if (baseVersion === null) {
    io.err(
      "check:version: the base version was not resolved, so the version ladder cannot be " +
        "reported. Run `git fetch origin main`, then re-run `check:version`.\n",
    );
    return 1;
  }
  io.out(`check:version: ladder: ${ladderLedger({ baseVersion, claims: claims.claims })}.\n`);
  return 0;
}

if (import.meta.main) process.exit(await main());
