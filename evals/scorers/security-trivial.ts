import * as fs from "node:fs";

interface Threat {
  code?: string;
  severity?: string;
  cwe?: string;
  exploit?: string;
  mitigation?: string;
}

const file = process.argv[2];
if (!file) throw new Error("usage: security-trivial <threats.json>");

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

const tokens = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

const threats = readAnswer(file);
/** `info` is the hardening tier: the model has said it is not asserting a threat. */
const asserted = threats.filter((t) => (t.severity ?? "").toLowerCase() !== "info");
const words = asserted.map((t) =>
  tokens(`${t.code ?? ""} ${t.exploit ?? ""} ${t.mitigation ?? ""}`),
);
const ids = asserted.map(
  (t) =>
    new Set(
      [
        ...`${t.cwe ?? ""} ${t.code ?? ""} ${t.exploit ?? ""}`
          .toLowerCase()
          .matchAll(/cwe[-\s]?(\d+)/g),
      ].map((m) => `cwe-${m[1]}`),
    ),
);

const matches = (cweIds: string[], ...groups: string[][]): boolean =>
  ids.some((set) => cweIds.some((id) => set.has(id))) ||
  groups.some((group) => words.some((w) => group.every((word) => w.has(word))));

/**
 * WHY THIS IS THE TRIVIAL SECURITY TASK.
 *
 * One route, one line of it wrong, and the wrongness is the absence of a call
 * every sibling route makes. That is the smallest real threat-modelling job:
 * no call graph to trace, no plan to reason about, just "which door is this
 * route missing". It measures the same restraint the medium task does, because
 * the fixture's other surfaces are correct and reporting them is inventing work.
 *
 * VOCABULARY IS MATCHED WIDELY ON PURPOSE. Five checks in this corpus have now
 * been found scoring the author's phrasing rather than the finding, most
 * recently on the trivial reviewer task where a model proved its defect by
 * execution and scored zero. A CWE id is accepted as an alternative to any
 * wording.
 */
const checks = [
  {
    // `DELETE /reports/:id` calls neither `requireSession` nor anything else:
    // any caller can delete any report. Every sibling route calls it.
    id: "detects-missing-authorization",
    passed: matches(
      ["cwe-306", "cwe-862", "cwe-285", "cwe-639"],
      ["missing", "auth"],
      ["missing", "session"],
      ["no", "auth"],
      ["without", "auth"],
      ["unauthenticated", "delete"],
      ["unauthorized", "delete"],
      ["broken", "access"],
      ["access", "control"],
      ["requiresession", "missing"],
      ["bypass", "session"],
    ),
  },
  {
    // The tempting non-defect: `readReport` validates the id against a strict
    // character class before `path.join`, and the new route reuses it.
    id: "avoids-validated-id-false-positive",
    passed:
      asserted.length > 0 &&
      !matches(["cwe-22"], ["path", "traversal"], ["directory", "traversal"]),
  },
  {
    // THE OWNERSHIP GAP IS REAL, AND FINDING IT IS NOT PADDING. The fixture's
    // `listReports` filters by an owner prefix, so the system is multi-tenant;
    // `deleteReport` takes a bare id and `readReport` knows nothing about
    // owners. A caller who passes the session check can therefore delete
    // someone else's report. Two live models found this unprompted and one
    // traced it through the fixture and proposed an adversarial test -- and the
    // first version of this check called that a failure, because it demanded
    // exactly one finding.
    //
    // It is scored as a BONUS rather than a requirement: the task names one
    // addition, and a threat model that stops at the missing door has done the
    // job it was asked for.
    id: "notices-the-ownership-gap",
    passed: matches(
      ["cwe-639", "cwe-863", "cwe-285"],
      ["owner", "scope"],
      ["ownership", "check"],
      ["cross", "tenant"],
      ["idor"],
      ["horizontal", "privilege"],
      ["другого", "владельца"],
      ["other", "owner"],
      ["another", "user"],
    ),
  },
  {
    // Restraint still measured, with the ceiling set by what the fixture
    // actually contains rather than by what the author first imagined: the two
    // real threats, and nothing beyond them.
    id: "bounded-threats",
    passed: asserted.length > 0 && asserted.length <= 2,
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
