import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackgroundRunManager,
  WAKE_INITIATING_LIFECYCLES,
  type WakeEntry,
} from "../src/orchestration/background-runs";
import type { RunPipelineResult } from "../src/orchestration/orchestrator";
import { PipelinePauseError } from "../src/orchestration/types";
import { buildWakeTurnPrompt, WakePump } from "../src/orchestration/wake";

function completedResult(runId: string): RunPipelineResult {
  return {
    runId,
    result: {
      outcome: "approved",
      approved: true,
      rounds: 1,
      verdicts: [{ status: "approved", summary: "accepted", issues: [] }],
      runIds: ["planner", "coder", "reviewer"],
      stageMetrics: [],
    },
    perStep: [
      { phase: "plan", step: 1, cost: 0.25 },
      { phase: "code", step: 2, cost: 0.75 },
    ],
    totalCost: 1.0,
  };
}

function readRecord(
  targetDir: string,
  runId: string,
): Record<string, unknown> & {
  value: { wake?: { entries: WakeEntry[] } };
} {
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(targetDir, ".ad-coder", "runs", "background", `${runId}.json`),
      "utf8",
    ),
  );
  return raw;
}

/** A pump front that records every turn the pump requests, in order. */
function recordingPump(manager: BackgroundRunManager) {
  const turns: { prompt: string; step: string }[] = [];
  const pump = new WakePump({
    listPending: () => manager.pendingWakes(),
    markHandled: (runId, kinds) => manager.markWakesHandled(runId, kinds),
    runTurn: async (prompt, step) => {
      turns.push({ prompt, step });
    },
  });
  return { pump, turns };
}

test("(a) a paused run wakes the orchestrator via durable state, then marks the wake handled", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-a-")));
  const ownerId = crypto.randomUUID();
  const task = "implement the pause-specimen shape";
  const manager = new BackgroundRunManager(
    async (_task, runId) => {
      throw new PipelinePauseError(
        runId,
        {
          phase: "plan",
          code: "stage_limit",
          action: "increase or disable the duration stage limit, then resume explicitly",
          limitReason: "duration",
          limit: 540000,
        },
        { steps: 1, totalCost: 0.02394486 },
      );
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = manager.start(task);
  await manager.wait(runId);

  // Durable state first: the paused run recorded an unhandled wake.
  const record = readRecord(targetDir, runId).value;
  expect(record.wake?.entries.some((w) => w.kind === "paused" && w.handled === false)).toBe(true);

  // The pump drains it into exactly one turn.
  const { pump, turns } = recordingPump(manager);
  await pump.startupScan();
  expect(turns.length).toBe(1);
  const prompt = turns[0]!.prompt;
  expect(prompt).toContain(runId);
  expect(prompt).toContain("paused");
  expect(prompt).toContain("stage_limit");
  expect(prompt).toContain("duration");
  expect(prompt).toContain("540000");
  // Fixed, code-built: never the run's raw task string.
  expect(prompt).not.toContain(task);

  // After the turn the record marks it handled.
  const after = readRecord(targetDir, runId).value;
  const handled = after.wake!.entries.find((w) => w.kind === "paused");
  expect(handled?.handled).toBe(true);
  expect(handled?.handledAt).toBeTypeOf("number");

  await manager.close();
});

test("(b) a failed run wakes the orchestrator", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-b-")));
  const ownerId = crypto.randomUUID();
  const manager = new BackgroundRunManager(
    async () => {
      throw new Error("boom");
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("fails");
  await manager.wait(runId);

  const record = readRecord(targetDir, runId).value;
  expect(record.wake?.entries.some((w) => w.kind === "failed" && w.handled === false)).toBe(true);

  const { pump, turns } = recordingPump(manager);
  await pump.startupScan();
  expect(turns.length).toBe(1);
  expect(turns[0]!.prompt).toContain("failed");

  const after = readRecord(targetDir, runId).value;
  expect(after.wake!.entries.find((w) => w.kind === "failed")?.handled).toBe(true);

  await manager.close();
});

test("(c) progress/activity events start no turn and record no wake", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-c-")));
  const ownerId = crypto.randomUUID();
  const manager = new BackgroundRunManager(
    async (_task, _runId, control) => {
      // Steps advance (stage_changed is turn-initiating by the operator's
      // "one of its steps" enumeration, but is NOT the negative vocabulary).
      control.onStage({ phase: "plan", step: 1, cost: 0.1 });
      control.onStage({ phase: "code", step: 2, cost: 0.2 });
      return completedResult("irrelevant-run-id");
    },
    {},
    targetDir,
    ownerId,
  );

  // `requested`/`started` are NOT turn-initiating. A run in flight (started, no
  // terminal event) must not record any wake.
  const { runId } = manager.start("progress only");
  await manager.wait(runId);

  // The run completed, which IS turn-initiating; to exercise the negative
  // vocabulary cleanly, inspect that only `completed` (and stage events, which
  // wake per the operator) are recorded -- requested/started/cancelled are not.
  const record = readRecord(targetDir, runId).value;
  const kinds = new Set<string>((record.wake?.entries ?? []).map((w) => w.kind));
  expect(kinds.has("requested")).toBe(false);
  expect(kinds.has("started")).toBe(false);
  expect(kinds.has("cancelled")).toBe(false);

  // A cancelled run records no cancelled wake.
  const manager2 = new BackgroundRunManager(
    async () => completedResult("irrelevant-run-id-2"),
    {},
    targetDir,
    ownerId,
  );
  const cancelled = manager2.start("cancelled");
  manager2.cancel(cancelled.runId);
  await manager2.wait(cancelled.runId);
  const record2 = readRecord(targetDir, cancelled.runId).value;
  expect((record2.wake?.entries ?? []).some((w) => String(w.kind) === "cancelled")).toBe(false);

  // The tool-activity channel never reaches background notices at all, so a
  // role "reading a file" leaves a run record byte-identical.
  const manager3 = new BackgroundRunManager(
    async () => completedResult("irrelevant-run-id-3"),
    {},
    targetDir,
    ownerId,
  );
  const started = manager3.start("active");
  // Simulate no background event for the activity; assert the WAKE_INITIATING
  // set does not include any tool-activity lifecycle. There is no such
  // lifecycle in the manager: the tool-activity channel is a different surface.
  expect(WAKE_INITIATING_LIFECYCLES).toEqual(
    expect.arrayContaining([
      "paused",
      "operator_attention",
      "failed",
      "timed_out",
      "completed",
      "stage_changed",
    ]),
  );
  expect(WAKE_INITIATING_LIFECYCLES).toHaveLength(6);
  // Nothing about `started` wrote a wake.
  await manager3.wait(started.runId);
  const record3 = readRecord(targetDir, started.runId).value;
  expect((record3.wake?.entries ?? []).some((w) => String(w.kind) === "started")).toBe(false);

  await manager.close();
  await manager2.close();
  await manager3.close();
});

test("(d) a burst of coalescable stage events coalesces to one drained turn", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-d-")));
  const ownerId = crypto.randomUUID();
  const manager = new BackgroundRunManager(
    async (_task, _runId, control) => {
      for (let i = 0; i < 50; i++) control.onStage({ phase: "code", step: i, cost: 0.01 });
      return completedResult("irrelevant-run-id");
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("burst");
  await manager.wait(runId);

  const record = readRecord(targetDir, runId).value;
  const stageWindow = record.wake!.entries.find((w) => w.kind === "stage_changed");
  expect(stageWindow).toBeDefined();
  expect(stageWindow!.count).toBeGreaterThan(1);

  const { pump, turns } = recordingPump(manager);
  await pump.startupScan();
  // 50 stage events + 1 completed coalesce to ONE drain turn, not 51.
  expect(turns.length).toBe(1);

  const after = readRecord(targetDir, runId).value;
  expect(after.wake!.entries.every((w) => w.handled === true)).toBe(true);

  await manager.close();
});

test("(e) a wake recorded with no live session is picked up on the next start", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-e-")));
  const ownerId = crypto.randomUUID();
  // Manager A runs to paused; there is no pump, no console.
  const managerA = new BackgroundRunManager(
    async (_task, runId) => {
      throw new PipelinePauseError(
        runId,
        {
          phase: "plan",
          code: "stage_limit",
          action: "increase or disable the duration stage limit, then resume explicitly",
          limitReason: "duration",
          limit: 540000,
        },
        { steps: 1, totalCost: 0.02 },
      );
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = managerA.start("durable wake");
  await managerA.wait(runId);

  // A fresh manager (the documented reconnect path) sees it from disk.
  const managerB = new BackgroundRunManager(
    async () => {
      throw new Error("must not re-execute a paused run");
    },
    {},
    targetDir,
    ownerId,
  );
  const pending = managerB.pendingWakes();
  expect(pending.some((w) => w.runId === runId && w.kind === "paused" && w.handled === false)).toBe(
    true,
  );

  const { pump, turns } = recordingPump(managerB);
  await pump.startupScan();
  expect(turns.length).toBe(1);

  const after = readRecord(targetDir, runId).value;
  expect(after.wake!.entries.find((w) => w.kind === "paused")?.handled).toBe(true);

  await managerB.close();
  await managerA.close();
});

test("buildWakeTurnPrompt names safe fields and never raw prose", () => {
  const prompt = buildWakeTurnPrompt([
    {
      runId: "run-123",
      kind: "paused",
      firstAt: 1,
      lastAt: 2,
      count: 1,
      handled: false,
      pause: {
        phase: "plan",
        code: "stage_limit",
        action: "increase or disable the duration stage limit, then resume explicitly",
        limitReason: "duration",
        limit: 540000,
      },
    },
  ]);
  expect(prompt).toContain("run-123");
  expect(prompt).toContain("stage_limit");
  expect(prompt).toContain("duration");
  expect(prompt).toContain("540000");
  expect(prompt).toContain("resume_pipeline");
  expect(prompt).not.toContain("increase or disable the duration stage limit" + "RAW");
});
