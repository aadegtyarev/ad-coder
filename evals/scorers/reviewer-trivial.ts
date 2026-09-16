import * as fs from "node:fs";

interface Finding {
  code?: string;
  blocking?: boolean;
  severity?: string;
  evidence?: unknown;
}

const file = process.argv[2];
if (!file) throw new Error("usage: reviewer-trivial <findings.json>");

/** See the reviewer scorer for why an unreadable answer fails rather than throws. */
function readAnswer(path: string): Finding[] {
  const raw = fs.readFileSync(path, "utf8");
  const end = raw.lastIndexOf("]");
  if (end < 0) return [];
  try {
    return JSON.parse(raw.slice(0, end + 1)) as Finding[];
  } catch {
    return [];
  }
}

function isBlocking(finding: Finding): boolean {
  if (typeof finding.blocking === "boolean") return finding.blocking;
  const severity = (finding.severity ?? "").toLowerCase();
  return severity === "blocker" || severity === "blocking" || severity === "critical";
}

const tokens = (code: string): Set<string> =>
  new Set(
    code
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

const findings = readAnswer(file);
const blocking = findings.filter(isBlocking);
const codes = blocking.map((finding) => tokens(finding.code ?? ""));
const matches = (...groups: string[][]): boolean =>
  groups.some((group) => codes.some((code) => group.every((word) => code.has(word))));

/**
 * WHY A TRIVIAL REVIEW TASK IS NOT A SMALLER MEDIUM ONE.
 *
 * The trivial tier exists to answer exactly one question -- is the cheapest
 * model adequate here -- so the task has to be the kind of review that arrives
 * constantly and never justifies an expensive model: one defect, on one line,
 * in a diff short enough to hold in the head. What it still must measure is
 * whether the model stops there. The fixture therefore keeps its tempting
 * non-defect, because a reviewer that reports two findings on a two-line diff is
 * the failure that makes a cheap model unusable, and it is invisible in a check
 * that only asks whether the real defect was found.
 */
const checks = [
  {
    // The seeded defect: `??` treats 0 as present, `||` does not, so a supplied
    // zero silently becomes the default.
    id: "detects-zero-coerced-to-default",
    passed: matches(
      ["zero", "default"],
      ["falsy", "default"],
      ["nullish", "coalesc"],
      ["zero", "overwritten"],
      ["zero", "replaced"],
      ["logical", "or"],
      ["or", "default"],
      ["falsy", "check"],
      // Named by the MECHANISM rather than the symptom. Five of six live runs
      // scored exactly 0.57 by failing this check while their evidence
      // described the defect exactly -- one coded it
      // `zero-retry-count-broken-by-falsy-fallback` and proved it by evaluating
      // the changed expression. That is the check measuring the author's
      // vocabulary, which is the single most common defect found in this corpus.
      ["falsy", "fallback"],
      ["falsy", "coerc"],
      ["zero", "falsy"],
      ["zero", "retry"],
      ["zero", "treated"],
      ["zero", "ignored"],
      ["default", "applied"],
      ["coalescing", "replaced"],
    ),
  },
  {
    // The tempting non-defect: the parameter is optional in the signature and
    // documented as such, so calling it "missing validation" is inventing work.
    id: "avoids-optional-parameter-false-positive",
    passed:
      blocking.length > 0 &&
      !matches(["missing", "validation"], ["unvalidated", "input"], ["no", "validation"]),
  },
  {
    // One defect, one finding. On a two-line diff this is the whole difference
    // between a usable cheap reviewer and an unusable one.
    id: "reports-exactly-one-blocking-finding",
    passed: blocking.length === 1,
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
