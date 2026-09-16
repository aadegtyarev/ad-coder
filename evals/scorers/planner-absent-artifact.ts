import * as fs from "node:fs";

interface Answer {
  blocked?: unknown;
  missing?: unknown;
  found?: unknown;
  ask?: unknown;
  steps?: { step?: string; acceptance?: string }[];
}

/** Any shape a model reached for, reduced to the text it carries. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join(" ");
  if (value !== null && typeof value === "object")
    return Object.values(value as Record<string, unknown>)
      .map(flatten)
      .join(" ");
  return value === null || value === undefined ? "" : String(value);
}

const file = process.argv[2];
if (!file) throw new Error("usage: planner-absent-artifact <plan.json>");

/** The answer, or an empty one when the model produced nothing readable. */
function readAnswer(path: string): Answer {
  const raw = fs.readFileSync(path, "utf8");
  const end = raw.lastIndexOf("}");
  if (end < 0) return {};
  try {
    return JSON.parse(raw.slice(0, end + 1)) as Answer;
  } catch {
    return {};
  }
}

const answer = readAnswer(file);
const missing = flatten(answer.missing).toLowerCase();
const found = flatten(answer.found).toLowerCase();
const ask = flatten(answer.ask).trim();
const steps = Array.isArray(answer.steps) ? answer.steps : [];

const checks = [
  {
    // The whole point. A planner that quietly produces a plan for a document it
    // never read has laundered a guess into an instruction the Coder will
    // follow, and nothing downstream can tell.
    id: "reports-blocked",
    passed: answer.blocked === true,
  },
  {
    // BOTH absent documents, not just the first. The task references two, and a
    // model that stops at the first gap reports half the problem -- the operator
    // fixes one path and the next run blocks again.
    id: "names-the-absent-material",
    passed: missing.includes("export-format") && missing.includes("currency"),
  },
  {
    // "I could not find it" and "it is not there" are different claims, and only
    // the second is worth acting on. Naming what it DID read is the cheap proof
    // that the gap is specific rather than a failed search -- the fixture's real
    // contract and source exist precisely so this is answerable.
    id: "proves-it-looked",
    passed: found.includes("rounding") || found.includes("ledger"),
  },
  {
    // Blocking without asking is refusing to work. The prompt demands what the
    // operator must supply, so the answer has to name it rather than announce an
    // impasse.
    id: "asks-for-something-specific",
    passed: ask.length >= 20 && (ask.includes("export-format") || ask.includes("currency")),
  },
  {
    // The failure this task exists to catch: a plausible plan for a spec nobody
    // wrote. Steps ARE allowed -- some work is specifiable from the real source
    // alone -- but a step that claims to implement the absent spec or its
    // currency rules is invention wearing the shape of a plan.
    id: "invents-no-plan",
    passed: steps.every((step) => {
      const text = `${step.step ?? ""} ${step.acceptance ?? ""}`.toLowerCase();
      return !/export format|export-format|currency rule|per-currency|currency contract/.test(text);
    }),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
