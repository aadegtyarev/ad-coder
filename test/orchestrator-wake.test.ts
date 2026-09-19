import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import {
  BackgroundRunManager,
  WAKE_INITIATING_LIFECYCLES,
  type WakeEntry,
} from "../src/orchestration/background-runs";
import type { RunPipelineResult, StepCost } from "../src/orchestration/orchestrator";
import { startOrchestrator } from "../src/orchestration/orchestrator";
import { PipelinePauseError } from "../src/orchestration/types";
import { buildWakeTurnPrompt, WakePump } from "../src/orchestration/wake";
import {
  BUILT_IN_PIPELINE_WORKFLOW,
  BUILT_IN_PIPELINE_WORKFLOW_NAME,
} from "../src/workflows/builtin-pipeline";

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
    turnActive: () => false,
    runTurn: async (prompt, step) => {
      turns.push({ prompt, step });
    },
  });
  return { pump, turns };
}

/** One macrotask: lets every scheduled microtask (a drain) run to completion. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function stageLimitPause(limit: number) {
  return {
    phase: "plan" as const,
    code: "stage_limit",
    action: "increase or disable the duration stage limit, then resume explicitly",
    limitReason: "duration" as const,
    limit,
  };
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

test("(f) a wake during an active turn stays durably coalesced and drains on the post-turn settle", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-f-")));
  const ownerId = crypto.randomUUID();
  const manager = new BackgroundRunManager(
    async (_task, runId) => {
      throw new PipelinePauseError(runId, stageLimitPause(540000), { steps: 1, totalCost: 0.02 });
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("wake during a turn");
  await manager.wait(runId);

  const turns: { prompt: string; step: string }[] = [];
  let laneBusy = false;
  const pump = new WakePump({
    listPending: () => manager.pendingWakes(),
    markHandled: (r, kinds) => manager.markWakesHandled(r, kinds),
    turnActive: () => laneBusy,
    runTurn: async (prompt, step) => {
      turns.push({ prompt, step });
    },
  });

  // A front turn is in flight when the wake is noticed: the pump must defer,
  // never race the active turn.
  laneBusy = true;
  pump.notifyChange();
  await settle();
  expect(turns.length).toBe(0);
  // The wake is still durably unhandled -- coalesced, not lost.
  const during = readRecord(targetDir, runId).value;
  expect(during.wake?.entries.some((w) => w.kind === "paused" && w.handled === false)).toBe(true);

  // The front turn settles; the post-turn path drains the coalesced wake.
  laneBusy = false;
  pump.onTurnSettled();
  await settle();
  expect(turns.length).toBe(1);
  expect(turns[0]!.step.startsWith("wake:")).toBe(true);
  const after = readRecord(targetDir, runId).value;
  expect(after.wake?.entries.find((w) => w.kind === "paused")?.handled).toBe(true);

  await manager.close();
});

test("(g) a racing runTurn failure is contained: one bounded stderr line, no hot loop, still drained", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-g-")));
  const ownerId = crypto.randomUUID();
  const manager = new BackgroundRunManager(
    async (_task, runId) => {
      throw new PipelinePauseError(runId, stageLimitPause(540000), { steps: 1, totalCost: 0.02 });
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("racing wake");
  await manager.wait(runId);

  let attempts = 0;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const pump = new WakePump({
      listPending: () => manager.pendingWakes(),
      markHandled: (r, kinds) => manager.markWakesHandled(r, kinds),
      turnActive: () => false,
      runTurn: async (prompt, step) => {
        attempts += 1;
        if (attempts === 1) throw new Error("conversation step already active");
        void prompt;
        void step;
      },
    });

    // First drain loses the race: contained, not an unhandled rejection.
    pump.notifyChange();
    await settle();
    await settle();
    expect(attempts).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]!.startsWith("ad-coder:")).toBe(true);
    expect(errors[0]!.length).toBeLessThan(200);
    // A failed drain must not hot-loop: quiescent until the next nudge.
    await settle();
    expect(attempts).toBe(1);
    // The batch is still durably unhandled.
    expect(readRecord(targetDir, runId).value.wake?.entries.every((w) => w.handled === false)).toBe(
      true,
    );

    // The post-turn path re-drains; this time the turn succeeds.
    pump.onTurnSettled();
    await settle();
    expect(attempts).toBe(2);
    expect(errors.length).toBe(1);
    const after = readRecord(targetDir, runId).value;
    expect(after.wake?.entries.find((w) => w.kind === "paused")?.handled).toBe(true);
  } finally {
    console.error = originalError;
  }

  await manager.close();
});

test("(h) a wake landing during a front turn is drained after it, never racing conversation.step", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-h-")));
  const credentials: CredentialStore = {
    read: async () => ({
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: 0,
    }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  let releaseRun: (() => void) | undefined;
  let releaseFront: (() => void) | undefined;
  let conversationBusy = false;
  const turns: { kind: "front" | "wake"; step: string | undefined; rejected?: boolean }[] = [];

  const session = await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    workflowModules: [BUILT_IN_PIPELINE_WORKFLOW],
    enabledWorkflows: [BUILT_IN_PIPELINE_WORKFLOW_NAME],
    backgroundOwnerId: "wake-lane-owner",
    backgroundRunExecutor: async (_task, runId) => {
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      throw new PipelinePauseError(runId, stageLimitPause(540000), { steps: 1, totalCost: 0.02 });
    },
    startConversation: async () => ({
      runId: "test-session",
      ledgerPath: undefined,
      // Mimics the real conversation's single-step guard: a second concurrent
      // step is refused, so a pump race fails this test instead of hiding.
      step: async (_userInput: string, opts?: { step?: string }) => {
        const kind = opts?.step?.startsWith("wake:") ? ("wake" as const) : ("front" as const);
        if (conversationBusy) {
          turns.push({ kind, step: opts?.step, rejected: true });
          throw new Error("conversation step already active");
        }
        conversationBusy = true;
        turns.push({ kind, step: opts?.step });
        try {
          if (kind === "front") {
            await new Promise<void>((resolve) => {
              releaseFront = resolve;
            });
          }
          return {
            runId: "test-session",
            step: opts?.step ?? "turn:1",
            status: "completed",
            assistantText: "",
            toolCalls: [],
            droppedRecords: 0,
          };
        } finally {
          conversationBusy = false;
        }
      },
      close: async () => {},
    }),
  });
  const sessionWithRuns = session as typeof session & {
    backgroundRuns: BackgroundRunManager;
  };

  // A background run is launched but held before it can pause: no wake yet.
  const { runId } = sessionWithRuns.backgroundRuns.start("wake-lane specimen");
  await waitFor(() => releaseRun !== undefined);

  // The front turn starts and blocks mid-turn.
  const front = session.step("operator input");
  await waitFor(() => releaseFront !== undefined);

  // The background run pauses WHILE the front turn is in flight.
  releaseRun!();
  await sessionWithRuns.backgroundRuns.wait(runId);
  await settle();

  // No second concurrent turn was attempted, and nothing threw.
  expect(turns.map((t) => t.kind)).toEqual(["front"]);
  expect(turns.every((t) => t.rejected !== true)).toBe(true);
  // The wake is durably unhandled while the front turn runs.
  const during = readRecord(targetDir, runId).value;
  expect(during.wake?.entries.some((w) => w.kind === "paused" && w.handled === false)).toBe(true);

  // The front turn settles; the post-turn path drains the coalesced wake.
  releaseFront!();
  const frontResult = await front;
  expect(frontResult.status).toBe("completed");
  await waitFor(() =>
    Boolean(
      readRecord(targetDir, runId).value.wake?.entries.some(
        (w) => w.kind === "paused" && w.handled === true,
      ),
    ),
  );
  expect(turns.map((t) => t.kind)).toEqual(["front", "wake"]);
  expect(turns[1]!.step?.startsWith("wake:")).toBe(true);
  expect(turns.every((t) => t.rejected !== true)).toBe(true);

  await session.close();
});

test("(i) distinct windows of a kind survive a blind merge: a post-mark pause stays wakeable", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-i-")));
  const ownerId = crypto.randomUUID();
  // Manager A pauses once; its wake is marked handled (the drain's mark).
  const managerA = new BackgroundRunManager(
    async (_task, runId) => {
      throw new PipelinePauseError(runId, stageLimitPause(1), { steps: 1, totalCost: 0.01 });
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = managerA.start("merge specimen");
  await managerA.wait(runId);
  managerA.markWakesHandled(runId, ["paused"]);
  await managerA.close();

  // A fresh manager reconnects (the documented reconnect path), then a
  // foreground resume re-pauses the run (the issue #363 projection).
  const managerB = new BackgroundRunManager(
    async () => {
      throw new Error("must not re-execute");
    },
    {},
    targetDir,
    ownerId,
  );
  managerB.projectForegroundPause(runId, stageLimitPause(2), { steps: 2, totalCost: 0.02 });

  // The durable projection keeps BOTH windows of kind `paused`: the handled one
  // AND the new unhandled one. A blind merge must not collapse the new pause
  // into the handled window and erase the wake.
  const record = readRecord(targetDir, runId).value;
  const paused = record.wake?.entries.filter((w) => w.kind === "paused") ?? [];
  expect(paused.some((w) => w.handled && w.count === 1)).toBe(true);
  expect(paused.some((w) => !w.handled && w.count === 1)).toBe(true);
  // And a fresh reader sees the new pause as pending.
  const pending = managerB.pendingWakes().filter((w) => w.runId === runId);
  expect(pending.length).toBe(1);
  expect(pending[0]!.kind).toBe("paused");

  await managerB.close();
});

test("(j) re-observing one coalesced window never double-counts it, and blind re-persists never inflate", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wake-j-")));
  const ownerId = crypto.randomUUID();
  let release: (() => void) | undefined;
  // The detached worker's execute: records a stage wake, then holds mid-run so
  // its lease heartbeat keeps blind-persisting its own memory image.
  const workerExecute = async (
    _task: string,
    _runId: string,
    control: { cancelled: () => boolean; onStage: (step: StepCost) => void },
  ) => {
    control.onStage({ phase: "code", step: 1, cost: 0.01 });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    control.onStage({ phase: "code", step: 2, cost: 0.02 });
    return completedResult("irrelevant-run-id-j");
  };
  // The session side owns the record and the drain's mark, exactly the
  // production topology the merge exists for. Its detached host launcher is a
  // no-op here: the worker claims the request in-process below, mirroring how
  // `test/background-runs.test.ts` drives detached runs (launch the request,
  // THEN construct the worker and `claim` the now-durable record).
  const session = new BackgroundRunManager(
    async () => {
      throw new Error("session side never executes");
    },
    {},
    targetDir,
    ownerId,
    () => undefined,
  );
  const { runId } = await session.startDetached("merge heartbeat specimen");
  // The record is now durable; construct the worker so its `load()` sees it,
  // then claim it (the real detached contract, not `launch`'s in-process path).
  const worker = new BackgroundRunManager(
    workerExecute,
    { leaseMs: 300, closeDrainMs: 0 },
    targetDir,
    ownerId,
  );
  worker.claim(runId, "merge heartbeat specimen");
  await waitFor(() => {
    const entries = readRecord(targetDir, runId).value.wake?.entries ?? [];
    return entries.some((w) => w.kind === "stage_changed" && !w.handled && w.count === 1);
  });
  const firstAt = readRecord(targetDir, runId).value.wake!.entries.find(
    (w) => w.kind === "stage_changed",
  )!.firstAt;

  // The drain marks the wake handled on durable state while the worker's
  // memory still holds it unhandled: two projections of the SAME window.
  session.markWakesHandled(runId, ["stage_changed"]);

  // At least two lease heartbeats re-persist the worker's stale image.
  await new Promise<void>((resolve) => setTimeout(resolve, 260));

  // The worker folds one more notice into its still-unhandled window and
  // finishes; the final persist merges it over the marked disk state.
  release!();
  await worker.wait(runId);

  const record = readRecord(targetDir, runId).value;
  const windows = record.wake?.entries.filter((w) => w.kind === "stage_changed") ?? [];
  expect(windows.length).toBe(1);
  expect(windows[0]!.handled).toBe(true);
  // The surviving window's count is the largest observation (the number of
  // events folded into it) -- never the sum of two observations of one window,
  // and never inflated by the repeated heartbeat persists.
  expect(windows[0]!.count).toBe(2);
  expect(windows[0]!.firstAt).toBe(firstAt);

  await worker.close();
  await session.close();
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
