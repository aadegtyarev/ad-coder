import * as fs from "node:fs";
import * as path from "node:path";

interface Finding {
  code: string;
  blocking?: boolean;
  severity?: string;
  /** See the medium reviewer scorer for why this is `unknown` rather than `string`. */
  evidence?: unknown;
}

/** See the medium reviewer scorer for why an explicit and an implied `blocking` are both honoured. */
function isBlocking(finding: Finding): boolean {
  if (typeof finding.blocking === "boolean") return finding.blocking;
  const severity = (finding.severity ?? "").toLowerCase();
  return severity === "blocker" || severity === "blocking" || severity === "critical";
}

/**
 * WHY TOKENS, NOT EXACT CODES. See the medium reviewer scorer for the full
 * rationale: the prompt supplies no vocabulary, so a code is reduced to its
 * lowercase word tokens and matched on meaning, demanding the pair of words
 * that together name the specific seeded defect.
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
if (!file) throw new Error("usage: reviewer-idempotency-race <findings.json>");
/** See the medium reviewer scorer for why an unreadable answer fails rather than throws. */
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
 * applied -- which is the state the reviewer is looking at. See the medium
 * reviewer scorer for why this is read relative to THIS FILE, why line counts
 * are computed the way they are, and why the patch's net delta per file
 * matters: `calibration-materialize` applies `change.patch` before the role
 * ever runs, so a line that exists for the reviewer may not exist in the
 * checked-in file this scorer can open. This fixture's patch touches TWO
 * files, so the delta is attributed per file rather than assumed singular.
 */
function countLines(text: string): number {
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

const FIXTURE_LINES = (() => {
  const root = path.resolve(import.meta.dir, "../fixtures/reviewer-idempotency-race");
  const patchText = fs.readFileSync(path.join(root, "change.patch"), "utf8");
  const deltaByFile = new Map<string, number>();
  let current: string | undefined;
  for (const line of patchText.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1];
      deltaByFile.set(current, deltaByFile.get(current) ?? 0);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) deltaByFile.set(current, (deltaByFile.get(current) ?? 0) + 1);
    else if (line.startsWith("-")) deltaByFile.set(current, (deltaByFile.get(current) ?? 0) - 1);
  }
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
  for (const [fileName, delta] of deltaByFile)
    if (lines.has(fileName)) lines.set(fileName, (lines.get(fileName) as number) + delta);
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
 * The patch touches two functions across two files and carries two seeded
 * defects, so four blocking findings is twice the truth -- room to split one
 * defect into two related findings, or to find something real the seeding
 * did not intend, without room for a list of suspicions. See the medium
 * reviewer scorer for why a cap exists at all; the number here is set from
 * what THIS fixture contains, not carried over from the medium task.
 */
const BLOCKING_FINDING_CAP = 4;

/** True when some blocking finding's code carries every word in one of the groups. */
const matches = (...groups: string[][]): boolean =>
  groups.some((group) => blocking.some((code) => group.every((word) => code.has(word))));

const checks = [
  {
    // Seeded defect 1, upstream-only: `canonicalKey` in idempotency.ts now
    // strips ALL non-alphanumeric characters instead of collapsing
    // whitespace, so "order-42" and "order 42" -- two keys the contract
    // requires to stay distinct -- collapse into one. The line that changed
    // is idempotency.ts; the harm (one caller's request silently reused for
    // another's) is only observable by reading ledger.ts's applyCharge,
    // which is unchanged and, read alone, looks correct.
    id: "detects-canonicalization-key-collision",
    passed: matches(
      ["key", "collision"],
      ["canonicalization", "collision"],
      ["canonicalize", "collision"],
      ["different", "keys", "collide"],
      ["distinct", "keys", "collapse"],
      ["punctuation", "stripped"],
      ["punctuation", "collapse"],
      ["over", "canonicalization"],
      ["overbroad", "canonicalization"],
      ["too", "aggressive", "canonical"],
    ),
  },
  {
    // Seeded defect 2, an ordering/concurrency invariant: the patch deletes
    // the reservation write that used to run BEFORE `await charge(...)`, so
    // two calls racing on the same key both observe the map as empty and
    // both invoke `charge`. Neither statement is wrong read alone; the
    // defect exists only in the interleaving across the `await`.
    id: "detects-charge-race",
    passed: matches(
      ["race", "charge"],
      ["double", "charge"],
      ["concurrent", "charge"],
      ["missing", "reservation"],
      ["no", "reservation"],
      ["reservation", "removed"],
      ["duplicate", "charge"],
      ["race", "condition"],
      ["toctou"],
      ["check", "then", "act"],
    ),
  },
  {
    // The tempting non-defect: `validateAmount` runs unconditionally before
    // the existing-key check on EVERY call, but the contract requires
    // exactly that -- validation on every call, including a retry of an
    // existing key. Flagging it as wasted or duplicate-request work is
    // pattern-matching the shape, not reading the contract that governs it.
    // Requires an answer first, for the reason the medium scorer states: an
    // unparseable answer must not score this check for free.
    id: "avoids-false-positive",
    passed:
      blockingFindings.length > 0 &&
      !matches(
        ["validate", "duplicate"],
        ["revalidate"],
        ["unnecessary", "validation"],
        ["redundant", "validation"],
        ["skip", "validation"],
      ),
  },
  {
    // See the medium reviewer scorer: restating the code as its own evidence
    // is not evidence, compared on tokens so a model is not credited for
    // echoing its own code as its own support.
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
    // A cited line exists in the fixture as the reviewer would have seen it.
    // See the medium reviewer scorer for why only `path:line` citations are
    // checked, and why the off-by-one in line counting matters here exactly
    // as much as there.
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
    // review that reported nothing is not disciplined, and the cap alone
    // would score an empty answer full marks.
    id: "bounded-blocking-findings",
    passed: blockingFindings.length > 0 && blockingFindings.length <= BLOCKING_FINDING_CAP,
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
