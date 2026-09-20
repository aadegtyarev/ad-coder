// Pure-helper tests for the version gate (issue #424). Git and env side channels
// stay untested here; only decide() / compareSemver() / extractTitleVersion() /
// isMainContext() are exercised, red and green for every case.
import { describe, expect, test } from "bun:test";
import {
  compareSemver,
  decide,
  decideClaimConflict,
  extractTitleVersion,
  type GitRun,
  highestOpenClaim,
  isMainContext,
  type OpenClaim,
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
type FakeRef = { ref: string; version: string | null; merged: boolean };

function fakeGit(refs: readonly FakeRef[]): GitRun {
  return (args: string[]) => {
    const [cmd] = args;
    if (cmd === "for-each-ref")
      return { exitCode: 0, stdout: `${refs.map((r) => r.ref).join("\n")}\n`, stderr: "" };
    if (cmd === "rev-parse") return { exitCode: 0, stdout: "b32584dbdc26\n", stderr: "" };
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
const THIS_BRANCH = "feat/383-version-ladder-owner";

describe("readOpenClaims (issue #383, git via injected seam)", () => {
  test("open claims are enumerated; current branch, main and merged refs are not claims", () => {
    const result = readOpenClaims(fakeGit(LADDER), THIS_BRANCH);
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
    const result = readOpenClaims(fakeGit([remote, SELF]), THIS_BRANCH);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.map((claim) => claim.version)).toEqual(["0.135.0"]);
  });
  test("red: git unavailable is a named failure, not a silent pass", () => {
    const result = readOpenClaims(() => null, THIS_BRANCH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("git is unavailable");
  });
  test("red: an unreadable ref is a named failure naming the ref", () => {
    const broken: FakeRef = { ref: "refs/heads/broken-lane", version: null, merged: false };
    const result = readOpenClaims(fakeGit([broken, SELF]), THIS_BRANCH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("refs/heads/broken-lane");
  });
  test("red: unresolved origin/main is a named failure", () => {
    const git: GitRun = (args) => {
      const [cmd] = args;
      if (cmd === "rev-parse") return { exitCode: 128, stdout: "", stderr: "unknown revision" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = readOpenClaims(git, THIS_BRANCH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("git fetch origin main");
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
    const claims = readOpenClaims(fakeGit(LADDER), THIS_BRANCH);
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
    const claims = readOpenClaims(fakeGit([landed, SELF]), THIS_BRANCH);
    expect(claims.ok).toBe(true);
    if (claims.ok)
      expect(decideClaimConflict({ candidate: "0.137.0", claims: claims.claims }).ok).toBe(true);
  });
});
