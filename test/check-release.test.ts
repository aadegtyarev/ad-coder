// Tests for the release-metadata gate (issues #575 and #243). The REAL script
// logic runs against real temporary roots: the gate's property lives at the
// boundary between package.json's version and the CHANGELOG's heading order,
// so each case writes a package.json + CHANGELOG.md fixture into its own
// fs.mkdtemp root (os.tmpdir, as across test/) and runs the exported check
// against that root. No case ever touches the repository's own CHANGELOG.md.
//
// Issue #575's closure criterion, covered here case by case:
// (a) headings in non-increasing DATE order with a greater version below a
//     lesser one FAIL -- the PR #562 rebase shape (0.167.0, 0.170.0, 0.164.0
//     all dated one day) that the date rule alone let through green;
// (b) a rebased tree that puts its own (newer) block ABOVE the base's newest
//     block PASSES;
// (c) the existing date-order failure still fails with its original message,
//     and the package-version heading and two-heading minimum still hold.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkRelease, compareSemver } from "../scripts/check-release";

function tempRoot(prefix: string, changelog: string, version = "0.181.68"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "ad-coder", version }));
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
  return dir;
}

function changelog(blocks: string[]): string {
  return `# Changelog\n\n${blocks.join("\n")}\n`;
}

describe("compareSemver", () => {
  test("numeric segments beat lexicographic order", () => {
    expect(compareSemver("0.9.10", "0.9.9")).toBeGreaterThan(0);
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });
  test("a release outranks its own prereleases", () => {
    expect(compareSemver("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-beta.1", "1.0.0-beta.1")).toBe(0);
  });
});

describe("checkRelease: version order within a tied date (issue #575)", () => {
  test("red: non-increasing dates, greater version below a lesser one -- the PR #562 shape", () => {
    // The exact arrangement the issue reports: every block one working day,
    // dates non-increasing, yet the block the release would publish sits
    // UNDER an older one. The date rule alone passed this; the version rule
    // must fail it, naming the reason AND the reorder action.
    const root = tempRoot(
      "check-release-version-backwards-",
      changelog([
        "## [0.181.68] - 2026-09-25",
        "### Fixed",
        "",
        "- latest work",
        "",
        "## [0.167.0] - 2026-09-21",
        "### Fixed",
        "",
        "- older work",
        "",
        "## [0.170.0] - 2026-09-21",
        "### Fixed",
        "",
        "- the block the release would publish, wrongly under 0.167.0",
        "",
        "## [0.164.0] - 2026-09-21",
        "### Fixed",
        "",
        "- older work",
      ]),
    );
    const result = checkRelease(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("CHANGELOG.md versions go backwards");
      expect(result.error).toContain("[0.170.0] sits below [0.167.0]");
      expect(result.error).toContain("both are dated 2026-09-21");
      // Reason AND action, the file's own convention: position is the only
      // signal of which block is newer once dates tie.
      expect(result.error).toContain("position in the file is the only signal");
      expect(result.error).toContain("Move each newer release above the older ones of its day");
      expect(result.error).toContain("issue #575");
      // The failure names the contract rule it enforces, and that rule is the
      // version-order companion dated 2026-09-25, not the date rule.
      expect(result.error).toContain("docs/contracts/documentation.md, 2026-09-25");
    }
  });

  test("green: a rebased tree with its own block above the base's newest block", () => {
    // A branch rebased onto main: its own (newest) release on top, then the
    // base's same-day blocks in non-increasing version order below it.
    const root = tempRoot(
      "check-release-rebased-green-",
      changelog([
        "## [0.181.68] - 2026-09-25",
        "### Fixed",
        "",
        "- this branch's own release",
        "",
        "## [0.172.0] - 2026-09-21",
        "### Fixed",
        "",
        "- base's newest block",
        "",
        "## [0.167.0] - 2026-09-21",
        "### Fixed",
        "",
        "- base work",
        "",
        "## [0.164.0] - 2026-09-21",
        "### Fixed",
        "",
        "- base work",
      ]),
    );
    const result = checkRelease(root);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.summary).toContain(
        "release metadata valid: 0.181.68 (2026-09-25, local clock)",
      );
  });

  test("green: equal versions within a tied date are non-increasing (not a failure)", () => {
    const root = tempRoot(
      "check-release-version-equal-",
      changelog([
        "## [0.181.68] - 2026-09-25",
        "### Fixed",
        "",
        "- latest work",
        "",
        "## [0.181.68] - 2026-09-25",
        "### Fixed",
        "",
        "- same version, same day: position still says newest first",
      ]),
    );
    expect(checkRelease(root).ok).toBe(true);
  });

  test("green: a greater version ABOVE a lesser one within a tied date is correct order", () => {
    const root = tempRoot(
      "check-release-version-forward-",
      changelog([
        "## [0.181.68] - 2026-09-25",
        "### Fixed",
        "",
        "- latest work",
        "",
        "## [0.170.0] - 2026-09-21",
        "### Fixed",
        "",
        "- newer base block",
        "",
        "## [0.167.0] - 2026-09-21",
        "### Fixed",
        "",
        "- older base block",
      ]),
    );
    expect(checkRelease(root).ok).toBe(true);
  });

  test("cross-day version order stays governed by the date rule, not by version (#575 scope)", () => {
    // Real history: 0.181.7 was re-released on 2026-09-23 above 0.181.9 dated
    // 2026-09-22. Across days the DATE says which release is newer (and the
    // date rule enforces it); version order is only the signal where dates tie.
    const root = tempRoot(
      "check-release-cross-day-",
      changelog([
        "## [0.181.68] - 2026-09-25",
        "### Fixed",
        "",
        "- latest work",
        "",
        "## [0.181.7] - 2026-09-23",
        "### Fixed",
        "",
        "- re-release of an older number on a newer day",
        "",
        "## [0.181.9] - 2026-09-22",
        "### Fixed",
        "",
        "- released the day before",
      ]),
    );
    expect(checkRelease(root).ok).toBe(true);
  });
});

describe("checkRelease: the pre-existing rules keep their exact behavior", () => {
  test("red: date order going backwards still fails with the original message", () => {
    const root = tempRoot(
      "check-release-dates-backwards-",
      changelog([
        "## [0.181.68] - 2026-09-25",
        "### Fixed",
        "",
        "- latest work",
        "",
        "## [0.181.60] - 2026-09-26",
        "### Fixed",
        "",
        "- dated after the release above it",
      ]),
    );
    const result = checkRelease(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("CHANGELOG.md dates go backwards");
      expect(result.error).toContain(
        "[0.181.60] is dated 2026-09-26, after [0.181.68] dated 2026-09-25",
      );
      expect(result.error).toContain("non-increasing order down the file");
      expect(result.error).toContain("docs/contracts/documentation.md, 2026-09-17");
    }
  });

  test("red: no dated heading for the package version still fails, naming the version", () => {
    const root = tempRoot(
      "check-release-no-heading-",
      changelog(["## [0.181.66] - 2026-09-25", "### Fixed", "", "- someone else's release"]),
    );
    const result = checkRelease(root);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBe("CHANGELOG.md has no dated heading for package version 0.181.68");
  });

  test("red: fewer than two dated release headings still fails", () => {
    const root = tempRoot(
      "check-release-one-heading-",
      changelog(["## [0.181.68] - 2026-09-25", "### Fixed", "", "- the only release"]),
    );
    const result = checkRelease(root);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toBe(
        "CHANGELOG.md has fewer than two dated release headings to order-check",
      );
  });

  test("an [Unreleased] heading is skipped by the order check, as before", () => {
    const root = tempRoot(
      "check-release-unreleased-",
      changelog([
        "## [Unreleased]",
        "",
        "## [0.181.68] - 2026-09-25",
        "### Fixed",
        "",
        "- latest work",
        "",
        "## [0.181.66] - 2026-09-25",
        "### Fixed",
        "",
        "- previous release",
      ]),
    );
    const result = checkRelease(root);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.summary).toContain(
        "release metadata valid: 0.181.68 (2026-09-25, local clock)",
      );
  });
});
