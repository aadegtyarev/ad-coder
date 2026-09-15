import * as fs from "node:fs";

interface Finding {
  code: string;
  blocking?: boolean;
  severity?: string;
}

/**
 * Whether a finding is raised as blocking.
 *
 * An explicit `blocking` is always honoured, in both directions: a model that
 * deliberately marks a finding non-blocking must not be credited for it. But a
 * model that OMITS the field while carrying `severity: "blocker"` has said the
 * same thing under a different name, and the point of this scorer is to read
 * what the review actually claims rather than which key it chose. Omitting the
 * requested field is still an instruction-following miss -- it belongs in the
 * acceptance signal, not in silently zeroing an otherwise correct review.
 */
function isBlocking(finding: Finding): boolean {
  if (typeof finding.blocking === "boolean") return finding.blocking;
  const severity = (finding.severity ?? "").toLowerCase();
  return severity === "blocker" || severity === "blocking" || severity === "critical";
}

/**
 * WHY TOKENS, NOT EXACT CODES. The task prompt asks for "concise stable defect
 * codes" without dictating a vocabulary, so every model invents its own
 * spelling: one run of six models produced PATH_TRAVERSAL_DOT_ACCEPTED,
 * PATH-TRAVERSAL, PATH-TRAVERSAL-DECODE and decoded-path-escape for the SAME
 * defect. An exact-match list scored materially correct reviews at 0.2 and
 * measured spelling luck rather than review quality.
 *
 * So a code is reduced to its lowercase word tokens and matched on meaning. The
 * rules stay deliberately narrow -- each demands the two words that together
 * name the specific seeded defect, not one generic word like "path" or "error"
 * -- so a model that flags something vaguely adjacent still fails.
 */
function tokens(code: string): Set<string> {
  return new Set(
    code
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

const file = process.argv[2];
if (!file) throw new Error("usage: reviewer-hidden-regression <findings.json>");
const raw = fs.readFileSync(file, "utf8");
const end = raw.lastIndexOf("]");
if (end < 0) throw new Error("reviewer artifact must contain a JSON array");
const findings = JSON.parse(raw.slice(0, end + 1)) as Finding[];

const blocking = findings.filter(isBlocking).map((finding) => tokens(finding.code));

/** True when some blocking finding's code carries every word in one of the groups. */
const matches = (...groups: string[][]): boolean =>
  groups.some((group) => blocking.some((code) => group.every((word) => code.has(word))));

const checks = [
  {
    // Seeded defect 1: SAFE_ID now admits `%` and `.`, and the id is decoded
    // AFTER validation, so `%2e%2e` decodes to `..` and escapes baseDir.
    id: "detects-path-escape",
    passed: matches(
      ["path", "traversal"],
      ["path", "escape"],
      ["decode", "path"],
      ["decoded", "path"],
      ["directory", "traversal"],
    ),
  },
  {
    // Seeded defect 2: the primary write moved BEFORE the metadata write, and a
    // metadata failure is swallowed into `{saved: false}` instead of staying
    // observable -- contract says metadata commits first and its error surfaces.
    id: "detects-silent-fallback",
    passed: matches(
      ["order", "reversed"],
      ["write", "order"],
      ["save", "order"],
      ["metadata", "swallowed"],
      ["metadata", "order"],
      ["primary", "discarded"],
      ["partial", "save"],
    ),
  },
  {
    // The tempting non-defect: SAFE_ID does NOT admit `/`, so claiming the raw
    // id allows a slash is wrong. Only a BLOCKING claim counts against the run.
    id: "avoids-false-positive",
    passed: !matches(["raw", "slash"], ["id", "slash"], ["slash", "allowed"]),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
