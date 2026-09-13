import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BackgroundRunError, BackgroundRunManager } from "../src/orchestration/background-runs";
import type { RunPipelineResult } from "../src/orchestration/orchestrator";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function completedResult(runId: string): RunPipelineResult {
  return {
    runId,
    result: {
      outcome: "approved",
      approved: true,
      rounds: 1,
      verdicts: [
        {
          status: "approved",
          summary: "accepted",
          issues: [],
        },
      ],
      runIds: ["planner", "coder", "reviewer"],
      stageMetrics: [],
    },
    perStep: [
      { phase: "plan", step: 1, cost: 0.25 },
      { phase: "code", step: 2, cost: 0.75 },
    ],
    totalCost: 1,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("background run returns immediately while foreground work remains available", async () => {
  const gate = deferred<RunPipelineResult>();
  let runId = "";
  const manager = new BackgroundRunManager(async (_task, id, control) => {
    runId = id;
    control.onStage({ phase: "plan", step: 1, cost: 0.25 });
    return gate.promise;
  });

  const started = manager.start("repair the project");
  expect(started.lifecycle).toBe("requested");
  expect(runId).toBe("");
  expect(manager.status(started.runId).runId).toBe(started.runId);

  const foregroundTurn = await Promise.resolve("foreground response");
  expect(foregroundTurn).toBe("foreground response");
  await settle();
  expect(manager.status(started.runId).lifecycle).toBe("started");
  expect(() => manager.result(started.runId)).toThrow(new BackgroundRunError("not_terminal"));

  gate.resolve(completedResult(started.runId));
  await settle();
  expect(runId).toBe(started.runId);
  await manager.close();
});

test("cursor reconnect is ordered, bounded, gap-aware, and content-free", async () => {
  const gate = deferred<RunPipelineResult>();
  const manager = new BackgroundRunManager(
    async (_task, runId, control) => {
      for (const phase of ["plan", "code", "review"] as const)
        control.onStage({ phase, step: 1, cost: 0.5 });
      return gate.promise.then(() => completedResult(runId));
    },
    { maxEventsPerRun: 4, maxPageSize: 2, maxPageBytes: 4_096 },
  );
  const { runId } = manager.start("SECRET TASK CONTENT");
  await settle();

  const first = manager.events(runId, 0, 20);
  expect(first.gap).toBe(true);
  expect(first.events).toHaveLength(2);
  const second = manager.events(runId, first.nextCursor, 20);
  expect(second.events.map(({ sequence }) => sequence)).toEqual(
    [...second.events.map(({ sequence }) => sequence)].sort((a, b) => a - b),
  );
  expect(second.events[0]?.sequence).toBe(first.nextCursor + 1);
  for (const event of [...first.events, ...second.events]) {
    expect(Object.keys(event).every((key) => EVENT_KEYS.has(key))).toBe(true);
    expect(JSON.stringify(event)).not.toContain("SECRET");
  }

  gate.resolve(completedResult(runId));
  await settle();
  const reconnect = manager.events(runId, second.nextCursor, 1);
  expect(reconnect.events).toHaveLength(1);
  expect(reconnect.events[0]?.lifecycle).toBe("completed");
  await manager.close();
});

const EVENT_KEYS = new Set<string>([
  "sequence",
  "runId",
  "lifecycle",
  "timestamp",
  "stage",
  "errorCode",
  "metrics",
]);

test("terminal result includes verdict and aggregate usage and survives owner reconnect", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-background-")));
  const ownerId = "conversation-a";
  const manager = new BackgroundRunManager(
    async (_task, runId, control) => {
      control.onStage({ phase: "plan", step: 1, cost: 1 });
      return completedResult(runId);
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("durable run");
  await settle();
  expect(manager.result(runId)).toMatchObject({
    runId,
    lifecycle: "completed",
    approved: true,
    rounds: 1,
    verdict: "approved",
    metrics: { steps: 2, totalCost: 1 },
  });
  await manager.close();

  const reconnected = new BackgroundRunManager(
    async () => {
      throw new Error("completed durable runs must not execute again");
    },
    {},
    targetDir,
    ownerId,
  );
  expect(reconnected.result(runId).verdict).toBe("approved");

  const otherSession = new BackgroundRunManager(
    async () => {
      throw new Error("not used");
    },
    {},
    targetDir,
    "conversation-b",
  );
  expect(() => otherSession.status(runId)).toThrow(new BackgroundRunError("not_found"));
  await reconnected.close();
  await otherSession.close();
});

test("default paging bounds a run with 503 events and rejects zero paging ceilings", async () => {
  expect(
    () => new BackgroundRunManager(async () => completedResult("unused"), { maxPageSize: 0 }),
  ).toThrow(new BackgroundRunError("invalid_request"));
  expect(
    () => new BackgroundRunManager(async () => completedResult("unused"), { maxPageBytes: 0 }),
  ).toThrow(new BackgroundRunError("invalid_request"));
  expect(
    () => new BackgroundRunManager(async () => completedResult("unused"), { leaseMs: 0 }),
  ).toThrow(new BackgroundRunError("invalid_request"));
  const manager = new BackgroundRunManager(
    async (_task, runId, control) => {
      for (let step = 1; step <= 503; step += 1) control.onStage({ phase: "code", step, cost: 0 });
      return completedResult(runId);
    },
    { maxEventsPerRun: 0 },
  );
  const { runId } = manager.start("bounded paging");
  await manager.wait(runId);
  const page = manager.events(runId, 0);
  expect(page.events).toHaveLength(32);
  expect(Buffer.byteLength(JSON.stringify(page.events))).toBeLessThanOrEqual(16 * 1024);
  await manager.close();
});

test("headless detached launch propagates limits and records safe spawn failure", async () => {
  let launch:
    | {
        runId: string;
        task: string;
        limits: Readonly<import("../src/orchestration/background-runs").BackgroundRunLimits>;
      }
    | undefined;
  const manager = new BackgroundRunManager(
    async () => completedResult("unused"),
    { maxPageSize: 7, maxPageBytes: 8192, maxActiveRuns: 3 },
    undefined,
    "headless-owner",
    (request) => {
      launch = request;
    },
  );
  const started = await manager.startDetached("headless task");
  expect(launch?.runId).toBe(started.runId);
  expect(launch?.task).toBe("headless task");
  expect(launch?.limits.maxPageSize).toBe(7);
  expect(launch?.limits.maxActiveRuns).toBe(3);
  await manager.close();

  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-launch-failure-")),
  );
  const failedManager = new BackgroundRunManager(
    async () => completedResult("unused"),
    {},
    targetDir,
    "failure-owner",
    async () => {
      throw new Error("SECRET task and provider details");
    },
  );
  let failure: BackgroundRunError | undefined;
  try {
    await failedManager.startDetached("SECRET task");
  } catch (error) {
    failure = error as BackgroundRunError;
  }
  expect(failure?.code).toBe("launch_failed");
  expect(failure?.message).toBe("launch_failed");
  const files = fs.readdirSync(path.join(targetDir, ".ad-coder", "runs", "background"));
  const record = fs.readFileSync(
    path.join(targetDir, ".ad-coder", "runs", "background", files[0]!),
    "utf8",
  );
  expect(record).not.toContain("SECRET");
  const stored = JSON.parse(record);
  expect((stored.value ?? stored).outcome.recovery).toBe("inspect_events");
  await failedManager.close();
});

test("durable claim admits exactly one worker across managers", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-claim-race-")));
  const ownerId = "race-owner";
  const starter = new BackgroundRunManager(
    async () => completedResult("unused"),
    {},
    targetDir,
    ownerId,
    () => undefined,
  );
  const requested = await starter.startDetached("race task");
  await starter.close(true);

  let executions = 0;
  const execute = async (_task: string, runId: string) => {
    executions += 1;
    return completedResult(runId);
  };
  const first = new BackgroundRunManager(execute, {}, targetDir, ownerId);
  const second = new BackgroundRunManager(execute, {}, targetDir, ownerId);

  first.claim(requested.runId, "race task");
  expect(() => second.claim(requested.runId, "race task")).toThrow(
    new BackgroundRunError("invalid_request"),
  );
  await first.wait(requested.runId);
  expect(executions).toBe(1);
  await first.close();
  await second.close();
});

test("zero disables active-run and event-retention limits", async () => {
  const manager = new BackgroundRunManager(
    async (_task, runId, control) => {
      control.onStage({ phase: "plan", step: 1, cost: 0 });
      control.onStage({ phase: "code", step: 2, cost: 0 });
      return completedResult(runId);
    },
    { maxActiveRuns: 0, maxEventsPerRun: 0 },
  );
  const first = manager.start("first");
  const second = manager.start("second");
  await manager.wait(first.runId);
  await manager.wait(second.runId);
  expect(manager.events(first.runId, 0, 100).events.length).toBe(5);
  await manager.close();
});

test("active-run admission rejects excess work and close is finite for a stuck worker", async () => {
  const never = new Promise<RunPipelineResult>(() => {});
  const manager = new BackgroundRunManager(async () => never, {
    maxActiveRuns: 1,
    closeDrainMs: 10,
  });
  const { runId } = manager.start("first");
  expect(() => manager.start("second")).toThrow(new BackgroundRunError("resource_limit"));

  const before = performance.now();
  await manager.close();
  expect(performance.now() - before).toBeLessThan(250);
  expect(manager.status(runId).lifecycle).toBe("cancelled");
  expect(manager.result(runId).lifecycle).toBe("cancelled");
  expect(() => manager.start("after close")).toThrow(new BackgroundRunError("closed"));
});
