import * as fs from "node:fs";

interface Threat {
  code?: string;
  /** The plan step the threat is filed against; see PLAN_STEPS. */
  step?: number | string;
  severity?: string;
  cwe?: string;
  exploit?: string;
  mitigation?: string;
}

/**
 * WHY TOKENS AND CWE, NOT EXACT CODES. The task asks for "concise stable defect
 * codes" and supplies no vocabulary, exactly as the reviewer task does, so every
 * model spells the same threat its own way. Here there is a second, stronger
 * handle the reviewer task lacks: the prompt demands a CWE id, which IS a
 * controlled vocabulary. A threat therefore matches on either its CWE or its
 * words, because a model that writes `CWE-918` and codes it `OUTBOUND_URL` has
 * identified the defect as precisely as one that writes `SSRF`.
 */
function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

/** Every CWE id a threat mentions, anywhere in its fields, normalized to `cwe-###`. */
function cwes(threat: Threat): Set<string> {
  const text = [threat.cwe, threat.code, threat.exploit, threat.mitigation].join(" ").toLowerCase();
  return new Set([...text.matchAll(/cwe[-\s]?(\d+)/g)].map((match) => `cwe-${match[1]}`));
}

const file = process.argv[2];
if (!file) throw new Error("usage: security-plan-threats <threats.json>");
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
function readAnswer(path: string): Threat[] {
  const raw = fs.readFileSync(path, "utf8");
  const end = raw.lastIndexOf("]");
  if (end < 0) return [];
  try {
    return JSON.parse(raw.slice(0, end + 1)) as Threat[];
  } catch {
    return [];
  }
}

const threats = readAnswer(file);

/**
 * How many steps the plan in the task prompt actually has.
 *
 * The plan is three numbered steps. A threat filed against step 4 is filed
 * against something nobody wrote, which is the cheapest possible instance of the
 * failure this check exists for: the scorer reads the JSON the model asserted,
 * so an answer describing a call path it never traced scores exactly as well as
 * one that read the fixture. A step number is the one part of that claim which
 * is checkable without guessing at prose.
 *
 * Stated here rather than parsed from the prompt because the scorer is handed
 * only the answer; changing the plan means changing this number, which is why
 * the task's prompt and this constant are named in each other's comments.
 */
const PLAN_STEPS = 3;

/**
 * The Security prompt rates severity and this scorer honours it: `info` is
 * explicitly the hardening tier, so a threat filed there is a suggestion, not a
 * claim that the plan is unsafe. It counts neither for a real finding nor
 * against a false positive -- the model has already said it is not asserting one.
 */
const asserted = threats.filter((threat) => (threat.severity ?? "").toLowerCase() !== "info");
const codes = asserted.map((threat) => tokens(`${threat.code ?? ""} ${threat.exploit ?? ""}`));
const ids = asserted.map(cwes);

/** True when some asserted threat carries a listed CWE, or all words of some group. */
const matches = (cweIds: string[], ...groups: string[][]): boolean =>
  ids.some((set) => cweIds.some((id) => set.has(id))) ||
  groups.some((group) => codes.some((code) => group.every((word) => code.has(word))));

const checks = [
  {
    // Plan step 2: `destination` is a caller-supplied absolute URL the server
    // then POSTs to, and the fixture contract says outbound requests go only to
    // allow-listed hosts. This is the defect the task exists to measure.
    id: "detects-ssrf",
    passed: matches(
      ["cwe-918"],
      ["ssrf"],
      ["server", "request", "forgery"],
      ["outbound", "url"],
      ["destination", "url"],
      ["arbitrary", "url"],
      ["internal", "network"],
    ),
  },
  {
    // Plan step 3 returns the caught message plus the resolved destination and
    // the report path -- the contract forbids exactly that.
    id: "detects-error-disclosure",
    passed: matches(
      ["cwe-209"],
      ["cwe-200"],
      ["error", "disclosure"],
      ["information", "disclosure"],
      ["path", "disclosure"],
      ["verbose", "error"],
      ["leak", "path"],
      // The same defect named by WHAT is revealed rather than by the word
      // "disclosure". An alternative-valid sample coding it
      // `failure-response-reveals-storage-layout` -- with a CWE-200 id and an
      // exploit naming the report path -- scored zero here, which is the check
      // measuring vocabulary rather than the finding.
      ["reveals", "layout"],
      ["reveals", "path"],
      ["exposes", "path"],
      ["storage", "layout"],
      ["error", "message"],
    ),
  },
  {
    // The tempting non-defect: `readReport` validates the id against a strict
    // character class BEFORE `path.join`, so claiming traversal there is wrong.
    // The plan reuses that function unchanged.
    // Requires an answer first; see the reviewer scorer for why an empty
    // artifact must not score a negative check.
    id: "avoids-validated-id-false-positive",
    passed:
      threats.length > 0 && !matches(["cwe-22"], ["path", "traversal"], ["directory", "traversal"]),
  },
  {
    // EVERY THREAT IS FILED AGAINST A STEP THAT EXISTS. See PLAN_STEPS. A
    // threat may legitimately omit the field -- an answer that does not claim a
    // location has not claimed a false one -- but a number outside the plan is
    // a claim about work nobody proposed.
    id: "cites-only-real-plan-steps",
    passed:
      asserted.length > 0 &&
      asserted.every((threat) => {
        const step = (threat as { step?: unknown }).step;
        if (step === undefined || step === null) return true;
        // A number written as `3`, `"3"` or `"step 3"` names the same step; the
        // last is less precise, not invented, and this check exists to catch a
        // threat filed against work nobody proposed. `Number.parseInt` alone
        // read `"step 3"` as NaN and failed it.
        const digits = /\d+/.exec(String(step));
        const value = typeof step === "number" ? step : Number(digits?.[0] ?? Number.NaN);
        return Number.isInteger(value) && value >= 1 && value <= PLAN_STEPS;
      }),
  },
  {
    // The second non-defect: the new route is specified as "registered the same
    // way the existing report routes are", and every one of those sits behind
    // `requireSession`. The prompt says a pattern match is a lead, not a
    // finding, and that the finding must name the door -- the door is there.
    id: "avoids-auth-false-positive",
    passed:
      threats.length > 0 &&
      !matches(
        ["cwe-306"],
        ["cwe-862"],
        ["missing", "authentication"],
        ["missing", "authorization"],
        ["unauthenticated", "access"],
        ["broken", "access"],
      ),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
