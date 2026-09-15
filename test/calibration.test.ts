import { describe, expect, test } from "bun:test";
import {
  compareCalibrationRuns,
  measuredRolesOf,
  scoreCalibrationRun,
} from "../src/evaluation/calibration";
import type { LedgerRecord } from "../src/ledger/types";

const task = {
  id: "review-v1",
  role: "reviewer",
  complexity: "medium" as const,
  mode: "role" as const,
  prompt: "review",
  checks: [
    { id: "defect", weight: 3 },
    { id: "precision", weight: 1 },
  ],
};

function row(cost: number, role = "reviewer", model = "model-a"): LedgerRecord {
  return {
    ts: 1,
    runId: "run",
    lane: "main",
    role,
    step: role === "reviewer" ? "review" : `role:${role}`,
    provider: "test",
    model,
    stopReason: "stop",
    usage: {
      input: 100,
      output: 10,
      cacheRead: 20,
      cacheWrite: 0,
      reasoning: 3,
      totalTokens: 130,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    toolCalls: { read_project_file: 2 },
  };
}

describe("model calibration", () => {
  test("scores quality and aggregates real ledger usage", () => {
    const result = scoreCalibrationRun({
      task,
      checks: [
        { id: "defect", passed: true },
        { id: "precision", passed: false },
      ],
      ledger: [row(0.25), row(0.25)],
      inventory: "codex",
      thinkingLevel: "low",
      durationMs: 1500,
    });
    expect(result).toMatchObject({
      accepted: false,
      quality: 0.75,
      modelTurns: 2,
      toolTurns: 4,
      inputTokens: 200,
      costUsd: 0.5,
      costEfficiency: 1.5,
      model: "model-a",
      orchestratorComplexity: null,
      plannerComplexity: null,
      complexityCorrect: null,
      plannerAgreement: null,
    });
  });

  test("scores orchestrator complexity and planner feedback independently", () => {
    const result = scoreCalibrationRun({
      task,
      checks: task.checks.map(({ id }) => ({ id, passed: true })),
      ledger: [row(0.1)],
      inventory: "codex",
      thinkingLevel: "low",
      durationMs: 100,
      orchestratorComplexity: "trivial",
      plannerComplexity: "medium",
    });
    expect(result).toMatchObject({ complexityCorrect: false, plannerAgreement: false });
  });

  test("ranks accepted runs by cost then duration", () => {
    const common = {
      task,
      checks: task.checks.map(({ id }) => ({ id, passed: true })),
      inventory: "codex",
      thinkingLevel: "low",
    };
    const cheap = scoreCalibrationRun({ ...common, ledger: [row(0.1)], durationMs: 2000 });
    const costly = scoreCalibrationRun({ ...common, ledger: [row(0.2)], durationMs: 100 });
    expect(compareCalibrationRuns([costly, cheap])[0]).toBe(cheap);
  });

  test("attributes every (role, model) pair and names the declared role's model", () => {
    // A multi-role run: the FIRST turn is a delegated planner on a different
    // model, which is exactly the row the old `ledger[0].model` reported as the
    // model under test.
    const result = scoreCalibrationRun({
      task,
      checks: task.checks.map(({ id }) => ({ id, passed: true })),
      ledger: [row(0.4, "planner", "model-planner"), row(0.1), row(0.1)],
      inventory: "codex",
      thinkingLevel: "low",
      durationMs: 100,
    });
    expect(result.model).toBe("model-a");
    expect(result.models).toEqual([
      {
        role: "planner",
        provider: "test",
        model: "model-planner",
        modelTurns: 1,
        inputTokens: 100,
        outputTokens: 10,
        costUsd: 0.4,
      },
      {
        role: "reviewer",
        provider: "test",
        model: "model-a",
        modelTurns: 2,
        inputTokens: 200,
        outputTokens: 20,
        costUsd: 0.2,
      },
    ]);
  });

  test("names no model when the declared role never ran", () => {
    const result = scoreCalibrationRun({
      task,
      checks: task.checks.map(({ id }) => ({ id, passed: true })),
      ledger: [row(0.4, "planner", "model-planner")],
      inventory: "codex",
      thinkingLevel: "low",
      durationMs: 100,
    });
    expect(result.model).toBeNull();
  });

  test("attributes a pipeline task whose role no ledger row carries", () => {
    // A pipeline task's `role` is the dispatch label "pipeline" -- the ledger
    // only ever carries the workers that took the turns. Before `measuredRoles`
    // this reported `model: null` for every automatic-pipeline run, silently,
    // which is the one mode multi-role attribution exists for.
    const pipelineTask = {
      ...task,
      id: "pipeline-repair-v1",
      role: "pipeline",
      mode: "automatic-pipeline" as const,
      measuredRoles: ["coder"],
    };
    const result = scoreCalibrationRun({
      task: pipelineTask,
      checks: pipelineTask.checks.map(({ id }) => ({ id, passed: true })),
      ledger: [
        row(0.4, "planner", "model-planner"),
        row(0.1, "coder", "model-coder"),
        row(0.1, "coder", "model-coder"),
        row(0.05, "reviewer", "model-reviewer"),
      ],
      inventory: "codex",
      thinkingLevel: "low",
      durationMs: 100,
    });
    expect(result.model).toBe("model-coder");
    expect(result.models.map((share) => share.role)).toEqual(["planner", "coder", "reviewer"]);
  });

  test("measuredRolesOf falls back to the task role and rejects an empty list", () => {
    expect(measuredRolesOf(task)).toEqual(["reviewer"]);
    expect(measuredRolesOf({ ...task, measuredRoles: ["coder", "reviewer"] })).toEqual([
      "coder",
      "reviewer",
    ]);
    expect(() => measuredRolesOf({ ...task, measuredRoles: [] })).toThrow("invalid measuredRoles");
    expect(() => measuredRolesOf({ ...task, measuredRoles: [" "] })).toThrow(
      "invalid measuredRoles",
    );
  });

  test("rejects unknown checks", () => {
    expect(() =>
      scoreCalibrationRun({
        task,
        checks: [{ id: "invented", passed: true }],
        ledger: [],
        inventory: "codex",
        thinkingLevel: "low",
        durationMs: 1,
      }),
    ).toThrow("unknown or duplicate checks");
  });
});

test("a measurement names the provider that served the model, not just the model", () => {
  // The same model name behind two providers is not the same thing to run
  // against: quantization, context ceiling and supported thinking levels all
  // differ, and `docs/provider-catalogs.md` records `deepseek-v4-pro` accepting
  // `low` on opencode-go while openrouter marks it unsupported. These
  // measurements are meant to be published, so a reader who carries a score to
  // another host has to be able to see that it was measured somewhere else.
  const reviewerTask = { ...task, role: "reviewer" };
  const result = scoreCalibrationRun({
    task: reviewerTask,
    checks: reviewerTask.checks.map(({ id }) => ({ id, passed: true })),
    ledger: [row(0.2, "reviewer", "shared-name")],
    inventory: "inv",
    thinkingLevel: "low",
    durationMs: 10,
  });
  expect(result.provider).toBe("test");
  expect(result.models[0]?.provider).toBe("test");
});

test("the same model name on two providers stays two rows", () => {
  // Aggregation keys on (role, provider, model). Keyed on the name alone, a
  // sweep that compared one model across two hosts would silently sum them into
  // a single row -- the exact comparison the provider field exists to make
  // possible.
  const reviewerTask = { ...task, role: "reviewer" };
  const here = row(0.2, "reviewer", "shared-name");
  const there = { ...row(0.3, "reviewer", "shared-name"), provider: "elsewhere" };
  const result = scoreCalibrationRun({
    task: reviewerTask,
    checks: reviewerTask.checks.map(({ id }) => ({ id, passed: true })),
    ledger: [here, there],
    inventory: "inv",
    thinkingLevel: "low",
    durationMs: 10,
  });
  expect(result.models).toHaveLength(2);
  expect(result.models.map((share) => share.provider).sort()).toEqual(["elsewhere", "test"]);
});

test("a run reports what happened to it, not only how good the answer was", () => {
  // A `quality: 0` from a wrong answer and a `quality: 0` from a tool that
  // refused are different facts, and one number cannot separate them. The second
  // is evidence about the harness; treated as the first, it is recorded as the
  // model being worse than it is.
  const clean = scoreCalibrationRun({
    task,
    checks: task.checks.map(({ id }) => ({ id, passed: true })),
    ledger: [row(0.2)],
    inventory: "inv",
    thinkingLevel: "low",
    durationMs: 10,
  });
  expect(clean.harnessOutcome).toBe("clean");

  const errored = scoreCalibrationRun({
    task,
    checks: task.checks.map(({ id }) => ({ id, passed: false })),
    ledger: [{ ...row(0.2), stopReason: "error" }],
    inventory: "inv",
    thinkingLevel: "low",
    durationMs: 10,
  });
  expect(errored.harnessOutcome).toBe("provider_error");

  // The scorer knows an unreadable answer; the ledger cannot, so the runner
  // states it and the stated value wins over anything derived.
  const unreadable = scoreCalibrationRun({
    task,
    checks: task.checks.map(({ id }) => ({ id, passed: false })),
    ledger: [row(0.2)],
    inventory: "inv",
    thinkingLevel: "low",
    durationMs: 10,
    harnessOutcome: "unreadable_answer",
  });
  expect(unreadable.harnessOutcome).toBe("unreadable_answer");
  expect(unreadable.quality).toBe(0);
});
