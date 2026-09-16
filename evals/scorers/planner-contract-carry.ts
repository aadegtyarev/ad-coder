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
  const root = path.resolve(import.meta.dir, "../fixtures/security-plan-threats");
  const read = (dir: string, extension: string): string =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(extension))
      .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
      .join("\n");
  // The contract files AND the source. A rule the planner quotes from a code
  // comment -- "every report route is registered behind `requireSession`" -- is
  // a real invariant of this fixture and exactly what a Coder adding a route
  // needs; a live plan carried it, and scoring only `docs/contracts` marked that
  // plan wrong for having read the code. Grounding in the fixture is the
  // defence against invention, and the fixture is more than its contracts.
  return `${read(path.join(root, "docs/contracts"), ".md")}\n${read(path.join(root, "src"), ".ts")}`;
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
const { verified: rules, total: contractCount } = verifiedRuleWords(plan);

/** Entries claiming to quote a contract FILE, which is a checkable claim. */
const quotedCount = (plan.contracts ?? []).filter((entry) =>
  /contracts?\//i.test(entry.source ?? ""),
).length;

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

/**
 * The contract rule this change does not touch: reports are written atomically.
 * The change reads a report and sends it, so carrying this rule is carrying
 * material the Coder must filter.
 */
const INAPPLICABLE_GROUPS = [
  ["written", "atomically"],
  ["atomic", "write"],
  ["partial", "file"],
  ["failed", "write"],
];

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
    // contract file satisfies both of them and is not the task, and a Coder
    // handed every rule has been told which ones matter no more precisely than
    // by the path alone. Fabricated entries fail here too: an unverified entry
    // is counted but never verified, so it cannot be reconciled against the
    // total.
    //
    // WHY THIS ASKS WHAT DID NOT ARRIVE, NOT WHAT DID. Demanding the set be
    // EXACTLY the two applicable rules failed a plan that also carried a real,
    // relevant invariant it had read in the code -- that every report route sits
    // behind `requireSession`, which is exactly what a Coder adding a route
    // needs to know. Penalising that is penalising good planning. What the task
    // is actually about is not dragging along material the change does not
    // touch, so the check now names that material and forbids it.
    //
    // WHY THE THIRD RULE IS PLAINLY INAPPLICABLE. It used to govern identifier
    // validation, and the change reads a report BY ID -- so carrying it was a
    // defensible reading, and six models across four families and two vendors
    // carried it and were marked wrong for it, every one of them failing this
    // single check at 0.82 while the most expensive scored lowest. That is a
    // check measuring the author's reading of "applicable", not the model's
    // ability to select. The rule is now about atomic WRITES, and this change
    // only reads and sends, so a model carrying it has genuinely failed to
    // select rather than merely disagreed.
    id: "carries-only-applicable-rules",
    passed:
      contractCount > 0 &&
      // Nothing invented. Applied to entries that CITE A CONTRACT FILE, because
      // those claim to be quotations and a quotation is checkable. An entry
      // sourced to the code is stating an invariant the planner read, in its own
      // words -- a live plan carried "every report route is registered behind
      // `requireSession`", which is true, is what a Coder adding a route needs,
      // and is nowhere written verbatim. Demanding a verbatim match of it marked
      // good planning wrong.
      rules.length === quotedCount &&
      // And the rule this change does not touch did not come along. That is
      // what pasting the file looks like, and it is the only thing this check
      // now forbids.
      !carries(...INAPPLICABLE_GROUPS),
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
