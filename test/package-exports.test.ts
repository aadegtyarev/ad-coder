import { expect, test } from "bun:test";
import {
  assertTurnFitsBudget,
  ContextBudgetError,
  ContextCompactor,
  diffUsage,
  GateRunner,
  isWorkflowModule,
  Ledger,
  SUMMARIZATION_PROMPT,
  UsageDeltaTracker,
} from "ad-coder";
import type {
  ContextBudget,
  GateReport,
  QualityGate,
  Summarizer,
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
  // Type-only imports are erased; reference them so the imports are not unused.
  const _budget: ContextBudget | undefined = undefined;
  const _summarizer: Summarizer | undefined = undefined;
  const _gate: QualityGate | undefined = undefined;
  const _report: GateReport | undefined = undefined;
  expect(_budget).toBeUndefined();
  expect(_summarizer).toBeUndefined();
  expect(_gate).toBeUndefined();
  expect(_report).toBeUndefined();
});

test("the published name resolves the same module as the relative path", async () => {
  const byName = await import("ad-coder");
  const byPath = await import("../src/index");
  expect(byName.isWorkflowModule).toBe(byPath.isWorkflowModule);
});
