import * as fs from "node:fs";
import * as path from "node:path";

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

/**
 * How long each of the fixture's source files is once the seeded change is
 * applied -- which is the state the reviewer is looking at.
 *
 * Read relative to THIS FILE, for the reason the planner scorer states: a live
 * run scores `<target>/artifact.json` with the fixture beside it, the corpus
 * smoke scores a flat sample with no fixture anywhere near, and scorers and
 * fixtures are fixed sibling directories.
 *
 * The length is the checked-in file's plus the patch's net line delta, rather
 * than the checked-in file's alone: `calibration-materialize` applies
 * `change.patch` before the role ever runs, so a line that exists for the
 * reviewer may not exist in the file this scorer can open.
 */
/**
 * How many lines a file has.
 *
 * `split("\n").length` counts one too many for a file ending in a newline,
 * which every file here does -- and an off-by-one is exactly the fabrication
 * this is meant to catch, since a model citing one line past the end is far more
 * likely than one citing line 214. Reproduced: the fixture is 17 lines and 21
 * after the patch, and the naive count admitted a citation of line 22.
 */
function countLines(text: string): number {
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

const FIXTURE_LINES = (() => {
  const root = path.resolve(import.meta.dir, "../fixtures/reviewer-hidden-regression");
  const patch = fs.readFileSync(path.join(root, "change.patch"), "utf8").split("\n");
  const delta = patch.reduce((sum, line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return sum;
    if (line.startsWith("+")) return sum + 1;
    if (line.startsWith("-")) return sum - 1;
    return sum;
  }, 0);
  const lines = new Map<string, number>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else lines.set(rel, countLines(fs.readFileSync(path.join(dir, entry.name), "utf8")));
    }
  };
  walk(root, "");
  // The patch touches exactly one file; its net delta belongs to that file.
  const patched = /^\+\+\+ b\/(.+)$/m.exec(patch.join("\n"))?.[1];
  if (patched !== undefined && lines.has(patched))
    lines.set(patched, (lines.get(patched) as number) + delta);
  return lines;
})();

/** Every `path:line` the evidence cites, however it is embedded in the text. */
function citations(evidence: string): { file: string; line: number }[] {
  return [...evidence.matchAll(/([\w./-]+\.[a-z]{1,4}):(\d+)/g)].map((match) => ({
    file: (match[1] as string).replace(/^\.?\//, ""),
    line: Number.parseInt(match[2] as string, 10),
  }));
}

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
    // A CITED LINE EXISTS. The scorer reads the JSON the model asserted, so a
    // review citing `src/result-store.ts:214` in a seventeen-line file scored
    // exactly as well as one that read the file -- and a line number is the one
    // part of a claim that is checkable without guessing at prose. Only
    // `path:line` citations are checked: naming a command and its output is
    // equally valid evidence and is deliberately left alone, since the point is
    // to catch a fabricated location, not to demand one.
    id: "cited-lines-exist",
    passed:
      blockingFindings.length > 0 &&
      blockingFindings.every((finding) =>
        citations(flatten(finding.evidence)).every(({ file, line }) => {
          const length = FIXTURE_LINES.get(file);
          return length !== undefined && line >= 1 && line <= length;
        }),
      ),
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
