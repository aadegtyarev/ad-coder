/**
 * The settle path that writes the review stamp (issue #239).
 *
 * The orchestrator must not be able to FORGET the stamp, so a model is never
 * its author: this hook runs on the same code path that already knows the run
 * finished, and derives every field from structured data the run produced --
 * the reviewer's verdict, the per-stage provider/model, and the run ids. The
 * prompt is not consulted; the ledger is not read back; nothing to remember.
 *
 * SCOPE (strict, per the operator's 2026-09-17 statement on #239/#240): this
 * is a feature of THIS repository, not of the harness. Ad-coder runs on other
 * people's repositories, and writing stamp files into their work would put
 * ad-coder's bookkeeping into the target's diff. The on-switch is therefore a
 * marker file IN THE TARGET (this repo commits
 * `ad-coder.stamps.json`; any other target simply does not have it), the
 * default is OFF everywhere, and the rule is contract-dated in
 * docs/contracts/product-change.md so no later change "generalises" it into a
 * harness-wide behavior.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineResult } from "../orchestration/types";
import {
  appendReviewStamp,
  computeTreeDigest,
  type ReviewStamp,
  type ReviewStampVerification,
  readReviewStamps,
  verifyReviewStamp,
} from "./review-stamp";

/** The committed marker that turns stamp writing on for one repository. */
export const STAMPS_MARKER_FILE = "ad-coder.stamps.json";

export interface StampsMarkerConfig {
  /** Committed log file the stamps append to (repo-relative). */
  file?: string;
}

/** Marker config; undefined when the target is not stamped (the everywhere default). */
export function readStampsMarker(repoRoot: string): StampsMarkerConfig | undefined {
  const markerPath = path.join(repoRoot, STAMPS_MARKER_FILE);
  if (!fs.existsSync(markerPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`malformed ${STAMPS_MARKER_FILE}: cannot parse (${String(error)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`malformed ${STAMPS_MARKER_FILE}: must be a JSON object`);
  for (const key of Object.keys(parsed as Record<string, unknown>))
    if (key !== "file") throw new Error(`unknown field ${key} in ${STAMPS_MARKER_FILE}`);
  const file = (parsed as { file?: unknown }).file;
  if (file !== undefined && (typeof file !== "string" || file === ""))
    throw new Error(`${STAMPS_MARKER_FILE}: file must be a non-empty repo-relative path`);
  return file === undefined ? {} : { file };
}

export interface ReviewStampOutcome {
  recorded: boolean;
  /** Why no stamp was written; absent when one was. */
  skippedBecause?: string;
  filePath?: string;
}

/**
 * Derive and append the stamp, from the settled result only.
 *
 * A run with `reviewRan: false` writes NOTHING -- there was no review, and a
 * stamp must never certify silence. `changes_requested` results DO stamp: the
 * merge gate reads the newest verdict, and "theReviewer said no" is a fact
 * the gate should be able to see, not re-derive from prose.
 */
export function recordReviewStampFromResult(
  repoRoot: string,
  result: PipelineResult,
  now: Date = new Date(),
): ReviewStampOutcome {
  const marker = readStampsMarker(repoRoot);
  if (marker === undefined)
    return { recorded: false, skippedBecause: "target is not a stamp-writing repository" };
  if (result.reviewRan === false)
    return { recorded: false, skippedBecause: "the run settled without a review round" };
  const lastMetrics = result.stageMetrics.filter((entry) => entry.stage.startsWith("review:"));
  const reviewerMetrics = lastMetrics[lastMetrics.length - 1];
  const filePath = marker.file ?? "docs/reviews/stamps.log";
  const stamp: ReviewStamp = {
    // The digest excludes the stamp log itself: appending one stamp line
    // cannot count as the tree moving (src/stamp/review-stamp.ts).
    treeDigest: computeTreeDigest(repoRoot, [filePath]),
    base: safeBase(repoRoot),
    verdict: result.approved ? "approved" : "changes_requested",
    reviewer: `${reviewerMetrics?.provider ?? "?"}/${reviewerMetrics?.model ?? "?"}`,
    reviewedAt: localIsoNow(now),
    runIds: result.runIds,
    findingsRef: filePath,
  };
  try {
    appendReviewStamp(repoRoot, filePath, stamp);
  } catch (error) {
    throw new Error(`could not write the review stamp to ${filePath}: ${String(error)}`);
  }
  return { recorded: true, filePath };
}

/** Local-wall-clock ISO-8601 with the machine's own UTC offset. */
export function localIsoNow(now: Date): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const magnitude = Math.abs(offsetMinutes);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${pad(
    Math.floor(magnitude / 60),
  )}:${pad(magnitude % 60)}`;
}

/** The base the working tree sits on: branch short name, "-" when detached. */
function safeBase(repoRoot: string): string {
  const child = Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) return "-";
  const name = child.stdout.toString().trim();
  return name === "" || /\r|\n| /.test(name) ? "-" : name;
}

/** The gate's check: the newest stamp must be well-formed and fresh. */
export function checkReviewStamps(repoRoot: string): ReviewStampVerification {
  const marker = readStampsMarker(repoRoot);
  const stampsFile = marker?.file ?? "docs/reviews/stamps.log";
  const stamps = readReviewStamps(repoRoot, stampsFile);
  const newest = stamps[stamps.length - 1];
  if (newest === undefined)
    return { ok: false, errors: [`no review stamp exists in ${stampsFile}`] };
  if (typeof newest.parsed === "string")
    return { ok: false, errors: [`newest stamp line ${newest.index + 1}: ${newest.parsed}`] };
  let currentTreeDigest: string;
  try {
    currentTreeDigest = computeTreeDigest(repoRoot, [stampsFile]);
  } catch (error) {
    return { ok: false, errors: [String(error)] };
  }
  const errors = verifyReviewStamp(newest.parsed, currentTreeDigest);
  return { ok: errors.length === 0, errors };
}
