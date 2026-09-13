import { describe, expect, test } from "bun:test";
import { compareCalibrationRuns, scoreCalibrationRun } from "../src/evaluation/calibration";
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

function row(cost: number): LedgerRecord {
  return {
    ts: 1,
    runId: "run",
    lane: "main",
    role: "reviewer",
    step: "review",
    provider: "test",
    model: "model-a",
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
    });
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
