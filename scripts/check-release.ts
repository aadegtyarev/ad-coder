import * as fs from "node:fs";
import * as path from "node:path";

//
// Release dates come from ONE clock, the operator's LOCAL calendar day (the day
// the release was shipped, read in the operator's timezone), stated in the
// CHANGELOG header and in docs/contracts documentation.md (2026-09-17, issue
// #243). A model that runs `date -u` on an evening between 20:00 and midnight
// local disagrees with that by one day, so this check rules the clock question
// by construction: dated release headings must be in NON-INCREASING date order
// down the file (newest first). A later-entry-dated-earlier mistake fails here
// no matter which timezone produced it.
//
// Date order alone is not enough (issue #575): within one working day every
// block carries the SAME date, so an arrangement that is newest-date-correct
// can still be newest-VERSION-wrong -- the PR #562 rebase shipped headings
// 0.167.0, 0.171.0, 0.164.0 all dated 2026-09-21 and the gate stayed green,
// with the block the release would publish sitting UNDER an older one. Once
// dates tie, position in the file is the only signal of which block is newer,
// so dated release headings must ALSO be in non-increasing version order down
// the file: a later heading naming a greater version than the one above it
// fails here.
export interface CheckReleaseOk {
  ok: true;
  summary: string;
}
export interface CheckReleaseFail {
  ok: false;
  error: string;
}
export type CheckReleaseResult = CheckReleaseOk | CheckReleaseFail;

// "1.2.3-beta.1" -> { main: [1, 2, 3], pre: ["beta", "1"] }.
function splitSemver(v: string): { main: number[]; pre: string[] | undefined } {
  const withoutBuild = v.split("+")[0] ?? "0.0.0";
  const dashIndex = withoutBuild.indexOf("-");
  const mainPart = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex);
  const prePart = dashIndex === -1 ? undefined : withoutBuild.slice(dashIndex + 1);
  return {
    main: mainPart.split(".").map((s) => Number.parseInt(s, 10)),
    pre: prePart === undefined ? undefined : prePart.split("."),
  };
}

export function compareSemver(a: string, b: string): number {
  const left = splitSemver(a);
  const right = splitSemver(b);
  for (let i = 0; i < 3; i += 1) {
    const aSegment = left.main[i] ?? 0;
    const bSegment = right.main[i] ?? 0;
    if (aSegment !== bSegment) return aSegment - bSegment;
  }
  // SemVer 2.0.0: a release outranks its own prereleases; prerelease
  // identifiers compare numerically when numeric, lexically otherwise, and a
  // shorter identifier list ranks below a longer one with the same prefix.
  if (left.pre === undefined || right.pre === undefined)
    return (left.pre === undefined ? 1 : 0) - (right.pre === undefined ? 1 : 0);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const aId = left.pre[i];
    const bId = right.pre[i];
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    const aNum = /^\d+$/.test(aId) ? Number(aId) : null;
    const bNum = /^\d+$/.test(bId) ? Number(bId) : null;
    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum - bNum;
    } else if (aNum !== null) return -1;
    else if (bNum !== null) return 1;
    if (aId !== bId) return aId < bId ? -1 : 1;
  }
  return 0;
}

export function checkRelease(root: string): CheckReleaseResult {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  )
    return { ok: false, error: "package.json version must be valid SemVer" };

  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const escapedVersion = manifest.version.replaceAll(".", "\\.");
  const release = new RegExp(`^\\#\\# \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
  if (!release.test(changelog))
    return {
      ok: false,
      error: `CHANGELOG.md has no dated heading for package version ${manifest.version}`,
    };

  const headingPattern = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm;
  const dated: { version: string; date: string }[] = [];
  for (const match of changelog.matchAll(headingPattern)) {
    const [, version, date] = match;
    if (version === undefined || date === undefined) continue;
    if (version === "Unreleased") continue;
    dated.push({ version, date });
  }
  if (dated.length < 2)
    return {
      ok: false,
      error: "CHANGELOG.md has fewer than two dated release headings to order-check",
    };
  const releaseDates: { version: string; date: string }[] = dated;
  for (let i = 1; i < releaseDates.length; i += 1) {
    const previous = releaseDates[i - 1];
    const current = releaseDates[i];
    if (previous === undefined || current === undefined) continue;
    // File order is newest release first, so each date must be at or before the
    // previous one. An increase means an entry's date went backwards relative to
    // the release actually above it.
    if (current.date > previous.date)
      return {
        ok: false,
        error:
          `CHANGELOG.md dates go backwards: [${current.version}] is dated ${current.date}, ` +
          `after [${previous.version}] dated ${previous.date}. ` +
          `Release dates are the operator's LOCAL date and must be in non-increasing order down the file ` +
          `(docs/contracts/documentation.md, 2026-09-17).`,
      };
    // Version-order rule (issue #575): only the same-day tie is new. When the
    // dates differ, the date rule above has already said which release is
    // newer, and version order across days is governed by date order, not by
    // the file position (this changelog's real history has a 0.181.7
    // re-release on 2026-09-23 above 0.181.9 on 2026-09-22). Within one
    // working day every block carries the same date, position is the only
    // signal of which release is newer, and a greater version below a lesser
    // one fails.
    if (current.date === previous.date && compareSemver(current.version, previous.version) > 0)
      return {
        ok: false,
        error:
          `CHANGELOG.md versions go backwards: [${current.version}] sits below [${previous.version}] ` +
          `but names a greater version, and both are dated ${current.date}. Release dates are the ` +
          `operator's LOCAL day, so within one working day every block carries the same date and ` +
          `position in the file is the only signal of which release is newer -- the block the release ` +
          `would publish must sit on top. Move each newer release above the older ones of its day: ` +
          `dated release headings must be in non-increasing version order down the file as well as ` +
          `date order (issue #575, docs/contracts/documentation.md, 2026-09-25).`,
      };
  }

  const latest = dated[0];
  if (latest === undefined)
    return { ok: false, error: "CHANGELOG.md has no dated release heading" };
  return {
    ok: true,
    summary: `release metadata valid: ${manifest.version} (${latest.date}, local clock)`,
  };
}

if (import.meta.main) {
  const result = checkRelease(path.resolve(import.meta.dir, ".."));
  if (!result.ok) throw new Error(result.error);
  process.stdout.write(result.summary);
}
