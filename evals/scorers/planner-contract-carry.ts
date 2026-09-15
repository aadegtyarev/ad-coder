import * as fs from "node:fs";

interface Plan {
  summary?: string;
  steps?: { step?: string; acceptance?: string }[];
  contracts?: { rule?: string; source?: string }[];
  evidenceRating?: string;
  securitySurface?: string;
  complexity?: string;
}

/**
 * WHY THE RULE TEXT, NOT THE PATH. The planner prompt's central demand is that
 * an applicable contract be CARRIED into the plan -- "a contract merely cited by
 * path has not been carried", because the Coder gets nothing but the plan. So a
 * `contracts` entry scores on the words of its `rule`, and naming
 * `docs/contracts/errors.md` as the source without the rule text fails, which is
 * exactly the failure the prompt warns about.
 */
function ruleWords(plan: Plan): Set<string>[] {
  return (plan.contracts ?? []).map(
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
if (!file) throw new Error("usage: planner-contract-carry <plan.json>");
const raw = fs.readFileSync(file, "utf8");
const end = raw.lastIndexOf("}");
if (end < 0) throw new Error("planner artifact must contain a JSON object");
const plan = JSON.parse(raw.slice(0, end + 1)) as Plan;
const rules = ruleWords(plan);

/** True when one carried rule's text contains every word of some group. */
const carries = (...groups: string[][]): boolean =>
  groups.some((group) => rules.some((rule) => group.every((word) => rule.has(word))));

/**
 * An acceptance criterion the prompt would accept: "checkable by running
 * something". Prose like "SSRF is prevented" is not, and the planner prompt
 * calls that out by name. Matched on the presence of an observable -- a status
 * code, a command, a named test, a thrown error, a rejected input -- rather than
 * on a sentence shape, since models phrase this many ways.
 */
const RUNNABLE =
  /\b(\d{3}\b|curl|test|assert|throws?|rejects?|returns?|exits?|logs?|fails?|status|response)\b/i;

const checks = [
  {
    // The contract the change actually touches: outbound requests go only to
    // allow-listed hosts. The plan sends to a caller-supplied URL, so this rule
    // is what stops the Coder from building an SSRF.
    id: "carries-allow-list-rule",
    passed: carries(
      ["allow", "list", "hosts"],
      ["allow", "listed", "hosts"],
      ["allowlist", "hosts"],
      ["outbound", "allow", "list"],
      ["outbound", "configured", "hosts"],
    ),
  },
  {
    // The second touched rule: an error returned to a client never includes the
    // path, the query, or credential material. The task explicitly asks for "a
    // useful failure reason", which is the pressure this rule resists.
    id: "carries-error-disclosure-rule",
    passed: carries(
      ["errors", "never", "path"],
      ["error", "never", "path"],
      ["never", "include", "path"],
      ["not", "include", "path"],
      ["without", "path"],
      ["never", "credential"],
    ),
  },
  {
    // A new outbound request to a user-influenced URL is named in the planner
    // prompt's own `elevated` list. Rating it `low` or `none` is the miss.
    id: "rates-surface-elevated",
    passed: (plan.securitySurface ?? "").toLowerCase() === "elevated",
  },
  {
    // Nothing in the fixture shows this feature failing -- it does not exist
    // yet. The prompt says `asserted` is a legitimate answer and warns against
    // laundering a hunch into `inspected` because admitting it feels weak.
    id: "rates-evidence-asserted",
    passed: (plan.evidenceRating ?? "").toLowerCase() === "asserted",
  },
  {
    // "returns 429 after 100 requests in a minute", not "rate limiting works" --
    // the prompt's own example. Demanded of every step, not just one, since one
    // runnable criterion among five vague ones is not a plan the Coder can run.
    id: "acceptance-is-runnable",
    passed:
      (plan.steps ?? []).length > 0 &&
      (plan.steps ?? []).every((step) => RUNNABLE.test(step.acceptance ?? "")),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
