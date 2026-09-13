import * as fs from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("usage: orchestrator-tool-use <report.json>");
const report = JSON.parse(fs.readFileSync(file, "utf8")) as {
  predictedComplexity?: string;
  plannerComplexity?: string;
  mode?: string;
  approved?: boolean;
  tools?: string[];
};
const tools = new Set(report.tools ?? []);
console.log(
  JSON.stringify(
    [
      { id: "classifies-complex", passed: report.predictedComplexity === "complex" },
      {
        id: "planner-cross-check",
        passed: report.plannerComplexity === "complex" && tools.has("run_role:planner"),
      },
      {
        id: "uses-manual-workflow",
        passed:
          report.mode === "manual-workflow" &&
          tools.has("run_step") &&
          tools.has("choose_transition") &&
          !tools.has("run_pipeline"),
      },
      { id: "reaches-approved", passed: report.approved === true },
    ],
    null,
    2,
  ),
);
