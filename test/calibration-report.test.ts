import { describe, expect, test } from "bun:test";
import { buildOrchestratorReport, extractJsonArtifact, statedTier } from "../evals/runner/report";
import type { LedgerRecord } from "../src/ledger/types";

function row(role: string, step: string): LedgerRecord {
  return {
    ts: 1,
    runId: "run",
    lane: "main",
    role,
    step,
    provider: "test",
    model: "m",
    stopReason: "stop",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("orchestrator run report", () => {
  test("credits a classification only when nothing delegating ran first", () => {
    const early = buildOrchestratorReport({
      taskId: "t",
      turns: [{ assistantText: "evidence...\nCOMPLEXITY: complex" }],
      ledger: [],
    });
    expect(early).toMatchObject({
      predictedComplexity: "complex",
      predictedBeforeDelegation: true,
    });

    const late = buildOrchestratorReport({
      taskId: "t",
      turns: [
        {
          assistantText: "COMPLEXITY: complex",
          toolCalls: [{ toolName: "run_role" }],
        },
      ],
      ledger: [],
    });
    expect(late).toMatchObject({
      predictedComplexity: "complex",
      predictedBeforeDelegation: false,
    });
  });

  test("proves planner delegation from the ledger, not from the tool name", () => {
    // The console projection carries tool NAMES only, so `run_role` alone can
    // never say WHICH role was delegated; the ledger step does.
    const turns = [{ assistantText: "", toolCalls: [{ toolName: "run_role" }] }];
    expect(buildOrchestratorReport({ taskId: "t", turns, ledger: [] }).plannerDelegated).toBe(
      false,
    );
    expect(
      buildOrchestratorReport({
        taskId: "t",
        turns,
        ledger: [row("planner", "role:planner")],
      }).plannerDelegated,
    ).toBe(true);
  });

  test("derives the mode from the tools called, not from what the task declared", () => {
    const manual = buildOrchestratorReport({
      taskId: "t",
      turns: [{ toolCalls: [{ toolName: "run_step" }, { toolName: "choose_transition" }] }],
      ledger: [],
    });
    expect(manual.mode).toBe("manual-workflow");
    const automatic = buildOrchestratorReport({
      taskId: "t",
      turns: [{ toolCalls: [{ toolName: "run_step" }, { toolName: "run_pipeline" }] }],
      ledger: [],
    });
    expect(automatic.mode).toBe("automatic-pipeline");
  });

  test("takes the planner tier and approval from the workflow checkpoint", () => {
    const report = buildOrchestratorReport({
      taskId: "t",
      turns: [{ assistantText: "PLANNER_COMPLEXITY: medium" }],
      ledger: [row("reviewer", "review")],
      workflowState: { complexity: "complex", approved: true },
    });
    expect(report).toMatchObject({
      plannerComplexity: "complex",
      approved: true,
      roles: ["reviewer"],
    });
  });

  test("falls back to the relayed tier only when no checkpoint carries one", () => {
    const report = buildOrchestratorReport({
      taskId: "t",
      turns: [{ assistantText: "PLANNER_COMPLEXITY: medium" }],
      ledger: [],
    });
    expect(report.plannerComplexity).toBe("medium");
    expect(report.approved).toBe(false);
  });

  test("ignores a tier mentioned in prose", () => {
    expect(statedTier("this looks COMPLEXITY: complex to me", "COMPLEXITY")).toBeNull();
    expect(statedTier("COMPLEXITY: enormous", "COMPLEXITY")).toBeNull();
    expect(statedTier("COMPLEXITY: Complex", "COMPLEXITY")).toBe("complex");
  });

  test("extracts a fenced JSON artifact out of surrounding prose", () => {
    const stdout =
      'Here you go:\n```json\n[{"code":"a","note":"}] not the end"}]\n```\ncost: $0.10\n';
    expect(JSON.parse(extractJsonArtifact(stdout))).toEqual([
      { code: "a", note: "}] not the end" },
    ]);
    expect(() => extractJsonArtifact("no json here")).toThrow(/no JSON artifact/);
    expect(() => extractJsonArtifact('[{"a":1}')).toThrow(/unterminated/);
  });
});
