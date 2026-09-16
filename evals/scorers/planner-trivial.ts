import * as fs from "node:fs";
import * as path from "node:path";

interface Plan {
  summary?: string;
  steps?: { step?: string; acceptance?: string }[];
  contracts?: { rule?: string; source?: string }[];
  complexity?: string;
}

/**
 * The fixture's own contract text, located relative to THIS FILE.
 *
 * A live run scores `<target>/artifact.json` with the fixture beside it; the
 * corpus smoke scores a flat sample with no fixture anywhere near. Scorers and
 * fixtures are fixed sibling directories, so this path holds for both.
 */
const CONTRACT_TEXT = (() => {
  const dir = path.resolve(import.meta.dir, "../fixtures/reviewer-trivial/docs/contracts");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
})();

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();
const NORMALIZED = normalize(CONTRACT_TEXT);

const file = process.argv[2];
if (!file) throw new Error("usage: planner-trivial <plan.json>");

/** See the medium planner scorer for why an unreadable answer fails rather than throws. */
function readAnswer(target: string): Plan {
  const raw = fs.readFileSync(target, "utf8");
  const end = raw.lastIndexOf("}");
  if (end < 0) return {};
  try {
    return JSON.parse(raw.slice(0, end + 1)) as Plan;
  } catch {
    return {};
  }
}

const plan = readAnswer(file);
const steps = plan.steps ?? [];

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

const allText = words(
  `${plan.summary ?? ""} ${steps.map((s) => `${s.step ?? ""} ${s.acceptance ?? ""}`).join(" ")}`,
);

const carries = (set: Set<string>, ...groups: string[][]): boolean =>
  groups.some((group) => group.every((word) => set.has(word)));

/**
 * An acceptance criterion the planner prompt would accept: checkable by running
 * something. Matched on the presence of an observable rather than on a sentence
 * shape, since models phrase this many ways.
 */
const RUNNABLE =
  /\b(\d{3}\b|curl|test|assert|throws?|rejects?|returns?|exits?|logs?|fails?|status|equals?|expects?)\b/i;

/**
 * WHY A TRIVIAL PLANNING TASK IS NOT A SMALLER MEDIUM ONE.
 *
 * The tier answers one question -- is the cheapest model adequate -- so the
 * problem is the kind that arrives constantly and never justifies an expensive
 * model: one function, one line, the fix uniquely determined. What it still has
 * to measure is RESTRAINT, because the expensive failure here is a planner that
 * turns a one-line fix into a six-step project. `planner.md` says so directly:
 * "For a bounded task with explicit files and acceptance criteria, inspect
 * those files... then submit. Do not widen into unrelated modules."
 */
const checks = [
  {
    // The fix: `||` treats a supplied 0 as absent. The plan must say what to
    // change, not merely that something is wrong.
    id: "names-the-fix",
    passed: carries(
      allText,
      ["nullish", "coalesc"],
      ["falsy", "fallback"],
      ["zero", "default"],
      ["zero", "retry"],
      ["replace", "operator"],
      ["logical", "or"],
      ["or", "operator"],
      ["falsy", "check"],
      ["default", "applied"],
    ),
  },
  {
    // The contract line the change must honour, carried as text rather than
    // cited by path -- the Coder gets only the plan.
    id: "carries-the-contract-rule",
    passed: (plan.contracts ?? []).some((entry) => {
      const rule = normalize(entry.rule ?? "");
      return rule !== "" && NORMALIZED.includes(rule);
    }),
  },
  {
    // "retryCount(0) returns 0", not "retries work correctly".
    id: "acceptance-is-runnable",
    passed: steps.length > 0 && steps.every((step) => RUNNABLE.test(step.acceptance ?? "")),
  },
  {
    // RESTRAINT. A one-line fix with one regression test is at most two steps.
    // A planner that produces six has turned a bounded task into a project, and
    // that is the expensive failure at this tier however cheap the model is.
    id: "bounded-plan",
    passed: steps.length >= 1 && steps.length <= 2,
  },
  {
    // The tier is a property of the change, and this one is one file, one
    // function, no call sites, fix uniquely determined.
    id: "rates-trivial",
    passed: (plan.complexity ?? "").toLowerCase() === "trivial",
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
