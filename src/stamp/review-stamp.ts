/**
 * The review stamp (issue #239): one committed line per reviewer round, plus
 * the verifier the gate runs.
 *
 * A stamp answers, for one review: what was reviewed (the tree digest of the
 * committed tree at review time), by which role on which model, when, the
 * verdict, and where the findings live. It is a one-line format, APPEND-ONLY,
 * so history is preserved and the LAST line is always the newest word.
 *
 * WHY ONE FILE, NOT ONE FILE PER REVIEW: the gate has to answer one question
 * -- "may the head of this branch merge?" -- and that answer is the last
 * stamp. A directory of per-review files would need a discovery rule; the log
 * makes `last` the rule.
 *
 * STALENESS IS THE POINT. The digest names the tree THAT WAS REVIEWED. The
 * verifier recomputes the CURRENT tree digest and compares; a mismatch means
 * code changed after the review, so the stamp is stale and must not pass --
 * the branch needs a fresh review round, which writes a fresh stamp.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Version prefix every stamp line starts with. Parse rejects anything else. */
export const REVIEW_STAMP_VERSION = "review-stamp-v1";

export interface ReviewStamp {
  /** sha256 over the `git ls-files -s` projection of the reviewed tree. */
  treeDigest: string;
  /** The base the review started from -- "what was reviewed" needs both. */
  base: string;
  verdict: "approved" | "changes_requested";
  /** provider/model that ran the reviewer round. */
  reviewer: string;
  /** ISO-8601 timestamp of the review, LOCAL wall clock. */
  reviewedAt: string;
  /** The role-run ids of the review round, for ledger cross-reference. */
  runIds: string[];
  /** Where the findings live; "-" when the verdict approved with none. */
  findingsRef: string;
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;

/**
 * Render one stamp. A stamp is ONE line: compact, and every field is single-
 * line -- a model cannot smuggle newlines into the format this way.
 */
export function renderReviewStamp(stamp: ReviewStamp): string {
  const fields: [string, string][] = [
    ["digest", stamp.treeDigest],
    ["base", stamp.base],
    ["verdict", stamp.verdict],
    ["reviewer", stamp.reviewer],
    ["reviewedAt", stamp.reviewedAt],
    ["findings", stamp.findingsRef],
    ...stamp.runIds.map((runId, index) => [`runId${index + 1}`, runId] as [string, string]),
  ];
  return `${REVIEW_STAMP_VERSION} ${fields
    .map(([key, value]) => `${key}:${singleLine(key, value)}`)
    .join(" ")}\n`;
}

function singleLine(key: string, value: string): string {
  if (/\r|\n/.test(value) || value.includes(" "))
    throw new Error(`review stamp field ${key} carries a newline or a space`);
  if (key === "reviewedAt" && !ISO_8601.test(value))
    throw new Error(`review stamp reviewedAt must be ISO-8601, not ${JSON.stringify(value)}`);
  return value;
}

/**
 * Parse one stamp line, strict on shape and membership. Returns an error
 * string instead of throwing for every UNPARSEABLE line, and throws nothing:
 * the caller is a gate whose failure mode is text, not an exception.
 */
export function parseReviewStamp(line: string): ReviewStamp | string {
  const text = line.trim();
  if (text === "") return "empty stamp line";
  if (!text.startsWith(REVIEW_STAMP_VERSION))
    return `stamp line must start with ${REVIEW_STAMP_VERSION}`;
  const rest = text.slice(REVIEW_STAMP_VERSION.length);
  if (!rest.startsWith(" ")) return "no separator after version";
  const stamps: Record<string, string> = {};
  for (const token of rest.slice(1).split(" ")) {
    const spelled = token.slice(0, token.indexOf(":"));
    const value = token.slice(spelled.length + 1);
    if (spelled === "" || value === "" || stamps[spelled] !== undefined)
      return `malformed stamp token ${JSON.stringify(token)}`;
    stamps[spelled] = value;
  }
  for (const needed of ["digest", "base", "verdict", "reviewer", "reviewedAt", "findings"] as const)
    if (stamps[needed] === undefined) return `stamp is missing the ${needed} field`;
  if (stamps.verdict !== "approved" && stamps.verdict !== "changes_requested")
    return `stamp verdict must be approved|changes_requested, not ${JSON.stringify(stamps.verdict)}`;
  const digest = stamps.digest as string;
  if (!/^[0-9a-f]{64}$/.test(digest))
    return `stamp digest must be a 64-hex sha256, not ${JSON.stringify(digest)}`;
  const reviewedAt = stamps.reviewedAt as string;
  if (!ISO_8601.test(reviewedAt))
    return `stamp reviewedAt must be ISO-8601, not ${JSON.stringify(reviewedAt)}`;
  const runIds: string[] = [];
  for (let index = 1; ; index++) {
    const value = stamps[`runId${index}`];
    if (value === undefined) break;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) return `stamp runId${index} is malformed`;
    runIds.push(value);
  }
  return {
    treeDigest: digest,
    base: stamps.base as string,
    verdict: stamps.verdict as "approved" | "changes_requested",
    reviewer: stamps.reviewer as string,
    reviewedAt,
    findingsRef: stamps.findings as string,
    runIds,
  };
}

/**
 * Recompute the CURRENT tree digest: over every TRACKED file's working-tree
 * CONTENT -- `git ls-files` for the path set, then a sha256 per file, all
 * folded into one sha256 in git's canonical order.
 *
 * WHY CONTENT, NOT THE INDEX: the coder's changes are usually UNCOMMITTED
 * when a review settles, and in CI the checkout has no index delta at all;
 * hashing what the working tree actually carries answers "has the reviewed
 * tree moved?" in both worlds, and keeps the answer stable across a commit
 * itself. Untracked files (state stores, node_modules) are not in `ls-files`
 * and so never count.
 *
 * The stamp log ITSELF is excluded when named: appending one stamp line
 * cannot count as "the tree moved", or the last stamp could never certify the
 * very tree that carries it. Everything else counts. (The record/check layer
 * passes the marker-configured stamps path here.)
 */
export function computeTreeDigest(repoRoot: string, excludePaths: readonly string[] = []): string {
  return computeTreeManifest(repoRoot, excludePaths).digest;
}

/**
 * The covered-path digest manifest the stamp contract speaks of
 * (docs/contracts/review-evidence.md): the SAME covered-path digest the stamp
 * digest folds, kept PER PATH so a comparison can NAME what moved instead of
 * only answering "something did". The digest is identical to
 * `computeTreeDigest`'s, by construction -- one fold, shared here.
 */
export interface TreeManifest {
  digest: string;
  /** path -> per-file content sha256 hex, one entry per covered tracked path. */
  coveredPaths: Record<string, string>;
}

export function computeTreeManifest(
  repoRoot: string,
  excludePaths: readonly string[] = [],
): TreeManifest {
  const listing = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listing.exitCode !== 0)
    throw new Error(`cannot list the tree of ${repoRoot}: ${listing.stderr.toString().trim()}`);
  const excluded = new Set(excludePaths);
  const paths = listing.stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry !== "" && !excluded.has(entry))
    .sort();
  const hasher = createHash("sha256");
  const coveredPaths: Record<string, string> = {};
  for (const entry of paths) {
    const content = fs.readFileSync(path.join(repoRoot, entry));
    const perFile = createHash("sha256").update(content).digest("hex");
    coveredPaths[entry] = perFile;
    hasher.update(`${entry}\0`);
    hasher.update(perFile);
    hasher.update("\0");
  }
  return { digest: hasher.digest("hex"), coveredPaths };
}

/**
 * The paths that moved between a captured manifest and the current one: any
 * tracked path whose content hash differs -- a deleted file reads as `undefined`
 * against its captured hash -- plus tracked paths that exist only now. Same
 * coverage as the digest: untracked paths never appear and never count.
 */
export function movedTreePaths(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  const moved: string[] = [];
  for (const [entry, perFile] of Object.entries(before))
    if (after[entry] !== perFile) moved.push(entry);
  for (const entry of Object.keys(after)) if (before[entry] === undefined) moved.push(entry);
  return moved.sort();
}

export interface ReviewStampVerification {
  ok: boolean;
  /** Typed failures: reason (what and why) plus the action that clears it. */
  failures: ReviewStampFailure[];
}

/**
 * One typed gate failure: the reason (what failed and why) plus the action
 * that clears it. The gate's fronts -- human and machine -- must carry BOTH
 * verbatim; a reason without an action leaves the operator guessing, and an
 * action without a reason asks them to trust it (issue #425).
 */
export interface ReviewStampFailure {
  reason: string;
  action: string;
}

/**
 * The recovery action EVERY stale or disapproved stamp leads to, spelled once
 * here so the messages and the fronts cannot drift apart. The stamp is never
 * written by hand: the run-finish hook derives it from the settled result.
 */
export const FRESH_STAMP_ACTION =
  "ask an independent reviewer for a fresh review round over the CURRENT tree, via a settled run; the run-finish hook (recordReviewStampFromResult) appends the fresh stamp -- never write one by hand";

/**
 * Verify one stamp against the tree the gate is running over.
 *
 * A stamp whose digest no longer matches the CURRENT tree is stale and must
 * not pass -- this re-read, not the review verdict, is the freshness gate.
 *
 * The stale reason states WHY a stamp can be stale: the reviewed tree moved,
 * and ANY commit after the review makes it stale -- dependency bumps and
 * changelog headings included; those are commits like any other, and the
 * gate does not grade them smaller.
 */
export function verifyReviewStamp(
  stamp: ReviewStamp,
  currentTreeDigest: string,
): ReviewStampFailure[] {
  const failures: ReviewStampFailure[] = [];
  if (stamp.verdict === "changes_requested")
    failures.push({
      reason: "the newest review verdict is changes_requested; merge is blocked",
      action: FRESH_STAMP_ACTION,
    });
  if (stamp.treeDigest !== currentTreeDigest)
    failures.push({
      reason: `stamp is stale: it names digest ${stamp.treeDigest.slice(0, 12)}…, the tree now hashes ${currentTreeDigest.slice(0, 12)}…; the tree moved after the review -- any later commit makes the stamp stale, package.json and the CHANGELOG heading included`,
      action: FRESH_STAMP_ACTION,
    });
  return failures;
}

/** Append one stamp line to the log file, creating the directory if needed. */
export function appendReviewStamp(repoRoot: string, stampsFile: string, stamp: ReviewStamp): void {
  const filePath = path.join(repoRoot, stampsFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, renderReviewStamp(stamp), "utf8");
}

/** Read every stamp line; returns one entry per line with its parse outcome. */
export function readReviewStamps(
  repoRoot: string,
  stampsFile: string,
): { line: string; parsed: ReviewStamp | string; index: number }[] {
  const filePath = path.join(repoRoot, stampsFile);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((entry) => entry.trim() !== "");
  return lines.map((line, index) => ({ line, parsed: parseReviewStamp(line), index }));
}
