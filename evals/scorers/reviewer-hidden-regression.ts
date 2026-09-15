import * as fs from "node:fs";

interface Finding {
  code: string;
  blocking?: boolean;
  severity?: string;
  /**
   * Whatever the model put here. The prompt asks for a file and line or a
   * command and its output, and models answer with a string, an array of
   * strings, or an object -- so this is `unknown` and normalized at the point of
   * use. Typed as `string`, a model that answered with an array crashed the
   * scorer, and the run was recorded as an infrastructure failure rather than as
   * the review it was.
   */
  evidence?: unknown;
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

/** Any shape a model reached for, reduced to the text it carries. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join(" ");
  if (value !== null && typeof value === "object")
    return Object.values(value as Record<string, unknown>)
      .map(flatten)
      .join(" ");
  return value === null || value === undefined ? "" : String(value);
}

const file = process.argv[2];
if (!file) throw new Error("usage: reviewer-hidden-regression <findings.json>");
/**
 * The model's answer, or an empty one when it did not produce something this
 * scorer can read.
 *
 * WHY NOT THROW. A scorer that throws on malformed output turns a MODEL failure
 * into a HARNESS failure: the runner sees a non-zero exit and drops the run, so
 * the measurement leaves the sample entirely. That silently flatters the model,
 * because the runs it loses are its worst ones -- a live sweep lost a third of
 * one cell's runs this way, every one of them bad. An empty answer fails every
 * check instead, which is what a prompt demanding strict JSON means when the
 * answer is not JSON.
 */
function readAnswer(path: string): Finding[] {
  const raw = fs.readFileSync(path, "utf8");
  const end = raw.lastIndexOf("]");
  if (end < 0) return [];
  try {
    return JSON.parse(raw.slice(0, end + 1)) as Finding[];
  } catch {
    return [];
  }
}

const findings = readAnswer(file);

const blockingFindings = findings.filter(isBlocking);
const blocking = blockingFindings.map((finding) => tokens(finding.code));

/**
 * The fixture's diff is about fifteen lines across two functions and carries two
 * seeded defects, so four blocking findings is twice the truth -- room to split
 * one defect into two related findings, or to find something real the seeding
 * did not intend, without room for a list of suspicions.
 *
 * WHY A CAP AT ALL. A reviewer that reports everything it suspects is as
 * unusable as one that reports nothing: neither tells the reader which findings
 * to act on. Published code-review benchmarks put the bottleneck on precision
 * rather than recall for exactly this reason. The cap is stated in the task
 * prompt, so it scores something the model was asked for.
 */
const BLOCKING_FINDING_CAP = 4;

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
    // Requires an answer first: a review that produced nothing has not avoided
    // the false positive, it has declined to review. Without that, an
    // unparseable answer scored this check for free, so the runs where a model
    // returned nothing usable scored better than the runs where it tried.
    id: "avoids-false-positive",
    passed:
      blockingFindings.length > 0 &&
      !matches(["raw", "slash"], ["id", "slash"], ["slash", "allowed"]),
  },
  {
    // The prompt asks for the file and line read, or the command run and what it
    // printed. Restating the code as its own evidence is the shape this catches:
    // it reads as support and contains nothing the reader can check. Compared on
    // tokens rather than exact text so a model that writes "PATH_TRAVERSAL" as a
    // code and "path traversal" as evidence is not credited for the echo.
    id: "findings-are-evidenced",
    passed:
      blockingFindings.length > 0 &&
      blockingFindings.every((finding) => {
        const evidence = flatten(finding.evidence).trim();
        if (evidence.length < 8) return false;
        const echo = [...tokens(finding.code)].join(" ");
        return [...tokens(evidence)].join(" ") !== echo;
      }),
  },
  {
    // Precision, not volume. See BLOCKING_FINDING_CAP. A lower bound too: a
    // review that reported nothing is not disciplined, and the cap alone scored
    // an empty answer full marks.
    id: "bounded-blocking-findings",
    passed: blockingFindings.length > 0 && blockingFindings.length <= BLOCKING_FINDING_CAP,
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
