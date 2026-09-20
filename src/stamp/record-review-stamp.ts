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
import type { SettingsConfig, StampRequirement } from "../config/types";
import {
  appendReviewStamp,
  computeTreeDigest,
  FRESH_STAMP_ACTION,
  type ReviewStamp,
  type ReviewStampFailure,
  type ReviewStampVerification,
  readReviewStamps,
  verifyReviewStamp,
} from "./review-stamp";
import {
  VERDICT_FINDINGS_MAX_ISSUES,
  VERDICT_FINDINGS_TEXT_CHARS,
  writeVerdictFindings,
} from "./verdict-findings";

export type { ReviewStampFailure };

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

/**
 * The ONE resolution of `settings.yaml`'s `review.require-stamp` into the
 * three answers the writer and the gate share. This is the shared sink that
 * keeps them from ever disagreeing -- a half-wired `off` that reached the
 * writer but not the gate would manufacture a merge-gate failure.
 *
 * `on` -> on (write and require, marker or no marker). `off` -> off (write
 * nothing, gate passes). `auto`, or no settings file at all, defers to the
 * marker exactly as today: the writer writes only when a marker is present and
 * the gate reads the marker's stamps file (default `docs/reviews/stamps.log`).
 */
export function resolveStampRequirement(settings: SettingsConfig | undefined): StampRequirement {
  return settings?.review.requireStamp ?? "auto";
}

export interface ReviewStampOutcome {
  recorded: boolean;
  /** Why no stamp was written; absent when one was. */
  skippedBecause?: string;
  filePath?: string;
  /**
   * "-" when the verdict approved with no findings, otherwise the
   * store-relative path of the findings artifact this settle wrote
   * (`.ad-coder/runs/verdict-<runId>.json`, issue #466) -- the ref the stamp
   * line carries and the settle report names. Carried ON the outcome so the
   * CLI front reports the path from the same derivation that wrote the file
   * instead of recomputing it (and possibly disagreeing).
   */
  findingsRef: string;
}

/**
 * Everything a stamp is derived from.
 *
 * A `PipelineResult` satisfies this, and so does a standalone reviewer run: the
 * stamp never needed a pipeline, only a review that produced a structured
 * verdict. Narrowed to exactly these fields so the single-role path records its
 * stamp through this same writer rather than growing a second one (issue #283).
 */
export interface ReviewStampSource {
  approved: boolean;
  runIds: string[];
  stageMetrics: readonly { stage: string; provider?: string; model?: string }[];
  reviewRan?: boolean;
  /**
   * The settled verdicts, when the caller carries them (a `PipelineResult`
   * always does; the standalone reviewer passes the one verdict). Optional so
   * legacy callers stay valid, but the findings ARTIFACT (issue #466) is
   * derived from it: without it a `changes_requested` settle can only stamp a
   * count, never persist the findings themselves.
   */
  verdicts?: readonly {
    status: string;
    issues: readonly { severity: string; what: string }[];
    summary: string;
  }[];
}

/**
 * Derive and append the stamp, from the settled result only.
 *
 * A run with `reviewRan: false` settles without a verdict, so it persists no
 * findings and writes no stamp -- a stamp must never certify silence.
 * `changes_requested` results DO stamp: the merge gate reads the newest
 * verdict, and "theReviewer said no" is a fact the gate should be able to
 * see, not re-derive from prose.
 *
 * The verdict's FINDINGS are persisted before any stamp gating (issue #466):
 * stamps are marker-governed target paperwork, while the findings artifact is
 * ad-coder's own `.ad-coder` durable state beside the run record -- a set of
 * findings that never survives the settle is the loss this fixes.
 */
export function recordReviewStampFromResult(
  repoRoot: string,
  result: ReviewStampSource,
  now: Date = new Date(),
  requireStamp: StampRequirement = "auto",
): ReviewStampOutcome {
  if (result.reviewRan === false)
    return {
      recorded: false,
      skippedBecause: "the run settled without a review round",
      findingsRef: "-",
    };
  // Bounded at the source too: the artifact clips again, and the CLI's stderr
  // report renders at most these ceilings (issue #466).
  const lastVerdict = result.verdicts?.[result.verdicts.length - 1];
  let findingsRef = "-";
  if (result.approved === false && lastVerdict?.status === "changes_requested") {
    findingsRef = writeVerdictFindings(
      repoRoot,
      {
        // The findings belong to the REVIEW run that settled them; in a
        // pipeline `runIds` is in run order, so the last id is that reviewer
        // run.
        runId: result.runIds[result.runIds.length - 1] ?? "unknown",
        summary: lastVerdict.summary.slice(0, VERDICT_FINDINGS_TEXT_CHARS),
        issues: lastVerdict.issues.slice(0, VERDICT_FINDINGS_MAX_ISSUES),
      },
      localIsoNow(now),
    );
  }
  const marker = readStampsMarker(repoRoot);
  if (requireStamp === "off")
    return {
      recorded: false,
      skippedBecause: "review stamps are off (require-stamp: off)",
      findingsRef,
    };
  if (requireStamp !== "on" && marker === undefined)
    return {
      recorded: false,
      skippedBecause: "target is not a stamp-writing repository",
      findingsRef,
    };
  const lastMetrics = result.stageMetrics.filter((entry) => entry.stage.startsWith("review:"));
  const reviewerMetrics = lastMetrics[lastMetrics.length - 1];
  const filePath = marker?.file ?? "docs/reviews/stamps.log";
  const stamp: ReviewStamp = {
    // The digest excludes the stamp log itself: appending one stamp line
    // cannot count as the tree moving (src/stamp/review-stamp.ts).
    treeDigest: computeTreeDigest(repoRoot, [filePath]),
    base: safeBase(repoRoot),
    verdict: result.approved ? "approved" : "changes_requested",
    reviewer: `${reviewerMetrics?.provider ?? "?"}/${reviewerMetrics?.model ?? "?"}`,
    reviewedAt: localIsoNow(now),
    runIds: result.runIds,
    // The stamp line's own documented meaning (ReviewStamp.findingsRef): the
    // findings artifact when the verdict disapproved with findings, "-" in
    // every other case -- the no-findings approval included. It NEVER names
    // the stamps log itself: a pointer that answers "where the findings live"
    // with the log that carries none was the second half of the loss issue
    // #466 fixes.
    findingsRef: findingsRef,
  };
  try {
    appendReviewStamp(repoRoot, filePath, stamp);
  } catch (error) {
    throw new Error(`could not write the review stamp to ${filePath}: ${String(error)}`);
  }
  return { recorded: true, filePath, findingsRef };
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
export function checkReviewStamps(
  repoRoot: string,
  requireStampOverride?: StampRequirement,
): ReviewStampVerification {
  const marker = readStampsMarker(repoRoot);
  // The settings layer may force the gate off; `auto`/absent keeps today's
  // marker-governed read (the marker's file, or the built-in default path).
  if (requireStampOverride === "off") return { ok: true, failures: [] };
  const stampsFile = marker?.file ?? "docs/reviews/stamps.log";
  const stamps = readReviewStamps(repoRoot, stampsFile);
  const newest = stamps[stamps.length - 1];
  if (newest === undefined)
    return {
      ok: false,
      failures: [
        {
          reason: `no review stamp exists in ${stampsFile}`,
          action: FRESH_STAMP_ACTION,
        },
      ],
    };
  if (typeof newest.parsed === "string")
    return {
      ok: false,
      failures: [
        {
          reason: `newest stamp line ${newest.index + 1}: ${newest.parsed}`,
          action: FRESH_STAMP_ACTION,
        },
      ],
    };
  let currentTreeDigest: string;
  try {
    currentTreeDigest = computeTreeDigest(repoRoot, [stampsFile]);
  } catch (error) {
    return {
      ok: false,
      failures: [
        {
          reason: String(error),
          action: "resolve the git error above and re-run the gate",
        },
      ],
    };
  }
  const failures = verifyReviewStamp(newest.parsed, currentTreeDigest);
  return { ok: failures.length === 0, failures };
}
