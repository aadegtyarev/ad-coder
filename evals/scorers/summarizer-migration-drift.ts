import * as fs from "node:fs";
import * as path from "node:path";

interface Answer {
  /** What the role reports most collectors' shared defect to be. */
  finding?: string;
  /** The naming constraint it must still be carrying after compaction. */
  constraint?: string;
  /** The collector ids it reports as actually violating the constraint. */
  violations?: unknown;
  /** The collectors it inspected. */
  collectors?: unknown;
}

const file = process.argv[2];
if (!file) throw new Error("usage: summarizer-migration-drift <answer.json>");

/**
 * The model's answer, or an empty one when it did not produce readable JSON.
 * See the reviewer scorer for why this does not throw.
 */
function readAnswer(target: string): Answer {
  const raw = fs.readFileSync(target, "utf8");
  const end = raw.lastIndexOf("}");
  if (end < 0) return {};
  try {
    return JSON.parse(raw.slice(0, end + 1)) as Answer;
  } catch {
    return {};
  }
}

const answer = readAnswer(file);

/** Any shape the model reached for, reduced to the text it carries. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join(" ");
  if (value !== null && typeof value === "object")
    return Object.values(value as Record<string, unknown>)
      .map(flatten)
      .join(" ");
  return value === null || value === undefined ? "" : String(value);
}

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

const constraintWords = words(`${answer.constraint ?? ""} ${answer.finding ?? ""}`);
const all = words(flatten(answer));
const violationsText = flatten(answer.violations).toLowerCase();
const violationWords = words(violationsText);

/** True when the text carries every word of some group. */
const carries = (set: Set<string>, ...groups: string[][]): boolean =>
  groups.some((group) => group.every((word) => set.has(word)));

/**
 * Whether a collector id is present in the `violations` field, as a whole
 * token (`collect09` or `collector09`, never a bare `09` -- that digit also
 * occurs inside every `metric_09_*` field name the fixture carries, so a
 * bare-digit match would fire on an answer that merely quoted one).
 *
 * The prompt asks for `violations` to be an array of ids and nothing else, so
 * this checks PRESENCE rather than attempting to parse free-text reasoning
 * for negation ("neither X nor Y authorizes...") -- a proximity heuristic
 * tried here first and broke on exactly that phrasing, rejecting a correct
 * answer for explaining its own exclusion. Any narrative belongs in
 * `finding`, which this check does not read.
 */
function flags(text: string, id: number): boolean {
  const pad = String(id).padStart(2, "0");
  return new RegExp(`collect(?:or)?${pad}\\b`).test(text);
}

/**
 * How many collectors the fixture ships, read rather than hardcoded so the
 * check follows the fixture if it grows.
 */
const COLLECTOR_COUNT = fs
  .readdirSync(path.resolve(import.meta.dir, "../fixtures/summarizer-migration-drift/src"))
  .filter((name) => /^collector\d+\.ts$/.test(name)).length;

const checks = [
  {
    // THE FIRST HALF OF THE POINT. `docs/INGEST.md` states the naming rule once
    // at the start, the fourteen collectors are read after it, and the budget
    // is small enough that the early messages are evicted before the answer is
    // written. A constraint stated once and never restated is exactly what
    // compaction loses.
    id: "retains-the-constraint",
    passed: carries(
      constraintWords,
      ["source", "field", "function", "name"],
      ["source", "matches", "function"],
      ["source", "own", "name"],
      ["source", "collector's", "name"],
      ["source", "same", "name"],
      ["source", "equal", "name"],
    ),
  },
  {
    // The constraint is only retained if the model also knows what it protects:
    // restating the sentence without the consequence is recall without
    // comprehension, and misattribution in the alerting pipeline is the
    // consequence INGEST.md names.
    id: "knows-what-the-constraint-protects",
    passed: carries(
      all,
      ["alerting"],
      ["alert", "wrong"],
      ["misattribut"],
      ["attributes", "wrong"],
      ["wrong", "source"],
      ["silently", "wrong"],
    ),
  },
  {
    // THE SECOND HALF OF THE POINT, and the harder one: this is not recall of a
    // single fact but reconciling it against a SECOND source that disagrees.
    // `docs/PATCH-NOTES.md` -- also read early, also compactable -- carves out
    // collect12 and collect13 as sanctioned. The one collector that actually
    // violates the constraint is collect09, whose body reports
    // `source: "collect07"`, unsanctioned by either document. Finding it
    // requires holding both documents against all fourteen bodies at once.
    //
    // Matched on the id alone, not a pair with "07": the prompt asks only for
    // "every collector id whose source field is an unsanctioned violation",
    // and the pass sample -- a correct, complete answer -- reports exactly
    // `["collect09"]` with no mention of collect07. Demanding the pair would
    // fail a correct answer for not restating a detail nobody asked it to
    // restate, which is the vocabulary-not-meaning defect this corpus keeps
    // finding: several models failing one check identically usually means the
    // check is wrong, not the models.
    id: "identifies-the-unsanctioned-drift",
    passed: flags(violationsText, 9),
  },
  {
    // THE FALSE-POSITIVE HALF OF THE RECONCILIATION. `docs/PATCH-NOTES.md`
    // explicitly sanctions collect12 and collect13's `-v2` source values, so
    // an id belongs in `violations` only when it is a live, unsanctioned
    // finding. The prompt draws that line, not this scorer: it asks for "every
    // collector id whose source field is an UNSANCTIONED violation", so an
    // answer that reasons about 12/13 in `finding` while correctly omitting
    // them from `violations` is not punished -- only listing them AS a
    // violation is.
    id: "avoids-flagging-sanctioned-renames",
    passed: violationWords.size > 0 && !flags(violationsText, 12) && !flags(violationsText, 13),
  },
  {
    // It read the whole set rather than sampling a few and generalising: the
    // answer must name most of the collectors by number.
    id: "inspected-every-collector",
    passed: (() => {
      const text = flatten(answer).toLowerCase();
      const named = Array.from(
        { length: COLLECTOR_COUNT },
        (_, index) => `collect${String(index + 1).padStart(2, "0")}`,
      ).filter((name) => text.includes(name)).length;
      return COLLECTOR_COUNT > 0 && named >= COLLECTOR_COUNT - 1;
    })(),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
