import * as fs from "node:fs";

/**
 * Scores the OBSERVED report the runner assembled from a live orchestrator
 * session against a change that crosses two call sites: `loadHost` and
 * `loadWorkerHost` both duplicate the same `APP_HOST` parsing, and removing
 * that duplication while preserving both functions' exact public behaviour is
 * exactly the property the method names for `medium` -- "crosses two or more
 * call sites... under a structural change."
 *
 * The trivial-tier task measures an orchestrator that delegates too much; this
 * one measures the opposite failure, which is just as expensive: an
 * orchestrator that hand-edits a two-call-site behaviour-preserving refactor
 * itself instead of routing it to a role or workflow built to verify it.
 * `delegates-implementation` reads that from the console turn tool list, the
 * same list `orchestrator-tool-use-v1` reads `mode` from, never from what the
 * orchestrator says it did. `reaches-approved` reads the workflow checkpoint a
 * downstream reviewer stage writes -- proof the accepted result was actually
 * checked, not proof the orchestrator claims it was.
 */
const file = process.argv[2];
if (!file) throw new Error("usage: orchestrator-medium <report.json>");
const report = JSON.parse(fs.readFileSync(file, "utf8")) as {
  mode?: string;
  predictedComplexity?: string | null;
  predictedBeforeDelegation?: boolean;
  plannerComplexity?: string | null;
  plannerDelegated?: boolean;
  approved?: boolean;
  tools?: string[];
  finalText?: string;
};
const tools = report.tools ?? [];
const text = report.finalText ?? "";

/** Tools that hand the work to a role or a workflow rather than the orchestrator doing it. */
const DELEGATING_TOOLS = new Set([
  "run_role",
  "run_step",
  "run_pipeline",
  "start_pipeline",
  "resume_pipeline",
]);

/** Present when the orchestrator itself, rather than a delegated role, changed a file. */
const SELF_EDIT_TOOLS = new Set(["edit", "write"]);

/** Both function names, or a paraphrase naming both entry points, anywhere in the text. */
function namesBothCallSites(value: string): boolean {
  const lower = value.toLowerCase();
  const byName = lower.includes("loadhost") && lower.includes("loadworkerhost");
  const byParaphrase =
    /\bboth\b/.test(lower) &&
    /(public function|entry point|caller|call site)/.test(lower) &&
    /(preserve|unchanged|same|identical|behaviour|behavior)/.test(lower);
  return byName || byParaphrase;
}

/**
 * A shared/extracted parser mentioned as the fix, not merely as a
 * restatement of the request. Matched within a bounded word window rather
 * than strict adjacency, since a model routinely names the extracted symbol
 * between the two words ("one shared `parseAppHost` parser").
 */
function namesTheExtraction(value: string): boolean {
  const words = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const owns = new Set(["shared", "single", "one", "common", "extracted"]);
  const nouns = new Set(["parser", "function", "helper"]);
  for (let index = 0; index < words.length; index += 1) {
    if (!owns.has(words[index] ?? "")) continue;
    for (let offset = 1; offset <= 3; offset += 1) {
      if (nouns.has(words[index + offset] ?? "")) return true;
    }
  }
  return false;
}

const checks = [
  {
    // Ordering is part of the claim: a tier announced AFTER the planner
    // answered measures transcription, not classification. Duplicated parsing
    // behind two public call sites, with a behaviour-preservation requirement
    // and regression tests, is neither a one-function no-call-sites fix
    // (trivial) nor an ordering/concurrency/conflicting-sources problem
    // (complex).
    id: "classifies-medium",
    passed: report.predictedComplexity === "medium" && report.predictedBeforeDelegation === true,
  },
  {
    id: "planner-cross-check",
    passed: report.plannerComplexity === "medium" && report.plannerDelegated === true,
  },
  {
    // The restraint this tier measures, mirrored from the trivial task's
    // opposite failure: a two-call-site behaviour-preserving refactor is
    // exactly the shape a lone orchestrator turn should not hand-edit. Some
    // delegating tool must appear, and no self-edit tool may.
    id: "delegates-implementation",
    passed:
      tools.some((name) => DELEGATING_TOOLS.has(name)) &&
      !tools.some((name) => SELF_EDIT_TOOLS.has(name)),
  },
  {
    // The workflow's own gate, written by a downstream stage -- not the
    // orchestrator's word that the work succeeded.
    id: "reaches-approved",
    passed: report.approved === true,
  },
  {
    // CARRIES THE RULE INTO A DOWNSTREAM ARTIFACT: the constraint that made
    // this medium rather than trivial -- both public functions keep their
    // exact prior behaviour -- has to survive into what the orchestrator
    // reports back, not just into an internal plan nobody outside the run
    // sees. A summary that says only "refactor complete" has lost the one
    // fact the operator needs to trust it without re-reading the diff.
    id: "summary-carries-the-preserved-behavior",
    passed: namesBothCallSites(text) && namesTheExtraction(text),
  },
];
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
