import { expect, test } from "bun:test";
import {
  assertTurnFitsBudget,
  ContextBudgetError,
  ContextCompactor,
  createRoleRunner,
  defineTool,
  diffUsage,
  GateRunner,
  isWorkflowModule,
  Ledger,
  OrchestrationError,
  resolveTargetDir,
  runPipeline,
  runRole,
  RunnerError,
  SUMMARIZATION_PROMPT,
  UsageDeltaTracker,
} from "ad-coder";
import type {
  ContextBudget,
  GateReport,
  IssueSeverity,
  OrchestrationErrorCode,
  PipelineConfig,
  PipelineResult,
  QualityGate,
  RoleRunner,
  RoleSpec,
  RoundRecord,
  RunRoleOptions,
  RunRoleParams,
  RunRoleResult,
  Summarizer,
  Tool,
  Verdict,
  VerdictIssue,
  VerdictStatus,
  WorkflowModule,
} from "ad-coder";

// The README documents `from "ad-coder"` as the public surface, which only
// works while package.json's `exports` self-reference resolves. A type-only
// import would be erased before the resolver ever ran, so these are value
// imports and this call is what proves the module was really loaded.
test("the package is importable by its published name", () => {
  const workflow: WorkflowModule = {
    name: "self-import",
    async run() {
      return null;
    },
  };
  expect(isWorkflowModule(workflow)).toBe(true);
  expect(typeof diffUsage).toBe("function");
  expect(typeof UsageDeltaTracker).toBe("function");
  expect(typeof Ledger).toBe("function");
  expect(typeof ContextCompactor).toBe("function");
  expect(typeof ContextBudgetError).toBe("function");
  expect(typeof assertTurnFitsBudget).toBe("function");
  expect(typeof SUMMARIZATION_PROMPT).toBe("string");
  expect(typeof GateRunner).toBe("function");
  expect(typeof runRole).toBe("function");
  expect(typeof createRoleRunner).toBe("function");
  expect(typeof defineTool).toBe("function");
  expect(typeof RunnerError).toBe("function");
  expect(typeof resolveTargetDir).toBe("function");
  expect(typeof runPipeline).toBe("function");
  expect(typeof OrchestrationError).toBe("function");
  // Type-only imports are erased; reference them so the imports are not unused.
  const _budget: ContextBudget | undefined = undefined;
  const _summarizer: Summarizer | undefined = undefined;
  const _tool: Tool | undefined = undefined;
  const _gate: QualityGate | undefined = undefined;
  const _report: GateReport | undefined = undefined;
  const _params: RunRoleParams | undefined = undefined;
  const _result: RunRoleResult | undefined = undefined;
  const _opts: RunRoleOptions | undefined = undefined;
  const _runner: RoleRunner | undefined = undefined;
  const _verdict: Verdict | undefined = undefined;
  const _issue: VerdictIssue | undefined = undefined;
  const _status: VerdictStatus | undefined = undefined;
  const _severity: IssueSeverity | undefined = undefined;
  const _spec: RoleSpec | undefined = undefined;
  const _round: RoundRecord | undefined = undefined;
  const _pipelineConfig: PipelineConfig | undefined = undefined;
  const _pipelineResult: PipelineResult | undefined = undefined;
  const _orchCode: OrchestrationErrorCode | undefined = undefined;
  expect(_budget).toBeUndefined();
  expect(_summarizer).toBeUndefined();
  expect(_tool).toBeUndefined();
  expect(_gate).toBeUndefined();
  expect(_report).toBeUndefined();
  expect(_params).toBeUndefined();
  expect(_result).toBeUndefined();
  expect(_opts).toBeUndefined();
  expect(_runner).toBeUndefined();
  expect(_verdict).toBeUndefined();
  expect(_issue).toBeUndefined();
  expect(_status).toBeUndefined();
  expect(_severity).toBeUndefined();
  expect(_spec).toBeUndefined();
  expect(_round).toBeUndefined();
  expect(_pipelineConfig).toBeUndefined();
  expect(_pipelineResult).toBeUndefined();
  expect(_orchCode).toBeUndefined();
});

test("the published name resolves the same module as the relative path", async () => {
  const byName = await import("ad-coder");
  const byPath = await import("../src/index");
  expect(byName.isWorkflowModule).toBe(byPath.isWorkflowModule);
});
