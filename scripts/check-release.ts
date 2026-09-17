import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  version?: unknown;
};
if (
  typeof manifest.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
)
  throw new Error("package.json version must be valid SemVer");

//
// Release dates come from ONE clock, the operator's LOCAL calendar day (the day
// the release was shipped, read in the operator's timezone), stated in the
// CHANGELOG header and in docs/contracts documentation.md (2026-09-17, issue
// #243). A model that runs `date -u` on an evening between 20:00 and midnight
// local disagrees with that by one day, so this check rules the clock question
// by construction: dated release headings must be in NON-INCREASING date order
// down the file (newest first). A later-entry-dated-earlier mistake fails here
// no matter which timezone produced it.
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const escapedVersion = manifest.version.replaceAll(".", "\\.");
const release = new RegExp(`^\\#\\# \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
if (!release.test(changelog))
  throw new Error(`CHANGELOG.md has no dated heading for package version ${manifest.version}`);

const headingPattern = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/gm;
const dated: { version: string; date: string }[] = [];
for (const match of changelog.matchAll(headingPattern)) {
  const [, version, date] = match;
  if (version === undefined || date === undefined) continue;
  if (version === "Unreleased") continue;
  dated.push({ version, date });
}
if (dated.length < 2)
  throw new Error("CHANGELOG.md has fewer than two dated release headings to order-check");
const releaseDates: { version: string; date: string }[] = dated;
for (let i = 1; i < releaseDates.length; i += 1) {
  const previous = releaseDates[i - 1];
  const current = releaseDates[i];
  if (previous === undefined || current === undefined) continue;
  // File order is newest release first, so each date must be at or before the
  // previous one. An increase means an entry's date went backwards relative to
  // the release actually above it.
  if (current.date > previous.date)
    throw new Error(
      `CHANGELOG.md dates go backwards: [${current.version}] is dated ${current.date}, ` +
        `after [${previous.version}] dated ${previous.date}. ` +
        `Release dates are the operator's LOCAL date and must be in non-increasing order down the file ` +
        `(docs/contracts/documentation.md, 2026-09-17).`,
    );
}

const latest = dated[0];
if (latest === undefined) throw new Error("CHANGELOG.md has no dated release heading");
process.stdout.write(`release metadata valid: ${manifest.version} (${latest.date}, local clock)`);
