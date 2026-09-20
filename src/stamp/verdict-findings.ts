/**
 * The verdict findings artifact (issue #466): where a `changes_requested`
 * settle's findings survive the round.
 *
 * THE FAILURE THIS PREVENTS. Before 0.118.0 a `changes_requested` verdict
 * carried its issues only through the settle path's live objects and the
 * session transcript: the stderr settle report printed a COUNT
 * (`issues=${n}`, the line a consumer actually greps), the durable role record
 * (`.ad-coder/runs/standalone-<runId>.json`) carried text/cost/observations but
 * never the verdict, and the review stamp's `findingsRef` pointed at the stamps
 * log itself. Recovering the findings meant re-reading the session jsonl.
 *
 * The artifact is ONE small JSON file beside the run record, in the store's
 * own durable layout (`.ad-coder/runs/verdict-<runId>.json`, the
 * `{"version","value"}` envelope every record there uses). It is written on
 * the settle, before any stamp gating: stamps are target-repo paperwork
 * governed by the marker (src/stamp/record-review-stamp.ts), while this is
 * ad-coder's own durable state and must survive whether or not the target
 * stamps reviews.
 *
 * BOUNDED ON PURPOSE: the issues and the author-side `summary` are
 * model-authored, so both are clipped (length-capped) before they are
 * persisted -- a verbose reviewer cannot write an unbounded artifact.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Store-relative directory every durable run record lives under. */
export const VERDICT_FINDINGS_DIR = path.join(".ad-coder", "runs");

/** The store-recorded id cap; a path-safe token by construction. */
export const VERDICT_FINDINGS_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Per-issue and summary text ceiling. A measured cap, not a warranty. */
export const VERDICT_FINDINGS_TEXT_CHARS = 4000;

/** How many issues the artifact retains. Beyond this it names the remainder. */
export const VERDICT_FINDINGS_MAX_ISSUES = 50;

/** The artifact's own shape version, bumped when the field set changes. */
export const VERDICT_FINDINGS_SCHEMA_VERSION = 1;

/**
 * The bounded findings carried into a settle. Exactly what the record's Verdict
 * already validated, narrowed to what the artifact persists: the settle run's
 * id, the verdict's own summary, and the per-issue severity + text. `coverage`
 * is governance evidence, already durable with the run record, never a
 * findings artifact field.
 */
export interface VerdictFindingsInput {
  runId: string;
  summary: string;
  issues: readonly { severity: string; what: string }[];
}

/** The `value` half of the envelope actually written to disk. */
export interface VerdictFindingsValue {
  schemaVersion: 1;
  runId: string;
  verdict: "changes_requested";
  summary: string;
  issues: { severity: string; what: string }[];
  issueCount: number;
  issuesTruncated: boolean;
  writtenAt: string;
}

/** The durable envelope shape every `.ad-coder` JSON record uses. */
export interface VerdictFindingsArtifact {
  version: number;
  value: VerdictFindingsValue;
}

/** Clip model text to the artifact ceiling; a clipped tail is named, not lost. */
function clipped(text: string): string {
  return text.length <= VERDICT_FINDINGS_TEXT_CHARS
    ? text
    : `${text.slice(0, VERDICT_FINDINGS_TEXT_CHARS)}…[clipped]`;
}

/**
 * The store-relative path the stamp line and the settle report both name. The
 * id is validated against the store's own id pattern first: the ref is a
 * single-line stamp token, so a run id that could not be one must never reach
 * the file name.
 */
export function verdictFindingsRef(runId: string): string {
  if (!VERDICT_FINDINGS_ID_PATTERN.test(runId))
    throw new Error(`verdict findings runId must match ${String(VERDICT_FINDINGS_ID_PATTERN)}`);
  return `${VERDICT_FINDINGS_DIR}/verdict-${runId}.json`;
}

/**
 * Build the bounded artifact value from the settled verdict's findings. Pure:
 * no I/O, no time of its own (`writtenAt` is handed in the ISO-8601 `writeAt`
 * the caller already has). Clips text and caps the issue list, so the value is
 * bounded regardless of what the reviewer submitted.
 */
export function buildVerdictFindingsValue(
  findings: VerdictFindingsInput,
  writeAt: string,
): VerdictFindingsValue {
  const bounded = findings.issues.slice(0, VERDICT_FINDINGS_MAX_ISSUES).map((issue) => ({
    severity: issue.severity,
    what: clipped(issue.what),
  }));
  return {
    schemaVersion: VERDICT_FINDINGS_SCHEMA_VERSION,
    runId: findings.runId,
    verdict: "changes_requested",
    summary: clipped(findings.summary),
    issues: bounded,
    issueCount: findings.issues.length,
    issuesTruncated: findings.issues.length > bounded.length,
    writtenAt: writeAt,
  };
}

/**
 * Write the findings artifact and return the ref (store-relative) the stamp
 * line names. Overwrites an artifact from a prior settle of the same review
 * run id: the run id is the key, and the newest settle is the newest word --
 * the same LAST-wins rule the stamp log itself follows.
 */
export function writeVerdictFindings(
  repoRoot: string,
  findings: VerdictFindingsInput,
  writeAt: string,
): string {
  const ref = verdictFindingsRef(findings.runId);
  const destination = path.join(repoRoot, ref);
  const value = buildVerdictFindingsValue(findings, writeAt);
  const artifact: VerdictFindingsArtifact = { version: 1, value };
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return ref;
}

/** How many issues the stderr settle report shades in beside the count line. */
export const VERDICT_FINDINGS_REPORT_MAX_ISSUES = 10;

/** Per-report-line text ceiling. A verbose reviewer cannot write an unbounded stderr report. */
export const VERDICT_FINDINGS_REPORT_CHARS = 200;

function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[report line clipped]`;
}

/**
 * The bounded stderr report the settle prints BESIDE the count line (`issues=n`,
 * which a consumer actually greps and which stays). The FIRST line names the
 * artifact this settle wrote; each following line is one `severity: what`,
 * capped per line and in total, and a truncation is said plainly with a pointer
 * to the artifact -- the artifact on disk is the durable word, this report is
 * only its actionable front.
 */
export function findingsReportLines(
  ref: string,
  issues: readonly { severity: string; what: string }[],
): string[] {
  const shown = issues
    .slice(0, VERDICT_FINDINGS_REPORT_MAX_ISSUES)
    .map(
      (issue, index) =>
        `${index + 1}. ${issue.severity}: ${clipTo(issue.what, VERDICT_FINDINGS_REPORT_CHARS)}`,
    );
  const lines = [`findings ${ref}`];
  for (const line of shown) lines.push(line);
  if (issues.length > shown.length)
    lines.push(
      `report truncated: ${issues.length - shown.length} of ${issues.length} issues not shown here; the full bounded findings are in ${ref}`,
    );
  return lines;
}

/** Read a findings artifact back; throws when the file absents or does not parse. */
export function readVerdictFindings(repoRoot: string, runId: string): VerdictFindingsValue {
  return (
    JSON.parse(
      fs.readFileSync(path.join(repoRoot, `${VERDICT_FINDINGS_DIR}/verdict-${runId}.json`), "utf8"),
    ) as VerdictFindingsArtifact
  ).value;
}
