import * as fs from "node:fs";

/**
 * Scores the report the RUNNER assembled from a live orchestrator session.
 *
 * Every field here is an observation, not a claim: the tool list comes from the
 * console turn stream, `approved` and the planner's tier from the workflow
 * checkpoint, and `plannerDelegated` from a ledger row whose step is
 * `role:planner` -- the one artefact that proves a planner turn really ran.
 * The previous version accepted the two complexity tiers as operator-supplied
 * argv, which made "did it classify correctly" and "did the planner agree" the
 * same number typed twice.
 */
const file = process.argv[2];
if (!file) throw new Error("usage: orchestrator-tool-use <report.json>");
const report = JSON.parse(fs.readFileSync(file, "utf8")) as {
  predictedComplexity?: string | null;
  predictedBeforeDelegation?: boolean;
  plannerComplexity?: string | null;
  plannerDelegated?: boolean;
  mode?: string;
  approved?: boolean;
  tools?: string[];
};
const tools = new Set(report.tools ?? []);
console.log(
  JSON.stringify(
    [
      {
        // Ordering is part of the claim: a tier announced AFTER the planner
        // answered measures transcription, not classification.
        id: "classifies-complex",
        passed:
          report.predictedComplexity === "complex" && report.predictedBeforeDelegation === true,
      },
      {
        id: "planner-cross-check",
        passed: report.plannerComplexity === "complex" && report.plannerDelegated === true,
      },
      {
        id: "uses-manual-workflow",
        passed:
          report.mode === "manual-workflow" &&
          tools.has("run_step") &&
          tools.has("choose_transition") &&
          !tools.has("run_pipeline") &&
          !tools.has("start_pipeline"),
      },
      { id: "reaches-approved", passed: report.approved === true },
    ],
    null,
    2,
  ),
);
