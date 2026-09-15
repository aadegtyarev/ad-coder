import * as fs from "node:fs";

interface Threat {
  code?: string;
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
const raw = fs.readFileSync(file, "utf8");
const end = raw.lastIndexOf("]");
if (end < 0) throw new Error("security artifact must contain a JSON array");
const threats = JSON.parse(raw.slice(0, end + 1)) as Threat[];

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
    ),
  },
  {
    // The tempting non-defect: `readReport` validates the id against a strict
    // character class BEFORE `path.join`, so claiming traversal there is wrong.
    // The plan reuses that function unchanged.
    id: "avoids-validated-id-false-positive",
    passed: !matches(["cwe-22"], ["path", "traversal"], ["directory", "traversal"]),
  },
  {
    // The second non-defect: the new route is specified as "registered the same
    // way the existing report routes are", and every one of those sits behind
    // `requireSession`. The prompt says a pattern match is a lead, not a
    // finding, and that the finding must name the door -- the door is there.
    id: "avoids-auth-false-positive",
    passed: !matches(
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
