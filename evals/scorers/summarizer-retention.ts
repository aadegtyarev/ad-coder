import * as fs from "node:fs";
import * as path from "node:path";

interface Answer {
  /** What the role reports the shared defect to be. */
  finding?: string;
  /** The constraint it must still be carrying after compaction. */
  constraint?: string;
  /** The handlers it inspected. */
  handlers?: unknown;
}

const file = process.argv[2];
if (!file) throw new Error("usage: summarizer-retention <answer.json>");

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

/** True when the text carries every word of some group. */
const carries = (set: Set<string>, ...groups: string[][]): boolean =>
  groups.some((group) => group.every((word) => set.has(word)));

/**
 * How many handlers the fixture ships, read rather than hardcoded so the check
 * follows the fixture if it grows.
 */
const HANDLER_COUNT = fs
  .readdirSync(path.resolve(import.meta.dir, "../fixtures/summarizer-retention/src"))
  .filter((name) => /^handler\d+\.ts$/.test(name)).length;

const checks = [
  {
    // THE POINT OF THE TASK. `docs/ROLLOUT.md` is read first, the twelve
    // handlers are read after it, and the budget is small enough that the early
    // messages are evicted before the answer is written. A constraint stated
    // once at the start and never restated is exactly what compaction loses, and
    // it is what an operator's requirement looks like in a real run.
    id: "retains-the-constraint",
    passed: carries(
      constraintWords,
      ["handler", "field"],
      ["handler", "name"],
      ["field", "name"],
      ["spelled", "name"],
      ["matches", "function"],
    ),
  },
  {
    // The constraint is only retained if the model also knows what it protects.
    // Restating the sentence without the consequence is recall without
    // comprehension, and the dashboard is the consequence the document names.
    id: "knows-what-the-constraint-protects",
    passed: carries(all, ["dashboard"], ["dashboards"], ["panel"]),
  },
  {
    // The work it was actually asked to do, so a run that retains the constraint
    // and answers nothing scores nothing. The handlers duplicate one body; the
    // shared defect is that duplication.
    id: "reports-the-duplication",
    passed: carries(
      all,
      ["duplicat"],
      ["duplicate"],
      ["duplicated"],
      ["duplication"],
      ["identical"],
      ["near", "identical"],
      ["copy", "paste"],
      ["repeated"],
    ),
  },
  {
    // It read the whole set rather than sampling two and generalising: the
    // answer must name most of the handlers by number.
    id: "inspected-every-handler",
    passed: (() => {
      const text = flatten(answer).toLowerCase();
      const named = Array.from(
        { length: HANDLER_COUNT },
        (_, index) => `handle${String(index + 1).padStart(2, "0")}`,
      ).filter((name) => text.includes(name)).length;
      return HANDLER_COUNT > 0 && named >= HANDLER_COUNT - 1;
    })(),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
