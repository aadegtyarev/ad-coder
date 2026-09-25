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
  computeTreeManifest,
  FRESH_STAMP_ACTION,
  movedTreePaths,
  type ReviewStamp,
  type ReviewStampFailure,
  type ReviewStampVerification,
  readReviewStamps,
  verifyReviewStamp,
} from "./review-stamp";
import {
  VERDICT_FINDINGS_DIR,
  VERDICT_FINDINGS_ID_PATTERN,
  VERDICT_FINDINGS_MAX_ISSUES,
  VERDICT_FINDINGS_TEXT_CHARS,
  writeVerdictFindings,
} from "./verdict-findings";

export type { ReviewStampFailure };

/** The committed marker that turns stamp writing on for one repository. */
export const STAMPS_MARKER_FILE = "ad-coder.stamps.json";

/**
 * Round-tree integrity (issue #570 follow-up): a review stamp answers "has the
 * reviewed tree moved?" only against the tree AT STAMP TIME. Round 1 of this
 * defect perturbed a source file, reported it restored, left it in the working
 * tree -- and the settle then appended a stamp whose digest matched the
 * PERTURBED tree, so the pre-merge gate passed over a tree that was never the
 * change under review. The answer is a baseline captured at the START of the
 * review round, compared HERE at the settle that would write the stamp.
 *
 * The capture is the stamp's own covered-path digest manifest
 * (docs/contracts/review-evidence.md): `computeTreeManifest` over the same
 * exclusion set, so an unchanged round hashes identically, a truly-restored
 * perturbation hashes identically, and the stamps log itself stays excluded --
 * the stamp write cannot invalidate its own gate.
 */
export const REVIEW_TREE_CAPTURE_SCHEMA_VERSION = 1;

/** Store-relative file the baseline for one review round lives at. */
export function reviewTreeCaptureRef(runId: string): string {
  if (!VERDICT_FINDINGS_ID_PATTERN.test(runId))
    throw new Error(`review tree capture runId must match ${String(VERDICT_FINDINGS_ID_PATTERN)}`);
  return `${VERDICT_FINDINGS_DIR}/review-tree-${runId}.json`;
}

/** The `value` half of the envelope written to disk. */
export interface ReviewedTreeCaptureValue {
  schemaVersion: typeof REVIEW_TREE_CAPTURE_SCHEMA_VERSION;
  runId: string;
  /** The tree digest at round start, exactly as the stamp would speak it. */
  digest: string;
  /** path -> per-file sha256 for every covered tracked path at round start. */
  coveredPaths: Record<string, string>;
  /** LOCAL wall-clock ISO-8601 of the capture. */
  capturedAt: string;
}

/**
 * Capture the tree at the START of a review round (both fronts: the pipeline's
 * review stage and the standalone reviewer), unless one is already on record:
 * a round resumed from an earlier attempt -- or its run-finish hook replaying
 * -- must keep the ORIGINAL start tree, never re-anchor to the resume moment.
 * Returns the capture ref, or undefined when stamping cannot happen for this
 * round at all (the same gating the writer applies, mirrored so targets that
 * never stamp pay nothing).
 */
export function captureReviewedTreeForRound(
  repoRoot: string,
  runId: string,
  requireStamp: StampRequirement,
  now: Date = new Date(),
): string | undefined {
  if (!stampingEnabledForRound(repoRoot, requireStamp)) return undefined;
  const ref = reviewTreeCaptureRef(runId);
  const filePath = path.join(repoRoot, ref);
  if (fs.existsSync(filePath)) return ref;
  const stampsFile = readStampsMarker(repoRoot)?.file ?? "docs/reviews/stamps.log";
  const manifest = computeTreeManifest(repoRoot, [stampsFile]);
  const value: ReviewedTreeCaptureValue = {
    schemaVersion: REVIEW_TREE_CAPTURE_SCHEMA_VERSION,
    runId,
    digest: manifest.digest,
    coveredPaths: manifest.coveredPaths,
    capturedAt: localIsoNow(now),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, value }, null, 2)}\n`, "utf8");
  return ref;
}

/** The writer's own stamp-turning predicate, applied at capture time as well. */
function stampingEnabledForRound(repoRoot: string, requireStamp: StampRequirement): boolean {
  if (requireStamp === "off") return false;
  return requireStamp === "on" || readStampsMarker(repoRoot) !== undefined;
}

/**
 * Read the capture for this run's review round: the NEWEST run id in run order
 * that has one on disk. Earlier rounds' captures are superseded by later ones
 * by construction (the coder may legitimately edit between rounds); a missing
 * capture reads as "no comparison possible" -- pre-upgrade runs resumed after
 * this change keep today's stamp behavior -- while a corrupt one fails LOUD:
 * ad-coder's own durable record must never silently stop being the gate.
 */
export function readReviewedTreeCapture(
  repoRoot: string,
  runIds: readonly string[],
): { ref: string; value: ReviewedTreeCaptureValue } | undefined {
  for (const runId of [...runIds].reverse()) {
    if (!VERDICT_FINDINGS_ID_PATTERN.test(runId)) continue;
    const ref = reviewTreeCaptureRef(runId);
    const filePath = path.join(repoRoot, ref);
    if (!fs.existsSync(filePath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw new Error(`unreadable review-tree capture at ${ref}: ${String(error)}`);
    }
    const value = (parsed as { version?: unknown; value?: unknown } | null)?.value;
    if (
      typeof value !== "object" ||
      value === null ||
      (value as ReviewedTreeCaptureValue).schemaVersion !== REVIEW_TREE_CAPTURE_SCHEMA_VERSION
    )
      throw new Error(
        `malformed review-tree capture at ${ref} -- restore it from the round's record or re-capture by re-running the round`,
      );
    return { ref, value: value as ReviewedTreeCaptureValue };
  }
  return undefined;
}

/** The recovery action a moved-tree refusal names, spelled once. */
export const REVIEW_TREE_MOVED_ACTION = "restore the tree and re-run the round";

/** Bounded failure text: list the paths (capped), keep the message one line. */
export function reviewedTreeMovedMessage(movedPaths: readonly string[]): string {
  const shown = movedPaths.slice(0, 20);
  const rest = movedPaths.length - shown.length;
  const list = `${shown.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
  return (
    `the review round modified the tree under review: ${list} -- ` +
    `a stamp would certify a tree that is not the reviewed change; ${REVIEW_TREE_MOVED_ACTION}`
  );
}

/**
 * The settle's refusal to certify a tree the round itself modified. Human and
 * machine fronts both carry the moved paths; the words the operator reads are
 * `reviewedTreeMovedMessage` plus the same action in the machine field.
 */
export class ReviewedTreeMovedError extends Error {
  override readonly name = "ReviewedTreeMovedError";
  readonly code = "reviewed_tree_moved";
  readonly nextAction = REVIEW_TREE_MOVED_ACTION;
  readonly captureRef: string;
  constructor(
    readonly movedPaths: readonly string[],
    captureRef: string,
  ) {
    super(reviewedTreeMovedMessage(movedPaths));
    this.captureRef = captureRef;
  }
}
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
  // One traversal computes BOTH the stamp's digest and the comparison against
  // the round's start capture (issue #570 follow-up). The refusal happens
  // BEFORE anything is appended: a stamp must never certify a tree the round
  // itself moved.
  const currentManifest = computeTreeManifest(repoRoot, [filePath]);
  const capture = readReviewedTreeCapture(repoRoot, result.runIds);
  if (capture !== undefined) {
    const moved = movedTreePaths(capture.value.coveredPaths, currentManifest.coveredPaths);
    if (moved.length > 0) throw new ReviewedTreeMovedError(moved, capture.ref);
  }
  const stamp: ReviewStamp = {
    // The digest excludes the stamp log itself: appending one stamp line
    // cannot count as the tree moving (src/stamp/review-stamp.ts).
    treeDigest: currentManifest.digest,
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
  // A front can die after appendReviewStamp succeeds but before it has printed
  // its result or advanced its own checkpoint.  Replaying the same settled
  // reviewer outcome must not manufacture another stamp line.  Run ids are
  // generated per reviewer attempt and are the durable idempotency key; reject
  // a contradictory reuse rather than silently certifying a different review.
  const existing = readReviewStamps(repoRoot, filePath)
    .map((entry) => entry.parsed)
    .find(
      (entry): entry is ReviewStamp =>
        typeof entry !== "string" &&
        entry.runIds.length === stamp.runIds.length &&
        entry.runIds.every((runId, index) => runId === stamp.runIds[index]),
    );
  if (existing !== undefined) {
    if (existing.treeDigest !== stamp.treeDigest || existing.verdict !== stamp.verdict)
      throw new Error("review run id already has a contradictory recorded stamp");
    return { recorded: true, filePath, findingsRef: existing.findingsRef };
  }
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

export interface VersionFixupComparison {
  reviewed: Record<string, string>;
  current: Record<string, string>;
  mainChangelog: string;
  branchPaths: readonly string[];
  stampApproved: boolean;
  stampMatchesReviewed: boolean;
}

/**
 * CI-only escape hatch for a stale approved stamp after a mechanical version
 * fixup. The normal stamp gate remains strict; this comparison is deliberately
 * byte-oriented and scoped to the branch paths supplied by CI.
 */
export function compareVersionFixup(input: VersionFixupComparison): {
  ok: boolean;
  reason?: string;
} {
  if (!input.stampApproved || !input.stampMatchesReviewed)
    return { ok: false, reason: "the latest stamp is not an approved stamp for the reviewed tree" };
  const paths = new Set(input.branchPaths);
  if (paths.size === 0) return { ok: false, reason: "CI branch scope is empty" };
  for (const file of new Set([...Object.keys(input.reviewed), ...Object.keys(input.current)])) {
    if (!paths.has(file)) continue;
    if (file === "docs/reviews/stamps.log") continue;
    const before = input.reviewed[file] ?? "";
    const after = input.current[file] ?? "";
    if (before === after) continue;
    if (file === "package.json") {
      if (!onlyPackageVersionChanged(before, after))
        return { ok: false, reason: "package.json changed outside its JSON version value" };
      continue;
    }
    if (file === "CHANGELOG.md") {
      if (!onlyChangelogFixup(before, after, input.mainChangelog))
        return {
          ok: false,
          reason: "CHANGELOG.md changed outside its release heading and main-block union",
        };
      continue;
    }
    return { ok: false, reason: `${file} changed after the approved review` };
  }
  return { ok: true };
}

function onlyPackageVersionChanged(before: string, after: string): boolean {
  const pattern = /("version"\s*:\s*)"[^"\r\n]+"/g;
  const beforeMatches = [...before.matchAll(pattern)];
  const afterMatches = [...after.matchAll(pattern)];
  if (beforeMatches.length !== 1 || afterMatches.length !== 1) return false;
  const normalize = (text: string) => text.replace(pattern, '$1"<version>"');
  return normalize(before) === normalize(after);
}

function onlyChangelogFixup(before: string, after: string, main: string): boolean {
  const heading = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;
  const parse = (text: string): { prefix: string[]; blocks: string[][] } => {
    const lines = text.split("\n");
    const starts = lines.flatMap((line, index) => (heading.test(line) ? [index] : []));
    return {
      prefix: lines.slice(0, starts[0] ?? lines.length),
      blocks: starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length)),
    };
  };
  const removeMainBlocks = (blocks: string[][], mainBlocks: string[][]): string[][] => {
    const remaining = [...mainBlocks];
    return blocks.filter((block) => {
      const index = remaining.findIndex((candidate) => candidate.join("\n") === block.join("\n"));
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
  };
  const beforeParsed = parse(before);
  const afterParsed = parse(after);
  const mainParsed = parse(main);
  if (beforeParsed.prefix.join("\n") !== afterParsed.prefix.join("\n")) return false;
  const branchIndex = beforeParsed.blocks.findIndex(
    (block) => !mainParsed.blocks.some((candidate) => candidate.join("\n") === block.join("\n")),
  );
  if (branchIndex < 0) return false;
  const branchBlock = beforeParsed.blocks[branchIndex];
  if (branchBlock === undefined) return false;
  const beforeBlocks = removeMainBlocks(
    beforeParsed.blocks.filter((_, index) => index !== branchIndex),
    mainParsed.blocks,
  );
  const afterBlocks = removeMainBlocks(afterParsed.blocks, mainParsed.blocks);
  beforeBlocks.unshift(branchBlock);
  if (beforeBlocks.length !== afterBlocks.length) return false;
  let headingChanged = false;
  for (let blockIndex = 0; blockIndex < beforeBlocks.length; blockIndex++) {
    const oldBlock = beforeBlocks[blockIndex];
    const newBlock = afterBlocks[blockIndex];
    if (oldBlock === undefined || newBlock === undefined) return false;
    if (oldBlock.length !== newBlock.length) return false;
    for (let lineIndex = 0; lineIndex < oldBlock.length; lineIndex++) {
      const oldLine = oldBlock[lineIndex];
      const newLine = newBlock[lineIndex];
      if (oldLine === undefined || newLine === undefined) return false;
      if (oldLine === newLine) continue;
      if (blockIndex !== 0 || lineIndex !== 0 || headingChanged) return false;
      const oldMatch = oldLine.match(heading);
      const newMatch = newLine.match(heading);
      if (oldMatch === null || newMatch === null || oldMatch[2] !== newMatch[2]) return false;
      headingChanged = true;
    }
  }
  return true;
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
