// Pure-helper tests for the version gate (issue #424). Git and env side channels
// stay untested here; only decide() / compareSemver() / extractTitleVersion() /
// isMainContext() are exercised, red and green for every case.
import { describe, expect, test } from "bun:test";
import {
  compareSemver,
  decide,
  extractTitleVersion,
  isMainContext,
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
