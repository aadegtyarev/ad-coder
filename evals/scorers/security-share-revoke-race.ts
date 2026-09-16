import * as fs from "node:fs";

interface Threat {
  code?: string;
  step?: number | string;
  severity?: string;
  cwe?: string;
  exploit?: string;
  mitigation?: string;
}

/** See the medium security scorer for why words and CWE ids are both accepted. */
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
if (!file) throw new Error("usage: security-share-revoke-race <threats.json>");

/** See the medium security scorer for why an unreadable answer fails rather than throws. */
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
 * The plan in the task prompt has four numbered steps. See the medium security
 * scorer for why this is a constant here rather than parsed from the prompt.
 */
const PLAN_STEPS = 4;

/** `info` is the hardening tier: the model has said it is not asserting a threat. */
const asserted = threats.filter((threat) => (threat.severity ?? "").toLowerCase() !== "info");
const codes = asserted.map((threat) => tokens(`${threat.code ?? ""} ${threat.exploit ?? ""}`));
const ids = asserted.map(cwes);

/** True when some asserted threat carries a listed CWE, or all words of some group. */
const matches = (cweIds: string[], ...groups: string[][]): boolean =>
  ids.some((set) => cweIds.some((id) => set.has(id))) ||
  groups.some((group) => codes.some((code) => group.every((word) => code.has(word))));

const checks = [
  {
    // THE POINT OF THE TASK. `revokeShare` (step 3) updates only the canonical
    // store; `resolveForDownload` (step 2) never re-checks that store on a
    // cache hit, and nothing in the plan calls `cache.evict`. The two stores of
    // truth -- the canonical record and the cached copy -- disagree from the
    // instant revocation runs, and the plan's own acceptance criterion ("nobody
    // holding the token can download it again") is false for up to
    // `CACHE_TTL_MS` afterward. This is the ordering invariant the plan breaks:
    // a revoke must happen-before every subsequent read is served, and the
    // cached path never enforces that order.
    id: "detects-stale-cache-bypass-revocation",
    passed: matches(
      ["cwe-613", "cwe-459", "cwe-362", "cwe-841"],
      ["cache", "revoke"],
      ["cache", "revoked"],
      ["cache", "revocation"],
      ["stale", "cache"],
      ["cache", "bypass"],
      ["cache", "bypasses"],
      ["cache", "evict"],
      ["cache", "eviction"],
      ["cache", "invalidate"],
      ["cache", "invalidated"],
      ["cache", "invalidation"],
      ["ttl", "revoke"],
      ["ttl", "revoked"],
      ["revoked", "download"],
      ["revocation", "race"],
      ["stale", "authorization"],
      ["stale", "download"],
      ["two", "sources", "truth"],
      ["disagree", "cache"],
    ),
  },
  {
    // The first trap: the plan explicitly registers the download route "the
    // same way the existing `GET /shares/:token` route is" -- no session check,
    // by design, because the contract makes token possession sufficient
    // authorization for a capability-shaped token. A threat claiming this route
    // is missing authentication has not read the contract.
    id: "avoids-missing-auth-false-positive",
    passed:
      threats.length > 0 &&
      !matches(
        ["cwe-306", "cwe-862", "cwe-285"],
        ["missing", "auth"],
        ["missing", "authentication"],
        ["missing", "authorization"],
        ["no", "authentication"],
        ["unauthenticated", "download"],
        ["broken", "access"],
      ),
  },
  {
    // The second trap: step 2 states `cache.put` is called only from inside
    // `resolveForDownload`, only with the record `store.getShare` itself just
    // returned -- never with data taken from the request. A threat claiming an
    // attacker can poison or forge a cache entry has invented a call path this
    // plan does not have.
    id: "avoids-cache-poisoning-false-positive",
    passed:
      threats.length > 0 &&
      !matches(
        ["cwe-349", "cwe-345"],
        ["cache", "poisoning"],
        ["poison", "cache"],
        ["forged", "cache"],
        ["forge", "cache"],
        ["untrusted", "cache"],
        ["arbitrary", "cache", "key"],
      ),
  },
  {
    // EVERY THREAT IS FILED AGAINST A STEP THAT EXISTS. See the medium security
    // scorer for the digit-extraction rule -- `"step 3"` names the same step as
    // `3`, less precisely rather than invented.
    id: "cites-only-real-plan-steps",
    passed:
      asserted.length > 0 &&
      asserted.every((threat) => {
        const step = (threat as { step?: unknown }).step;
        if (step === undefined || step === null) return true;
        const digits = /\d+/.exec(String(step));
        const value = typeof step === "number" ? step : Number(digits?.[0] ?? Number.NaN);
        return Number.isInteger(value) && value >= 1 && value <= PLAN_STEPS;
      }),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
