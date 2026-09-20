// Pure-helper tests for the version gate (issues #424 and #383). Git and env
// side channels run through injected seams -- no real branches, no network, no
// real process env -- and compareSemver() / extractTitleVersion() /
// isMainContext() / decide() / readOpenClaims() are exercised, red and green
// for every case.
import { describe, expect, test } from "bun:test";
import {
  compareSemver,
  decide,
  decideClaimConflict,
  extractTitleVersion,
  type GitRun,
  highestOpenClaim,
  isMainContext,
  ladderLedger,
  type OpenClaim,
  readBaseVersion,
  readOpenClaims,
} from "../scripts/check-version";

describe("compareSemver", () => {
  test("numeric segments beat lexicographic order", () => {
    expect(compareSemver("0.95.1", "0.96.0")).toBe(-1);
    expect(compareSemver("0.96.0", "0.99.0")).toBe(-1);
    expect(compareSemver("0.99.0", "0.100.0")).toBe(-1);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });
});

describe("extractTitleVersion", () => {
  test("finds the parenthesized version", () => {
    expect(extractTitleVersion("feat(#424): version bump (0.99.0)")).toBe("0.99.0");
    expect(extractTitleVersion("feat(#424): bump (1.2.3-beta.1) merge")).toBe("1.2.3-beta.1");
  });
  test("returns null when the title has none or no title exists", () => {
    expect(extractTitleVersion("feat(#414): no version here")).toBeNull();
    expect(extractTitleVersion("")).toBeNull();
    expect(extractTitleVersion(null)).toBeNull();
  });
});

describe("isMainContext", () => {
  test("push to main (GitHub event) skips", () => {
    expect(
      isMainContext({ eventName: "push", gitRef: "refs/heads/main", currentBranch: null }),
    ).toBe(true);
  });
  test("local main branch skips", () => {
    expect(isMainContext({ eventName: null, gitRef: null, currentBranch: "main" })).toBe(true);
  });
  test("PR runs and other branches do not skip", () => {
    expect(
      isMainContext({
        eventName: "pull_request",
        gitRef: "refs/pull/424/merge",
        currentBranch: "feat/424-version-gate",
      }),
    ).toBe(false);
    expect(
      isMainContext({ eventName: "push", gitRef: "refs/heads/main", currentBranch: "other" }),
    ).toBe(true);
  });
});

describe("decide", () => {
  const base = "0.95.1";
  test("red: tree version below base", () => {
    const result = decide({ version: "0.95.0", baseVersion: base, title: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("0.95.0");
  });
  test("red: tree version equal to base, both named with next action", () => {
    const result = decide({ version: "0.95.1", baseVersion: base, title: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("0.95.1");
      expect(result.message).toContain("NOT strictly above");
      expect(result.message).toContain("CHANGELOG");
    }
  });
  test("green: tree version strictly above base", () => {
    const result = decide({ version: "0.99.0", baseVersion: base, title: null });
    expect(result.ok).toBe(true);
  });
  test("red: PR-title version diverges from package.json, both named", () => {
    const result = decide({
      version: "0.99.0",
      baseVersion: base,
      title: "feat(#424): gate (0.96.0)",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("0.96.0");
      expect(result.message).toContain("0.99.0");
    }
  });
  test("red: title version matches, but base check still rules", () => {
    expect(decide({ version: "0.95.1", baseVersion: base, title: "bump (0.95.1)" }).ok).toBe(false);
  });
  test("green: title without a parenthesized version silently passes", () => {
    expect(
      decide({ version: "0.99.0", baseVersion: base, title: "feat(#424): version gate" }).ok,
    ).toBe(true);
  });
  test("green: title version matching", () => {
    expect(
      decide({ version: "0.99.0", baseVersion: base, title: "feat(#424): gate (0.99.0)" }).ok,
    ).toBe(true);
  });
  test("no title available: decision governed only by the bump check", () => {
    expect(decide({ version: "0.99.0", baseVersion: base, title: null }).ok).toBe(true);
    expect(decide({ version: "0.95.1", baseVersion: base, title: null }).ok).toBe(false);
  });
  test("red: base cannot be resolved asks for git fetch", () => {
    const result = decide({ version: "0.99.0", baseVersion: null, title: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("git fetch origin main");
  });
});

// Ladder owner (issue #383): the git-derived half runs through an injected
// runner -- no real branches, no network, no other worktrees are touched.
type FakeRef = { ref: string; version: string | null; merged: boolean; commit?: string };

// The injected checkout: HEAD's commit and, when attached, the branch HEAD names.
type FakeHead = { commit: string | null; branch: string | null };
const THIS_BRANCH = "feat/383-version-ladder-owner";
const HEAD_SHA = "0f9d1e2a4b5c";
const ATTACHED: FakeHead = { commit: HEAD_SHA, branch: THIS_BRANCH };
const DETACHED: FakeHead = { commit: HEAD_SHA, branch: null };

function fakeGit(refs: readonly FakeRef[], head: FakeHead = ATTACHED): GitRun {
  return (args: string[]) => {
    const [cmd] = args;
    if (cmd === "for-each-ref")
      return {
        exitCode: 0,
        stdout: `${refs.map((r) => `${r.ref} ${r.commit ?? `sha-${r.ref}`}`).join("\n")}\n`,
        stderr: "",
      };
    if (cmd === "rev-parse") {
      if (args[1] === "HEAD")
        return head.commit === null
          ? { exitCode: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'" }
          : { exitCode: 0, stdout: `${head.commit}\n`, stderr: "" };
      return { exitCode: 0, stdout: "b32584dbdc26\n", stderr: "" };
    }
    if (cmd === "symbolic-ref")
      return head.branch === null
        ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: `${head.branch}\n`, stderr: "" };
    if (cmd === "merge-base") {
      const entry = refs.find((r) => r.ref === args[2]);
      return { exitCode: entry?.merged ? 0 : 1, stdout: "", stderr: "" };
    }
    if (cmd === "show") {
      const ref = args[1]?.split(":")[0] ?? "";
      const entry = refs.find((r) => r.ref === ref);
      if (entry === undefined || entry.version === null)
        return { exitCode: 128, stdout: "", stderr: "fatal: path 'package.json' does not exist" };
      return {
        exitCode: 0,
        stdout: JSON.stringify({ name: "ad-coder", version: entry.version }),
        stderr: "",
      };
    }
    return { exitCode: 2, stdout: "", stderr: `unexpected command: ${String(cmd)}` };
  };
}

const LANE_A: FakeRef = {
  ref: "refs/heads/fix/458-typed-pause-causes",
  version: "0.135.0",
  merged: false,
};
const LANE_B: FakeRef = {
  ref: "refs/heads/fix/501-console-output",
  version: "0.135.0",
  merged: false,
};
const LANE_C: FakeRef = {
  ref: "refs/heads/fix/511-role-stage-limits-factory",
  version: "0.136.0",
  merged: false,
};
const MERGED: FakeRef = {
  ref: "refs/heads/feat/424-version-gate",
  version: "0.99.0",
  merged: true,
};
const SELF: FakeRef = {
  ref: "refs/heads/feat/383-version-ladder-owner",
  version: "0.137.0",
  merged: false,
};
const LADDER: FakeRef[] = [LANE_A, LANE_B, LANE_C, MERGED, SELF];

describe("readOpenClaims (issue #383, git via injected seam)", () => {
  test("open claims are enumerated; current branch, main and merged refs are not claims", () => {
    const result = readOpenClaims(fakeGit(LADDER));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.claims.map((claim) => claim.ref)).toEqual([LANE_A.ref, LANE_B.ref, LANE_C.ref]);
  });
  test("a refs/remotes/origin claim reads the same as a head", () => {
    const remote: FakeRef = {
      ref: "refs/remotes/origin/fix/501-console-output",
      version: "0.135.0",
      merged: false,
    };
    const result = readOpenClaims(fakeGit([remote, SELF]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.map((claim) => claim.version)).toEqual(["0.135.0"]);
  });
  test("red: git unavailable is a named failure, not a silent pass", () => {
    const result = readOpenClaims(() => null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("git is unavailable");
  });
  test("red: an unreadable ref is a named failure naming the ref", () => {
    const broken: FakeRef = { ref: "refs/heads/broken-lane", version: null, merged: false };
    const result = readOpenClaims(fakeGit([broken, SELF]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("refs/heads/broken-lane");
  });
  test("red: unresolved origin/main is a named failure", () => {
    const git: GitRun = (args) => {
      const [cmd] = args;
      if (cmd === "rev-parse") return { exitCode: 128, stdout: "", stderr: "unknown revision" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = readOpenClaims(git);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("git fetch origin main");
  });
});

// Round-2 review fix (#383): in a detached checkout self is NEVER guessed from
// commit identity -- an unrelated open ref sharing HEAD's commit must stay a
// live claim. The detached branch name comes from the CI environment; with no
// name anywhere, nothing is self, the state is named, and every ref is
// evaluated as a potential foreign claim.
describe("readOpenClaims in a detached checkout (#383 round-2 review fix): self by name or named, never by commit", () => {
  const selfAtHead = { ...SELF, commit: HEAD_SHA };
  const twinAtHead: FakeRef = {
    ref: `refs/remotes/origin/${THIS_BRANCH}`,
    version: SELF.version,
    merged: false,
    commit: HEAD_SHA,
  };
  const UNRELATED_AT_HEAD: FakeRef = {
    ref: "refs/heads/unrelated-open-lane",
    version: SELF.version,
    merged: false,
    commit: HEAD_SHA,
  };
  test("green: detached HEAD with a branch name in the environment -- that branch and its origin twin are self", () => {
    const result = readOpenClaims(fakeGit([selfAtHead, twinAtHead], DETACHED), {
      GITHUB_HEAD_REF: THIS_BRANCH,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).toEqual([]);
      expect(result.note).toBeUndefined();
    }
  });
  test("red: detached with a name, an unrelated ref at the same commit is NOT swallowed -- its claim is refused", () => {
    const result = readOpenClaims(fakeGit([selfAtHead, twinAtHead, UNRELATED_AT_HEAD], DETACHED), {
      GITHUB_HEAD_REF: THIS_BRANCH,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.map((claim) => claim.ref)).toEqual([UNRELATED_AT_HEAD.ref]);
      expect(decideClaimConflict({ candidate: "0.137.0", claims: result.claims }).ok).toBe(false);
    }
  });
  test("the detached name falls back GITHUB_HEAD_REF, then GITHUB_REF_NAME, then CI_COMMIT_REF_NAME, empty values skipped", () => {
    const selfRefsFor = (env: Record<string, string | undefined>) => {
      const result = readOpenClaims(fakeGit([selfAtHead, twinAtHead], DETACHED), env);
      expect(result.ok).toBe(true);
      return result.ok ? result.claims.map((claim) => claim.ref) : [];
    };
    expect(selfRefsFor({ GITHUB_HEAD_REF: THIS_BRANCH, GITHUB_REF_NAME: "other" })).toEqual([]);
    expect(selfRefsFor({ GITHUB_HEAD_REF: "", GITHUB_REF_NAME: THIS_BRANCH })).toEqual([]);
    expect(
      selfRefsFor({ GITHUB_HEAD_REF: "", GITHUB_REF_NAME: "", CI_COMMIT_REF_NAME: THIS_BRANCH }),
    ).toEqual([]);
  });
  test("named state: detached HEAD with NO branch name reports it and evaluates every ref as a foreign claim", () => {
    const result = readOpenClaims(fakeGit([LANE_A, selfAtHead, twinAtHead], DETACHED), {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.note).toContain("self could not be determined");
      expect(result.note).toContain("detached");
      expect(result.claims.map((claim) => claim.ref)).toEqual([
        LANE_A.ref,
        selfAtHead.ref,
        twinAtHead.ref,
      ]);
      expect(decideClaimConflict({ candidate: "0.135.0", claims: result.claims }).ok).toBe(false);
    }
  });
  test("red: detached HEAD with a genuinely foreign open claim is still counted and refused", () => {
    const result = readOpenClaims(fakeGit([LANE_A], DETACHED), {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.map((claim) => claim.ref)).toEqual([LANE_A.ref]);
      expect(decideClaimConflict({ candidate: "0.135.0", claims: result.claims }).ok).toBe(false);
    }
  });
  test("green: the current branch's remote-tracking twin is not a foreign claim", () => {
    const twin: FakeRef = {
      ref: `refs/remotes/origin/${THIS_BRANCH}`,
      version: "0.137.0",
      merged: false,
      commit: "remote-sha-different-from-head",
    };
    const result = readOpenClaims(fakeGit([twin], ATTACHED));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims).toEqual([]);
  });
});

describe("decideClaimConflict (issue #383)", () => {
  const openClaims: OpenClaim[] = [LANE_A, LANE_B, LANE_C].map(({ ref, version }) => ({
    ref,
    version: version as string,
  }));
  test("green: a number nobody claims passes", () => {
    expect(decideClaimConflict({ candidate: "0.137.0", claims: openClaims })).toEqual({
      ok: true,
      version: "0.137.0",
    });
  });
  test("red: a claimed number is refused naming version, claiming ref, and the fix", () => {
    const result = decideClaimConflict({ candidate: "0.135.0", claims: openClaims });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("0.135.0");
      expect(result.message).toContain("refs/heads/fix/458-typed-pause-causes");
      expect(result.message).toContain("0.136.0");
      expect(result.message).toContain("land the claiming branch first");
    }
  });
  test("highestOpenClaim: SemVer order over open claims, null when empty", () => {
    expect(highestOpenClaim(openClaims)).toBe("0.136.0");
    expect(highestOpenClaim([])).toBeNull();
  });
});

describe("the version ladder end to end (#383): both ways of being wrong, one seam", () => {
  function ladderGate(input: { version: string; baseVersion: string | null }) {
    const claims = readOpenClaims(fakeGit(LADDER));
    if (!claims.ok) return { ok: false as const, message: claims.message };
    const conflict = decideClaimConflict({ candidate: input.version, claims: claims.claims });
    if (!conflict.ok) return { ok: false as const, message: conflict.message };
    return decide({ version: input.version, baseVersion: input.baseVersion, title: null });
  }
  test("green: branch above main, number nobody claims -- a normal single landing", () => {
    expect(ladderGate({ version: "0.137.0", baseVersion: "0.134.0" }).ok).toBe(true);
  });
  test("red: a duplicate claim is refused naming the other ref", () => {
    const result = ladderGate({ version: "0.135.0", baseVersion: "0.134.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("refs/heads/fix/458-typed-pause-causes");
  });
  test("red: a version at or below main is refused even when nobody claims it", () => {
    const result = ladderGate({ version: "0.134.0", baseVersion: "0.134.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("NOT strictly above");
  });
  test("green: a ref already merged into main does NOT block -- no permanent lock", () => {
    const landed: FakeRef = { ref: "refs/heads/landed-lane", version: "0.137.0", merged: true };
    const claims = readOpenClaims(fakeGit([landed, SELF]));
    expect(claims.ok).toBe(true);
    if (claims.ok)
      expect(decideClaimConflict({ candidate: "0.137.0", claims: claims.claims }).ok).toBe(true);
  });
  test("green: the passing gate prints the ladder it derived, claim by claim (#383 round-5 review)", () => {
    // The pass used to state the conclusion only -- "unclaimed by other open
    // branches" -- which is not the same as the ladder: an operator could not
    // tell which refs were evaluated, or what each declares, without re-running
    // git by hand. Legibility of the ladder IS the outcome the issue asks for,
    // so the ledger is asserted through the same seam the gate composes it from.
    const claims = readOpenClaims(fakeGit(LADDER));
    expect(claims.ok).toBe(true);
    if (!claims.ok) return;
    const ledger = ladderLedger({ baseVersion: "0.134.0", claims: claims.claims });
    expect(claims.claims.length).toBeGreaterThan(0);
    expect(ledger).toContain("base origin/main declares 0.134.0");
    for (const claim of claims.claims) {
      expect(ledger).toContain(`${claim.ref} declares ${claim.version}`);
    }
    // An empty ledger says `none` in words, rather than printing an empty list
    // that reads like a missing line.
    expect(ladderLedger({ baseVersion: "0.134.0", claims: [] })).toContain(
      "open claims evaluated: none",
    );
  });
});

// Review fix: the gate's direct git reads (base version from origin/main,
// current branch) run through the same failure boundary as the claim reads --
// unavailable git is a named, actionable refusal on the `check:version:`
// stderr channel with exit 1, never an unhandled "Executable not found" crash.
describe("readBaseVersion (git via injected seam)", () => {
  const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

  test("green: reads the version from origin/main's package.json", () => {
    const git: GitRun = (args) => {
      const [cmd, ref] = args;
      if (cmd === "rev-parse") return { exitCode: 0, stdout: `${BASE_SHA}\n`, stderr: "" };
      if (cmd === "show" && ref === `${BASE_SHA}:package.json`)
        return { exitCode: 0, stdout: JSON.stringify({ version: "0.139.0" }), stderr: "" };
      return { exitCode: 2, stdout: "", stderr: `unexpected command: ${String(cmd)}` };
    };
    expect(readBaseVersion(git)).toBe("0.139.0");
  });
  test("red: unresolved origin/main still refuses with fetch-first guidance", () => {
    const git: GitRun = (args) => {
      const [cmd] = args;
      if (cmd === "rev-parse") return { exitCode: 128, stdout: "", stderr: "unknown revision" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = readBaseVersion(git);
    expect(typeof result).toBe("object");
    if (typeof result === "object" && result !== null) {
      expect(result.error).toContain("origin/main could not be resolved");
      expect(result.error).toContain("git fetch origin main");
    }
  });
  test("red: git unavailable (seam returns null) is a named, actionable refusal, not a throw", () => {
    const result = readBaseVersion(() => null);
    expect(result).not.toBeNull();
    if (typeof result === "object" && result !== null) {
      expect(result.error).toContain("git is unavailable");
      expect(result.error).toContain("git is on PATH");
    }
  });
  test("red: git dying before the show (seam nulls the second read) is the same named refusal", () => {
    const git: GitRun = (args) => {
      const [cmd] = args;
      if (cmd === "rev-parse") return { exitCode: 0, stdout: `${BASE_SHA}\n`, stderr: "" };
      return null;
    };
    const result = readBaseVersion(git);
    expect(result).not.toBeNull();
    if (typeof result === "object" && result !== null)
      expect(result.error).toContain("git is unavailable");
  });
});
