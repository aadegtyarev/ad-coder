import * as fs from "node:fs";
import * as path from "node:path";

interface Plan {
  summary?: string;
  steps?: { step?: string; acceptance?: string }[];
  contracts?: { rule?: string; source?: string }[];
  evidenceRating?: string;
  securitySurface?: string;
  complexity?: string;
}

/**
 * The contract text this task's fixture actually contains.
 *
 * Found relative to this file rather than to the scored artifact, because the
 * artifact's location is not stable: a live run scores `<target>/artifact.json`,
 * whose siblings include the materialized fixture, while the corpus smoke scores
 * a flat sample under `evals/samples/`, which has no fixture beside it. Scorers
 * and fixtures are fixed sibling directories, so this path holds either way.
 */
const CONTRACT_TEXT = (() => {
  const dir = path.resolve(import.meta.dir, "../fixtures/security-plan-threats/docs/contracts");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
    .join("\n");
})();

/** Collapse runs of whitespace so a rule re-wrapped by a model still matches the file. */
const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

const NORMALIZED_CONTRACTS = normalize(CONTRACT_TEXT);

/**
 * WHY THE RULE TEXT, NOT THE PATH. The planner prompt's central demand is that
 * an applicable contract be CARRIED into the plan -- "a contract merely cited by
 * path has not been carried", because the Coder gets nothing but the plan. So a
 * `contracts` entry scores on the words of its `rule`, and naming
 * `docs/contracts/errors.md` as the source without the rule text fails, which is
 * exactly the failure the prompt warns about.
 *
 * WHY THE TEXT IS CHECKED AGAINST THE FILE. Scoring the words alone measured a
 * keyword bag, and a keyword bag is trivially satisfied without doing the task:
 * boilerplate invented from the expected vocabulary, sourced to "made up",
 * scored exactly as well as the real rule. A carried rule is a quotation, so it
 * has to be findable in the file it claims to come from; an entry that is not
 * contributes to nothing.
 */
function verifiedRuleWords(plan: Plan): { verified: Set<string>[]; total: number } {
  const entries = plan.contracts ?? [];
  const verified = entries
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
  return { verified, total: entries.length };
}

const file = process.argv[2];
if (!file) throw new Error("usage: planner-contract-carry <plan.json>");
const raw = fs.readFileSync(file, "utf8");
const end = raw.lastIndexOf("}");
if (end < 0) throw new Error("planner artifact must contain a JSON object");
const plan = JSON.parse(raw.slice(0, end + 1)) as Plan;
const { verified: rules, total: contractCount } = verifiedRuleWords(plan);

/** True when one verified carried rule's text contains every word of some group. */
const carries = (...groups: string[][]): boolean =>
  groups.some((group) => rules.some((rule) => group.every((word) => rule.has(word))));

/** The wordings that name the allow-list rule, in any phrasing a model reaches for. */
const ALLOW_LIST_GROUPS = [
  ["allow", "list", "hosts"],
  ["allow", "listed", "hosts"],
  ["allowlist", "hosts"],
  ["outbound", "allow", "list"],
  ["outbound", "configured", "hosts"],
];

/** The wordings that name the error-disclosure rule. */
const ERROR_DISCLOSURE_GROUPS = [
  ["errors", "never", "path"],
  ["error", "never", "path"],
  ["never", "include", "path"],
  ["not", "include", "path"],
  ["without", "path"],
  ["never", "credential"],
];

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
    passed: carries(...ALLOW_LIST_GROUPS),
  },
  {
    // The second touched rule: an error returned to a client never includes the
    // path, the query, or credential material. The task explicitly asks for "a
    // useful failure reason", which is the pressure this rule resists.
    id: "carries-error-disclosure-rule",
    passed: carries(...ERROR_DISCLOSURE_GROUPS),
  },
  {
    // SELECTION, NOT VOLUME. The two checks above ask whether each applicable
    // rule arrived; this one asks whether anything else did. Pasting the whole
    // contract file satisfies both of them and is not the task -- the third rule
    // in that file governs identifier validation, which this change does not
    // touch, and a Coder handed every rule has been told which ones matter no
    // more precisely than by the path alone. Fabricated entries fail here too:
    // an unverified entry is counted but never verified, so it cannot be
    // reconciled against the total.
    id: "carries-only-applicable-rules",
    passed:
      contractCount > 0 &&
      rules.length === contractCount &&
      rules.every((rule) =>
        [...ALLOW_LIST_GROUPS, ...ERROR_DISCLOSURE_GROUPS].some((group) =>
          group.every((word) => rule.has(word)),
        ),
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
