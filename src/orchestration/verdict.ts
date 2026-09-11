import * as fs from "node:fs";
import * as path from "node:path";
import { OrchestrationError } from "./types";
import type { IssueSeverity, Verdict, VerdictIssue, VerdictStatus } from "./types";

/** Directory, under targetDir, the reviewer writes its verdict artifact into. */
const VERDICT_BASE_DIR = path.join(".ad-coder", "verdict");

const VERDICT_STATUSES: readonly VerdictStatus[] = ["approved", "changes_requested"];
const ISSUE_SEVERITIES: readonly IssueSeverity[] = ["blocker", "major", "minor"];

/**
 * The absolute path a reviewer round's verdict artifact lives at.
 *
 * `runId` is ORCHESTRATION-generated and already `RUN_ID_PATTERN`-safe (the
 * pipeline validates it before the reviewer turn) -- it is NEVER model output,
 * so a role cannot steer this path via traversal. Keying on the reviewer's
 * unique runId (not a fixed filename) also makes a stale verdict from an earlier
 * round unreadable as the current one.
 */
export function verdictArtifactPath(targetDir: string, runId: string): string {
  return path.join(targetDir, VERDICT_BASE_DIR, `${runId}.json`);
}

/**
 * Strictly validate untrusted, model-produced JSON into a `Verdict`.
 *
 * The verdict is written by the reviewer and read back by the pipeline: its
 * shape is NOT trusted. This is a pure, self-contained, hand-written validator
 * (no `eval`, no schema library): `value` must be an object; `status` one of
 * the two allowed literals; `issues` an array where every element is an object
 * with a `severity` in the three allowed literals and a string `what`;
 * `summary` a string. Any deviation throws `OrchestrationError('malformed_verdict')`
 * -- never a silent coercion, never a default that could read as a pass.
 */
export function parseVerdict(value: unknown, artifactPath: string): Verdict {
  const bad = (message: string): never => {
    throw new OrchestrationError("malformed_verdict", artifactPath, message);
  };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad(`verdict artifact is not a JSON object: ${artifactPath}`);
  }
  const record = value as Record<string, unknown>;

  const status = record.status;
  if (typeof status !== "string" || !VERDICT_STATUSES.includes(status as VerdictStatus)) {
    return bad(`verdict.status must be one of ${VERDICT_STATUSES.join(", ")}: ${artifactPath}`);
  }

  const rawIssues = record.issues;
  if (!Array.isArray(rawIssues)) {
    return bad(`verdict.issues must be an array: ${artifactPath}`);
  }
  const issues: VerdictIssue[] = rawIssues.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return bad(`verdict.issues[${index}] must be an object: ${artifactPath}`);
    }
    const issue = entry as Record<string, unknown>;
    const severity = issue.severity;
    if (typeof severity !== "string" || !ISSUE_SEVERITIES.includes(severity as IssueSeverity)) {
      return bad(
        `verdict.issues[${index}].severity must be one of ${ISSUE_SEVERITIES.join(", ")}: ${artifactPath}`,
      );
    }
    if (typeof issue.what !== "string") {
      return bad(`verdict.issues[${index}].what must be a string: ${artifactPath}`);
    }
    return { severity: severity as IssueSeverity, what: issue.what };
  });

  if (typeof record.summary !== "string") {
    return bad(`verdict.summary must be a string: ${artifactPath}`);
  }

  return { status: status as VerdictStatus, issues, summary: record.summary };
}

/**
 * Read and strictly validate the verdict artifact for `runId`.
 *
 * A missing artifact throws `OrchestrationError('missing_verdict')` and a
 * malformed one throws `'malformed_verdict'` (via `parseVerdict`): the pipeline
 * fails LOUD rather than treating either as an approval. `JSON.parse` failure on
 * a present-but-unparseable file is surfaced as `malformed_verdict`.
 */
export function readVerdict(targetDir: string, runId: string): Verdict {
  const artifactPath = verdictArtifactPath(targetDir, runId);
  let raw: string;
  try {
    raw = fs.readFileSync(artifactPath, "utf8");
  } catch {
    // readFileSync throws for an absent file (and for a read error); either way
    // there is no verdict to trust. The error object carries an errno and the
    // same path -- nothing beyond the typed code below is needed.
    throw new OrchestrationError(
      "missing_verdict",
      artifactPath,
      `verdict artifact not found: ${artifactPath}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A present file that is not JSON is malformed, not missing. The parse
    // error's message can echo file content, so it is dropped for the typed
    // code and path only.
    throw new OrchestrationError(
      "malformed_verdict",
      artifactPath,
      `verdict artifact is not valid JSON: ${artifactPath}`,
    );
  }
  return parseVerdict(parsed, artifactPath);
}

/**
 * The fixed instruction appended to the reviewer's prompt, naming the EXACT
 * artifact path and the required JSON shape. Exported so the pipeline and the
 * tests agree on it verbatim. The path is built from an orchestration-generated
 * runId, never from model output.
 */
export function formatReviewerInstruction(artifactPath: string): string {
  return [
    "When your review is complete, write your verdict as a JSON file using the write tool.",
    `Write it to exactly this path: ${artifactPath}`,
    "The JSON must have this shape:",
    '{ "status": "approved" | "changes_requested", "issues": [ { "severity": "blocker" | "major" | "minor", "what": "<one issue>" } ], "summary": "<short summary>" }',
    'Use "approved" only when no further changes are required; otherwise "changes_requested" with each required change as an issue.',
  ].join("\n");
}
