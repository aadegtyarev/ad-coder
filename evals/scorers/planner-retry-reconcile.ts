import * as fs from "node:fs";
import * as path from "node:path";

interface Conflict {
  topic?: string;
  specSays?: string;
  contractSays?: string;
  resolution?: string;
}

interface Plan {
  summary?: string;
  steps?: { step?: string; acceptance?: string }[];
  contracts?: { rule?: string; source?: string }[];
  conflicts?: Conflict[];
  evidenceRating?: string;
  securitySurface?: string;
  complexity?: string;
}

/**
 * The contract's rule text (and the source it governs), the same way
 * `planner-contract-carry.ts` grounds a carried rule -- a `contracts` entry
 * scores only when its quoted text is actually findable in the file it claims
 * to come from. The draft spec is deliberately excluded here: it is the
 * SECOND, disagreeing source, not the rule a `contracts` entry may quote.
 */
const CONTRACT_TEXT = (() => {
  const root = path.resolve(import.meta.dir, "../fixtures/queue-retry-ordering");
  const read = (dir: string, extension: string): string =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(extension))
      .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
      .join("\n");
  return `${read(path.join(root, "docs/contracts"), ".md")}\n${read(path.join(root, "src"), ".ts")}`;
})();

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

const NORMALIZED_CONTRACTS = normalize(CONTRACT_TEXT);

/** A `contracts` entry's text, but only once it is verified against the file it claims to quote. */
function verifiedRuleWords(plan: Plan): Set<string>[] {
  return (plan.contracts ?? [])
    .filter((entry) => {
      const rule = normalize(entry.rule ?? "");
      return rule !== "" && NORMALIZED_CONTRACTS.includes(rule);
    })
    .map(
      (entry) =>
        new Set(
          (entry.rule ?? "")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean),
        ),
    );
}

const file = process.argv[2];
if (!file) throw new Error("usage: planner-retry-reconcile <plan.json>");
/**
 * The model's answer, or an empty one when it did not produce something this
 * scorer can read.
 *
 * WHY NOT THROW. A scorer that throws on malformed output turns a MODEL failure
 * into a HARNESS failure: the runner sees a non-zero exit and drops the run, so
 * the measurement leaves the sample entirely. That silently flatters the model,
 * because the runs it loses are its worst ones. An empty answer fails every
 * check instead, which is what a prompt demanding strict JSON means when the
 * answer is not JSON.
 */
function readAnswer(path: string): Plan {
  const raw = fs.readFileSync(path, "utf8");
  const end = raw.lastIndexOf("}");
  if (end < 0) return {};
  try {
    return JSON.parse(raw.slice(0, end + 1)) as Plan;
  } catch {
    return {};
  }
}

const plan = readAnswer(file);
const rules = verifiedRuleWords(plan);
const conflicts = plan.conflicts ?? [];
const steps = plan.steps ?? [];

/** True when one verified carried rule's text contains every word of some group. */
const carries = (...groups: string[][]): boolean =>
  groups.some((group) => rules.some((rule) => group.every((word) => rule.has(word))));

/** Everything a conflict entry says, joined, lower-cased. */
const conflictText = (c: Conflict): string =>
  `${c.topic ?? ""} ${c.specSays ?? ""} ${c.contractSays ?? ""} ${c.resolution ?? ""}`.toLowerCase();

/** The conflict entry about the retry-attempt ceiling, if reported at all. */
const attemptConflict = conflicts.find((c) => {
  const text = conflictText(c);
  return /attempt/.test(text) && (/\b3\b/.test(text) || /\b5\b/.test(text));
});

/** The wordings that name the contract's attempt-count rule. */
const ATTEMPT_GROUPS = [
  ["3", "attempts"],
  ["three", "attempts"],
  ["at", "most", "3"],
  ["3rd", "failed", "attempt"],
  ["3", "attempt", "total"],
];

/** The wordings that name the contract's no-ordering-across-workers invariant. */
const CONCURRENCY_GROUPS = [
  ["nothing", "orders"],
  ["not", "enqueue", "order"],
  ["no", "enqueue", "order"],
  ["retried", "enqueue", "order"],
  ["delivered", "enqueue", "order"],
  ["not", "assume", "order"],
];

/**
 * The false defect the fixture plants: the draft spec asks that "two jobs
 * with the same id should never be in flight at once", which reads like a
 * missing guard -- but `claim()` already removes a job from `pending` into
 * `inFlight` before returning it, so a second claim of the same id is already
 * impossible. A plan that proposes new locking, a guard, or a check for this
 * has pattern-matched the spec's wording rather than read the code the
 * prompt explicitly points at.
 *
 * Matched as a WORD PAIR, the same technique `carries` uses, rather than a
 * brittle phrase regex: an action word (add/introduce/implement/new) together
 * with a synchronization word (lock/mutex/guard/duplicate) anywhere in the
 * same step is the pattern-match this check exists to catch, however the
 * sentence around it is built.
 */
const ACTION_WORDS = new Set([
  "add",
  "adds",
  "adding",
  "introduce",
  "introduces",
  "new",
  "implement",
  "implements",
]);
const GUARD_WORDS = new Set(["lock", "mutex", "guard", "duplicate", "duplicates"]);
function proposesInventedGuard(step: { step?: string; acceptance?: string }): boolean {
  const words = new Set(
    `${step.step ?? ""} ${step.acceptance ?? ""}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const hasAction = [...ACTION_WORDS].some((w) => words.has(w));
  const hasGuard = [...GUARD_WORDS].some((w) => words.has(w));
  return hasAction && hasGuard;
}

/**
 * An acceptance criterion the prompt would accept: "checkable by running
 * something". Matched on the presence of an observable rather than a
 * sentence shape, since models phrase this many ways.
 */
const RUNNABLE =
  /\b(\d{3}\b|curl|test|assert|throws?|rejects?|returns?|exits?|logs?|fails?|status|response)\b/i;

const checks = [
  {
    // The central reconciliation: two sources of truth on the retry-attempt
    // ceiling (contract: 3, draft spec: 5) disagree, and the prompt demands the
    // contradiction be reported attributably on both sides rather than
    // silently resolved by implementing one and staying quiet about the other.
    id: "reports-attempt-conflict",
    passed: attemptConflict !== undefined,
  },
  {
    // Plan on: the enforceable contract wins, the spec's request is flagged as
    // an operator decision rather than adopted quietly. A resolution that
    // settles on 5 attempts without naming the contract, or that omits a
    // resolution at all, has picked a side by default instead of deciding.
    id: "resolves-toward-contract",
    passed:
      attemptConflict !== undefined &&
      /\b3\b/.test((attemptConflict.resolution ?? "").toLowerCase()) &&
      /(contract|enforceable|operator|not yet|draft)/i.test(attemptConflict.resolution ?? ""),
  },
  {
    // The attempt-count rule, carried as text the Coder can execute against --
    // not cited by path, and verified against the actual contract file.
    id: "carries-attempt-count-rule",
    passed: carries(...ATTEMPT_GROUPS),
  },
  {
    // The concurrency invariant: workers claim jobs with no ordering guarantee
    // relative to one another. A Coder who does not carry this may add
    // sequencing logic the fixture explicitly says is unwarranted.
    id: "carries-concurrency-invariant",
    passed: carries(...CONCURRENCY_GROUPS),
  },
  {
    // The planted false defect. `claim()` already makes a second claim of an
    // in-flight id impossible; a step proposing new locking for it has not
    // read the code the prompt points at.
    id: "rejects-false-double-claim-fix",
    passed: !steps.some(proposesInventedGuard),
  },
  {
    // "returns 429 after 100 requests in a minute", not "retries work" -- the
    // planner prompt's own example. Demanded of every step, not just one.
    id: "acceptance-is-runnable",
    passed: steps.length > 0 && steps.every((step) => RUNNABLE.test(step.acceptance ?? "")),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
