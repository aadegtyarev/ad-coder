import * as fs from "node:fs";

interface Issue {
  id?: string;
  title?: string;
  requirements?: unknown;
  dependsOn?: unknown;
}

interface Answer {
  issues?: Issue[];
  alreadySatisfied?: unknown;
}

interface Report {
  plannerDelegated?: boolean;
  finalText?: string;
}

/** Requirement ids as the ticket spells them, from any shape a model reached for. */
function ids(value: unknown): string[] {
  const text = Array.isArray(value)
    ? value.map((item) => String(item)).join(" ")
    : typeof value === "string"
      ? value
      : "";
  return [...text.toUpperCase().matchAll(/\bR([1-6])\b/g)].map((match) => `R${match[1]}`);
}

const file = process.argv[2];
if (!file) throw new Error("usage: orchestrator-decompose <report.json>");

/**
 * The decomposition, or an empty one when the orchestrator produced nothing a
 * scorer can read.
 *
 * An unreadable answer fails every check rather than throwing: a scorer that
 * throws makes a model failure look like a harness failure, and the run leaves
 * the sample instead of being counted as the bad answer it was.
 */
function readAnswer(path: string): { report: Report; answer: Answer } {
  const report = JSON.parse(fs.readFileSync(path, "utf8")) as Report;
  const text = report.finalText ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { report, answer: {} };
  try {
    return { report, answer: JSON.parse(text.slice(start, end + 1)) as Answer };
  } catch {
    return { report, answer: {} };
  }
}

const { report, answer } = readAnswer(file);
const issues = Array.isArray(answer.issues) ? answer.issues : [];
const satisfied = new Set(ids(answer.alreadySatisfied));
const placements = issues.flatMap((issue) => ids(issue.requirements));
const counted = new Map<string, number>();
for (const id of placements) counted.set(id, (counted.get(id) ?? 0) + 1);
/** The single issue carrying a requirement, when exactly one does. */
const issueFor = (requirement: string): Issue | undefined =>
  counted.get(requirement) === 1
    ? issues.find((issue) => ids(issue.requirements).includes(requirement))
    : undefined;

const checks = [
  {
    // A decomposition the orchestrator invented alone is not the workflow this
    // task measures: the prompt asks for the Planner, and a ledger row stepped
    // `role:planner` is the only proof one actually ran.
    id: "delegates-to-planner",
    passed: report.plannerDelegated === true,
  },
  {
    // R3 is already true in the fixture and belongs in `alreadySatisfied`, so
    // the open work is the other five. A requirement that reaches no issue is
    // work that will not happen -- the failure that makes a weak decomposition
    // expensive rather than merely untidy.
    id: "covers-every-open-requirement",
    passed:
      issues.length > 0 &&
      ["R1", "R2", "R4", "R5", "R6"].every((requirement) => counted.has(requirement)),
  },
  {
    // The same requirement in two issues is two people doing one job, and
    // neither knowing the other is.
    id: "no-requirement-in-two-issues",
    passed: issues.length > 0 && [...counted.values()].every((count) => count === 1),
  },
  {
    // R4 reads as two asks -- a limit AND a rejection -- and is one: a limit
    // that does not reject is not a limit. A model splitting on the conjunction
    // produces an issue nobody can finish alone.
    id: "keeps-one-requirement-whole",
    passed: counted.get("R4") === 1,
  },
  {
    // R5 and R6 are adjacent, both about SMS robustness, and separately
    // shippable: a webhook that records status has nothing to do with retrying a
    // failed send. Collapsing them hides one behind the other.
    id: "splits-two-requirements-apart",
    passed:
      counted.get("R5") === 1 &&
      counted.get("R6") === 1 &&
      issueFor("R5")?.id !== undefined &&
      issueFor("R5")?.id !== issueFor("R6")?.id,
  },
  {
    // `sendNotification` already rejects an empty recipient before any provider
    // call. An issue for R3 is work that is already done, which a decomposition
    // is supposed to notice rather than schedule.
    id: "excludes-the-satisfied-requirement",
    passed: satisfied.has("R3") && !counted.has("R3"),
  },
  {
    // R2 logs the SMS provider's delivery id, which does not exist until R1
    // sends over SMS. It is the one real ordering constraint among several pairs
    // that merely sound related.
    id: "orders-the-real-dependency",
    passed: (() => {
      const carrier = issueFor("R1");
      const logger = issueFor("R2");
      if (carrier?.id === undefined || logger === undefined) return false;
      if (carrier.id === logger.id) return false;
      // Compared as issue ids, never through the requirement-id reader: a model
      // that names its issues after the requirements they carry (`NS-114-R1`)
      // made that reader see a requirement token inside a dependency and reject
      // a correct answer. The dependency is a reference to an issue, so it is
      // read as one.
      const declared = Array.isArray(logger.dependsOn)
        ? logger.dependsOn.map((value) => String(value))
        : [];
      return declared.includes(carrier.id);
    })(),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
