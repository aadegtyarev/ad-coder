import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackgroundRunError,
  BackgroundRunManager,
  DEFAULT_BACKGROUND_RUN_LIMITS,
  MIN_BACKGROUND_EVENT_PAGE_BYTES,
  RESUME_PIPELINE_DETAIL,
  RESUME_PIPELINE_NO_RAISE_DETAIL,
} from "../src/orchestration/background-runs";
import type { RunPipelineResult } from "../src/orchestration/orchestrator";
import { PipelinePauseError } from "../src/orchestration/types";
import { ProjectStore } from "../src/project-store/project-store";
import type { VersionedState } from "../src/project-store/types";

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

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for background state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
  "pause",
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
  const reconnectedOutcome = reconnected.result(runId);
  if (reconnectedOutcome.lifecycle !== "completed") throw new Error("expected terminal outcome");
  expect(reconnectedOutcome.verdict).toBe("approved");

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
    () =>
      new BackgroundRunManager(async () => completedResult("unused"), {
        maxPageBytes: MIN_BACKGROUND_EVENT_PAGE_BYTES - 1,
      }),
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

test("subscriber queues isolate slow consumers, expose loss, and close without waiting", async () => {
  const release = deferred<void>();
  const received: import("../src/orchestration/background-runs").BackgroundRunNotice[] = [];
  const manager = new BackgroundRunManager(async (_task, runId) => completedResult(runId), {
    subscriberQueueCapacity: 1,
  });
  manager.subscribe(async (notice) => {
    received.push(notice);
    if (received.length === 1) await release.promise;
  });

  manager.start("first");
  await waitUntil(() => received.length === 1);
  const before = performance.now();
  manager.start("second");
  expect(performance.now() - before).toBeLessThan(50);
  await settle();
  expect(received).toHaveLength(1);

  release.resolve();
  await waitUntil(() => received.length === 2);
  expect(received[1]?.droppedEvents).toBeGreaterThan(0);
  expect(received[1]?.pending).toBe(true);

  const stuck = new BackgroundRunManager(async (_task, runId) => completedResult(runId));
  stuck.subscribe(async () => new Promise<void>(() => {}));
  stuck.start("stuck subscriber");
  await settle();
  const closeStarted = performance.now();
  await stuck.close();
  expect(performance.now() - closeStarted).toBeLessThan(50);
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

test("live owner refreshes detached worker state and emits bounded reconnect hints", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-live-owner-")));
  const ownerId = "live-owner";
  const limits = { maxEventsPerRun: 3, maxPageSize: 1, maxPageBytes: 4_096 };
  const owner = new BackgroundRunManager(
    async () => completedResult("unused"),
    limits,
    targetDir,
    ownerId,
    () => undefined,
  );
  const requested = await owner.startDetached("SECRET detached task");
  const notices: import("../src/orchestration/background-runs").BackgroundRunNotice[] = [];
  const unsubscribe = owner.subscribe((notice) => {
    notices.push(notice);
  });

  const worker = new BackgroundRunManager(
    async (_task, runId, control) => {
      for (let step = 1; step <= 6; step += 1) control.onStage({ phase: "code", step, cost: 0.25 });
      return completedResult(runId);
    },
    limits,
    targetDir,
    ownerId,
  );
  worker.claim(requested.runId, "SECRET detached task");
  await worker.wait(requested.runId);

  expect(owner.status(requested.runId)).toMatchObject({
    lifecycle: "completed",
    metrics: { steps: 2, totalCost: 1 },
  });
  await waitUntil(() => notices.length > 0);
  const notice = notices.at(-1)!;
  expect(notice.events).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(notice.events))).toBeLessThanOrEqual(limits.maxPageBytes);
  expect(notice.droppedEvents).toBeGreaterThan(0);
  expect(notice.gap).toBe(true);
  expect(notice.pending).toBe(true);
  expect(JSON.stringify(notice)).not.toContain("SECRET");

  const page = owner.events(requested.runId, notice.nextCursor);
  expect(page.events.length).toBeGreaterThan(0);
  expect(owner.result(requested.runId).lifecycle).toBe("completed");

  unsubscribe();
  const delivered = notices.length;
  const local = owner.start("another task");
  await owner.wait(local.runId);
  expect(notices).toHaveLength(delivered);

  const reconnect = new BackgroundRunManager(
    async () => completedResult("unused"),
    limits,
    targetDir,
    ownerId,
  );
  expect(reconnect.result(requested.runId).lifecycle).toBe("completed");
  expect(reconnect.events(requested.runId, 0).gap).toBe(true);
  await reconnect.close();
  await worker.close();
  await owner.close();
});

test("separate worker process refreshes owner subscription with bounded recovery hints", async () => {
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-worker-owner-")),
  );
  const ownerId = "separate-process-owner";
  const limits = { maxEventsPerRun: 3, maxPageSize: 1, maxPageBytes: 4_096 };
  const owner = new BackgroundRunManager(
    async () => completedResult("unused"),
    limits,
    targetDir,
    ownerId,
    () => undefined,
  );
  const requested = await owner.startDetached("SECRET separate-process task");
  const notices: import("../src/orchestration/background-runs").BackgroundRunNotice[] = [];
  const unsubscribe = owner.subscribe((notice) => {
    notices.push(notice);
  });
  const workerModule = new URL("../src/orchestration/background-runs.ts", import.meta.url).href;
  const workerSource = `
    import { BackgroundRunManager } from ${JSON.stringify(workerModule)};
    const manager = new BackgroundRunManager(async (_task, runId, control) => {
      for (let step = 1; step <= 6; step += 1)
        control.onStage({ phase: "code", step, cost: 0.25 });
      return {
        runId,
        result: { outcome: "approved", approved: true, rounds: 1, verdicts: [], runIds: [], stageMetrics: [] },
        perStep: [{ phase: "plan", step: 1, cost: 0.25 }, { phase: "code", step: 2, cost: 0.75 }],
        totalCost: 1,
      };
    }, ${JSON.stringify(limits)}, ${JSON.stringify(targetDir)}, ${JSON.stringify(ownerId)});
    manager.claim(${JSON.stringify(requested.runId)}, "worker task");
    await manager.wait(${JSON.stringify(requested.runId)});
    await manager.close();
  `;
  const worker = Bun.spawn([process.execPath, "-e", workerSource], {
    cwd: process.cwd(),
    stdout: "ignore",
    stderr: "pipe",
  });
  // Wait on the observable lag state rather than a fixed clock such as the old
  // 500 ms Atomics.pause: a slow worker leaves the record's first post-subscribe
  // watch refresh showing a pre-retention prefix — with the owner subscribed
  // while the record already holds the `requested` event, `owner.subscribe()`
  // seeds the subscriber cursor at entry.nextSequence - 1 = 1, and a gap page
  // requires the oldest retained sequence (nextSequence - maxEventsPerRun) to
  // exceed cursor + 1, which with maxEventsPerRun=3 first holds at
  // nextSequence >= 6 — so the pause must not end before that threshold or the
  // asserted page comes back contiguous (gap=false, droppedEvents=0) and the
  // test reddens on correct behaviour (issue #429, CI 35460853873). Here the
  // record has written more events than the retention cap retains (limit 3), so
  // every retained event's sequence exceeds the cursor by more than one → the
  // first watcher refresh is a gap page (droppedEvents>0, gap, pending) by
  // construction. The pause runs as scan/chunk/scan: each chunk blocks the
  // thread so no fs.watch callback of the owner can interleave a contiguous
  // page mid-write, while the recorded lag — not the clock — decides when the
  // pause ends, however fast or slow the worker is.
  const recordPath = path.join(
    targetDir,
    ".ad-coder",
    "runs",
    "background",
    `${requested.runId}.json`,
  );
  // record may be mid-atomic-write; unobservable lag is retried, never a fail.
  const splicedLag = (): number => {
    try {
      const stored = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      const nextSequence = (stored.value ?? stored).nextSequence;
      return typeof nextSequence === "number" ? nextSequence : 0;
    } catch {
      return 0;
    }
  };
  const holdDeadline = Date.now() + 2_000;
  // Cursor math: the subscribe-seeded cursor is entry.nextSequence - 1 = 1;
  // a gap page needs the oldest retained sequence to exceed cursor + 1, i.e.
  // nextSequence - maxEventsPerRun > cursor + 1 = 2, first true at
  // nextSequence >= maxEventsPerRun + 3 — hence the hold threshold + 2.
  while (splicedLag() <= limits.maxEventsPerRun + 2) {
    if (Date.now() >= holdDeadline) throw new Error("timed out waiting for background state");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  }
  expect(await worker.exited).toBe(0);
  await waitUntil(() => notices.length > 0, 2_000);

  const notice = notices[0]!;
  expect(notice.events).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(notice.events))).toBeLessThanOrEqual(limits.maxPageBytes);
  expect(notice.droppedEvents).toBeGreaterThan(0);
  expect(notice.gap).toBe(true);
  expect(notice.pending).toBe(true);
  expect(JSON.stringify(notice)).not.toContain("SECRET");
  expect(owner.status(requested.runId).lifecycle).toBe("completed");
  expect(owner.result(requested.runId).lifecycle).toBe("completed");
  expect(owner.events(requested.runId, notice.nextCursor).events.length).toBeGreaterThan(0);

  unsubscribe();
  const delivered = notices.length;
  const local = owner.start("local task");
  await owner.wait(local.runId);
  expect(notices).toHaveLength(delivered);

  const reconnect = new BackgroundRunManager(
    async () => completedResult("unused"),
    limits,
    targetDir,
    ownerId,
  );
  expect(reconnect.status(requested.runId).lifecycle).toBe("completed");
  expect(reconnect.events(requested.runId, 0).gap).toBe(true);
  expect(reconnect.result(requested.runId).lifecycle).toBe("completed");
  await reconnect.close();
  await owner.close();
});

test("subscription consumer and persisted-state failures are safe and typed", async () => {
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => logged.push(String(message));
  try {
    const manager = new BackgroundRunManager(async (_task, runId) => completedResult(runId));
    manager.subscribe(() => {
      throw new Error("SECRET subscriber failure");
    });
    const run = manager.start("SECRET task");
    await manager.wait(run.runId);
    expect(logged).toEqual(["ad-coder: background subscriber failed; subscription removed"]);
    expect(logged.join(" ")).not.toContain("SECRET");
    await manager.close();
  } finally {
    console.error = originalError;
  }

  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-bad-state-")));
  const owner = new BackgroundRunManager(
    async () => completedResult("unused"),
    {},
    targetDir,
    "bad-state-owner",
    () => undefined,
  );
  const requested = await owner.startDetached("task");
  const stateFile = path.join(
    targetDir,
    ".ad-coder",
    "runs",
    "background",
    `${requested.runId}.json`,
  );
  fs.writeFileSync(stateFile, "not json");
  expect(() => owner.status(requested.runId)).toThrow(
    new BackgroundRunError("state_unavailable", requested.runId),
  );
  await owner.close();
});

/**
 * The record invariant every reader of a run record depends on is
 * `isTerminal(lifecycle) === (outcome !== undefined)`. A record that breaks it
 * is not "partially written" to the readers: `load()` drops it silently and
 * answers `not_found`, and `refresh()` throws `state_unavailable` for the same
 * file -- so a run that breaks it is one a concurrent `background status`
 * reports as missing, exactly once, then reads fine on the retry.
 *
 * A writer that sets a TERMINAL lifecycle, publishes, and only then attaches
 * the outcome opens that window for the duration of one write. This asserts the
 * invariant at the publication seam (`ProjectStore.mutateVersionedJson`, the one
 * call that puts a record on disk), so it covers every writer on the failure
 * path rather than re-testing the one that regressed (issue #534).
 */
test("a published run record is never terminal without its outcome (issue #534)", async () => {
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-record-invariant-")),
  );
  const stateDir = path.join(targetDir, ".ad-coder", "runs", "background");
  const published: Array<{ lifecycle: string; hasOutcome: boolean }> = [];
  const original = ProjectStore.prototype.mutateVersionedJson;
  // The seam is generic over the stored value and this wrapper only reads two
  // fields of it, so it is written over `unknown` and cast back to the generic
  // signature it replaces; every caller keeps the original typing.
  ProjectStore.prototype.mutateVersionedJson = function (
    this: ProjectStore,
    destination: string,
    mutate: (current: VersionedState<unknown> | undefined) => unknown,
  ): VersionedState<unknown> {
    return original.call(this, destination, (current) => {
      const next = mutate(current);
      if (path.dirname(destination) === stateDir && next !== undefined && next !== null) {
        // `next` is the run record itself: `mutateVersionedJson` wraps it into
        // `{ version, value }` after this callback returns, so what is observed
        // here is exactly what the next reader will parse out of `value`.
        const record = next as { lifecycle?: unknown; outcome?: unknown };
        published.push({
          lifecycle: String(record.lifecycle),
          hasOutcome: record.outcome !== undefined,
        });
      }
      return next;
    });
  } as typeof ProjectStore.prototype.mutateVersionedJson;
  let manager: BackgroundRunManager | undefined;
  try {
    manager = new BackgroundRunManager(
      async () => {
        throw new Error("internal failure");
      },
      {},
      targetDir,
      "record-invariant-owner",
    );
    const run = manager.start("failing task");
    await manager.wait(run.runId);
  } finally {
    ProjectStore.prototype.mutateVersionedJson = original;
    await manager?.close();
  }
  const terminal = (lifecycle: string): boolean =>
    (["failed", "cancelled", "timed_out", "completed"] as readonly string[]).includes(lifecycle);
  // Not vacuous: the scenario really did publish the failing run's outcome.
  expect(
    published.filter((entry) => entry.lifecycle === "failed" && entry.hasOutcome).length,
  ).toBeGreaterThan(0);
  expect(published.filter((entry) => terminal(entry.lifecycle) !== entry.hasOutcome)).toEqual([]);
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

import * as crypto from "node:crypto";

test("a pause cause survives the registry round-trip and stays inside the page cap (issue #363)", async () => {
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-pause-cause-")),
  );
  const cause = {
    code: "diff_metric_failed",
    message: "git diff HEAD failed (128)",
    recurrence: 1,
  } as const;
  const manager = new BackgroundRunManager(
    async (_task, runId) => {
      throw new PipelinePauseError(
        runId,
        {
          phase: "code",
          code: "stage_failed",
          action:
            "the stage failed inside the harness (diff_metric_failed); resolve the recorded cause, then retry the stage explicitly",
          cause: { ...cause },
        },
        { steps: 2, totalCost: 0.01 },
      );
    },
    {},
    targetDir,
  );
  const { runId } = manager.start("harness cause");
  await manager.wait(runId);
  expect(manager.status(runId).pause?.cause).toEqual(cause);
  // The persisted event carries it too, and a fresh manager reading the same
  // record accepts the cause field (the schema was extended, not drifted).
  const persisted = JSON.parse(
    fs.readFileSync(
      path.join(targetDir, ".ad-coder", "runs", "background", `${runId}.json`),
      "utf8",
    ),
  ) as {
    value?: {
      events: { lifecycle: string; pause?: { cause?: unknown } }[];
    };
  };
  const persistedData =
    persisted.value ??
    (persisted as unknown as {
      events: { lifecycle: string; pause?: { cause?: unknown } }[];
    });
  const pausedEvent = persistedData.events.find((event) => event.lifecycle === "paused");
  expect(pausedEvent?.pause?.cause).toEqual(cause);
  // The page cap already covers the longest schema-valid event WITH a cause,
  // so a cause can never push a cursor past the byte ceiling: the minimum
  // still fits the DEFAULT page budget it protects.
  expect(MIN_BACKGROUND_EVENT_PAGE_BYTES).toBeLessThanOrEqual(
    DEFAULT_BACKGROUND_RUN_LIMITS.maxPageBytes,
  );
  const page = manager.events(runId, 0, 20);
  expect(page.events.some((event) => event.pause?.cause?.code === "diff_metric_failed")).toBe(true);
  await manager.close();
});

test("a stage pause is reported as paused with real metrics, the limit, and a recovery action (issue #261)", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-pause-")));
  const manager = new BackgroundRunManager(
    async (_task, runId, control) => {
      control.onStage({ phase: "plan", step: 1, cost: 0.0 });
      // The coordinator threw a stage-limit pause: no completed stage paid
      // onStage, so the pause itself must carry the real spend.
      throw new PipelinePauseError(
        runId,
        {
          phase: "plan",
          code: "stage_limit",
          action: "increase or disable the duration stage limit, then resume explicitly",
          limitReason: "duration",
          limit: 180000,
        },
        { steps: 1, totalCost: 0.0064 },
      );
    },
    {},
    targetDir,
  );
  const { runId } = manager.start("implement two coupled features");
  await manager.wait(runId);

  // A pause is not a failure: the lifecycle, recovery, and metrics all say so.
  const status = manager.status(runId);
  expect(status.lifecycle).toBe("paused");
  expect(status.recovery).toBe("resume_pipeline");
  expect(status.metrics).toEqual({ steps: 1, totalCost: 0.0064 });
  expect(status.pause).toMatchObject({
    phase: "plan",
    code: "stage_limit",
    limitReason: "duration",
    limit: 180000,
  });

  // The pause reaches the event stream like any other stage outcome, with the
  // coordinator's own words intact (a paragraph, not five commands).
  const page = manager.events(runId, 0, 20);
  const paused = page.events.find((event) => event.lifecycle === "paused");
  expect(paused?.stage).toBe("plan");
  expect(paused?.pause?.action).toBe(
    "increase or disable the duration stage limit, then resume explicitly",
  );

  // The same surface a completed run reports: a pause is readable there too.
  const outcome = manager.result(runId);
  expect(outcome.lifecycle).toBe("paused");
  expect(outcome.metrics).toEqual({ steps: 1, totalCost: 0.0064 });
  await manager.close();
});

test("a durable pause survives a worker exit as a resumable record, not an abandonment", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-pause-")));
  const ownerId = crypto.randomUUID();
  const manager = new BackgroundRunManager(
    async (_task, runId) => {
      throw new PipelinePauseError(
        runId,
        {
          phase: "plan",
          code: "stage_limit",
          action: "increase or disable the cost stage limit, then resume explicitly",
          limitReason: "cost",
          limit: 0.1,
        },
        { steps: 1, totalCost: 0.1 },
      );
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("pause durably");
  await settle();
  await manager.wait(runId);
  // The worker's promise has settled and the lease is gone; the durable record
  // must still read as the pause the coordinator recorded.
  const reconnected = new BackgroundRunManager(
    async () => {
      throw new Error("paused runs must not execute again on reconnect");
    },
    {},
    targetDir,
    ownerId,
  );
  expect(reconnected.status(runId).lifecycle).toBe("paused");
  expect(reconnected.status(runId).pause?.limitReason).toBe("cost");
  const outcome = reconnected.result(runId);
  if (outcome.lifecycle !== "paused") throw new Error("expected paused outcome");
  expect(outcome.metrics).toEqual({ steps: 1, totalCost: 0.1 });
  await reconnected.close();
  await manager.close();
});

test("a paused run names a recovery the operator can actually perform", () => {
  // The status said `recovery: resume_pipeline` and nothing else, but
  // `background` has no resume action and `control resume` reads a
  // differently-named record, so the only working route is the orchestrator's
  // tool through a console (issue #310). An instruction that does not work is
  // worse than none: it is followed first and doubted later.
  const detail = RESUME_PIPELINE_DETAIL;
  expect(detail).toContain("console");
  expect(detail).toContain("resume_pipeline");
  // It must say why the obvious commands are not the answer, or the reader
  // tries them first -- which is exactly what happened when this was found.
  expect(detail).toContain("background` has no resume action");
  expect(detail).toContain("control resume` does not read background runs");
});

test("projectForegroundPause only touches entries this manager holds (issue #363)", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-projection-")));
  const ownerId = crypto.randomUUID();
  const manager = new BackgroundRunManager(
    async (_task, runId) => completedResult(runId),
    {},
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("owned run");
  await manager.wait(runId);
  expect(manager.status(runId).lifecycle).toBe("completed");

  // A runId this manager never held is skipped silently -- no throw, no entry.
  manager.projectForegroundPause(
    "never-started-here",
    { phase: "plan", code: "stage_failed", action: "resume the stage explicitly" },
    { steps: 0, totalCost: 0 },
  );
  expect(manager.status(runId).lifecycle).toBe("completed");

  // A held run that re-paused in the foreground becomes the pause the
  // checkpoint now carries: the registry never contradicts the checkpoint.
  manager.projectForegroundPause(
    runId,
    {
      phase: "code",
      code: "stage_failed",
      action: "the stage failed inside the harness (empty_turn); resolve the recorded cause",
      cause: { code: "empty_turn", message: "empty turn", recurrence: 1 },
    },
    { steps: 2, totalCost: 0.5 },
  );
  const status = manager.status(runId);
  expect(status.lifecycle).toBe("paused");
  expect(status.pause?.code).toBe("stage_failed");
  expect(status.pause?.cause?.recurrence).toBe(1);
  expect(status.metrics).toEqual({ steps: 2, totalCost: 0.5 });
  // The persisted record re-parses (a paused entry carries no terminal
  // outcome) and a fresh manager reads the projected pause.
  const reconnected = new BackgroundRunManager(
    async () => completedResult(runId),
    {},
    targetDir,
    ownerId,
  );
  expect(reconnected.status(runId).pause?.cause?.code).toBe("empty_turn");
  await reconnected.close();
  await manager.close();
});

test("a non-ceiling resumable pause reports recovery without the ceiling raise wording", async () => {
  // The raise wording was written for the stage-ceiling class, but the
  // coordinator pauses on more classes than that: a run paused
  // `plan_not_submitted` (issue #315's resumable class) needs an explicit
  // resume act and OUGHT to resume with its original task -- no ceiling raise
  // is needed, and the raise wording sends the operator hunting for raise
  // parameters the fix never uses. The ceiling wording stays for the ceiling
  // codes, and the plain route wording stays for the pause-less paths
  // (timed_out, abandoned).
  const start = async (code: string, extra = {}) => {
    const execute = async (_task: string, runId: string) => {
      throw new PipelinePauseError(
        runId,
        {
          phase: "plan",
          code,
          action: "resume the plan explicitly",
          ...extra,
        },
        { steps: 1, totalCost: 0.02 },
      );
    };
    const manager = new BackgroundRunManager(execute, {});
    const { runId } = manager.start("resume detail");
    await waitUntil(() => manager.status(runId).lifecycle === "paused");
    const status = manager.status(runId);
    await manager.close();
    return status;
  };

  // A plan_not_submitted pause resumes with the original task: no raise needed.
  const planPaused = await start("plan_not_submitted");
  expect(planPaused.recovery).toBe("resume_pipeline");
  expect(planPaused.recoveryDetail).toBe(RESUME_PIPELINE_NO_RAISE_DETAIL);
  expect(planPaused.recoveryDetail).not.toContain("raising the exhausted ceiling");

  // A ceiling pause keeps the raise wording verbatim.
  const limited = await start("stage_limit", { limitReason: "cost", limit: 0.1 });
  expect(limited.recoveryDetail).toBe(RESUME_PIPELINE_DETAIL);
  expect(limited.recoveryDetail).toContain("raising the exhausted ceiling");
  const failed = await start("stage_failed");
  expect(failed.recoveryDetail).toBe(RESUME_PIPELINE_DETAIL);
});

function backgroundRecord(targetDir: string, runId: string): { value?: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(backgroundFile(targetDir, runId), "utf8")) as {
    value?: Record<string, unknown>;
  };
}

function backgroundFile(targetDir: string, runId: string): string {
  return path.join(targetDir, ".ad-coder", "runs", "background", `${runId}.json`);
}

test("a timed-out run's recorded outcome survives the durable round-trip (issue #430)", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-roundtrip-")));
  const ownerId = crypto.randomUUID();
  const manager = new BackgroundRunManager(
    () => new Promise<RunPipelineResult>(() => {}),
    { maxRunMs: 30, closeDrainMs: 0 },
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("times out");
  await waitUntil(() => manager.status(runId).lifecycle === "timed_out", 2000);
  // The writer side: timeout() stores its recovery instruction in the record.
  const written = (backgroundRecord(targetDir, runId).value?.outcome ?? {}) as {
    recoveryDetail?: string;
  };
  expect(written.recoveryDetail).toBe(RESUME_PIPELINE_DETAIL);
  await manager.close();

  // The reader side: a fresh owner-scoped session reads the SAME record the
  // SAME code wrote. Before the fix, parseOutcome rejected its own
  // `recoveryDetail` field: refresh threw `state_unavailable` unhandled
  // through pendingWakes(), and load silently dropped the whole record.
  const reconnected = new BackgroundRunManager(
    async () => {
      throw new Error("terminally timed-out runs must not execute again");
    },
    {},
    targetDir,
    ownerId,
  );
  const status = reconnected.status(runId);
  expect(status.lifecycle).toBe("timed_out");
  const outcome = reconnected.result(runId);
  if (outcome.lifecycle !== "timed_out") throw new Error("expected timed-out outcome");
  expect(outcome.recoveryDetail).toBe(RESUME_PIPELINE_DETAIL);
  expect(outcome.recovery).toBe("resume_pipeline");
  // The pump path: pendingWakes() returns the run's notice instead of throwing.
  const pending = reconnected.pendingWakes();
  expect(pending.some((w) => w.runId === runId && w.kind === "timed_out")).toBe(true);
  await reconnected.close();
});

test("a cancel of a paused run round-trips its pause through the terminal outcome (issue #430)", async () => {
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-roundtrip-pause-")),
  );
  const ownerId = crypto.randomUUID();
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
        { steps: 1, totalCost: 0.02 },
      );
    },
    {},
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("paused then cancelled");
  await manager.wait(runId);
  const cancelled = manager.cancel(runId);
  expect(cancelled.lifecycle).toBe("cancelled");
  // The writer side: the terminal outcome carries the run's pause.
  const written = (backgroundRecord(targetDir, runId).value?.outcome ?? {}) as {
    lifecycle?: string;
    pause?: { code?: string };
  };
  expect(written.lifecycle).toBe("cancelled");
  expect(written.pause?.code).toBe("stage_limit");
  await manager.close();

  const reconnected = new BackgroundRunManager(
    async () => {
      throw new Error("cancelled runs must not execute again");
    },
    {},
    targetDir,
    ownerId,
  );
  const outcome = reconnected.result(runId);
  if (outcome.lifecycle !== "cancelled") throw new Error("expected cancelled outcome");
  expect(outcome.pause?.code).toBe("stage_limit");
  // The previously write-only `pause` outcome field no longer makes the
  // strict parser reject the code's own record.
  expect(() => reconnected.pendingWakes()).not.toThrow();
  await reconnected.close();
});

test("an abandoned interrupted run reloads with the recovery detail and stays wakeable (issue #430)", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-abandoned-")));
  const ownerId = crypto.randomUUID();
  const manager = new BackgroundRunManager(
    () => new Promise<RunPipelineResult>(() => {}),
    { leaseMs: 60_000, closeDrainMs: 0 },
    targetDir,
    ownerId,
  );
  const { runId } = manager.start("vanishes mid-run");
  await waitUntil(() => manager.status(runId).lifecycle === "started", 2000);
  await manager.close(true);

  // The abandoned durable record: an interrupted lifecycle whose lease has
  // expired because its worker is dead. The surviving manager's lease timer is
  // not reliably stopped this fast, so strip the lease from the file the way a
  // dead worker's stale record reads.
  const record = backgroundRecord(targetDir, runId);
  const value = record.value;
  if (value === undefined) throw new Error("expected a wrapped durable record");
  delete value.lease;
  fs.writeFileSync(backgroundFile(targetDir, runId), JSON.stringify(record), { mode: 0o600 });

  const reconnected = new BackgroundRunManager(
    async () => {
      throw new Error("abandoned runs must not execute again");
    },
    { leaseMs: 60_000 },
    targetDir,
    ownerId,
  );
  const outcome = reconnected.result(runId);
  if (outcome.lifecycle !== "failed") throw new Error("expected failed outcome");
  expect(outcome.recoveryDetail).toBe(RESUME_PIPELINE_DETAIL);
  expect(outcome.recovery).toBe("resume_pipeline");
  await reconnected.close();
});

test("a foreign outcome field still fails the strict reader; pendingWakes skips it with one bounded line (issue #430)", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-foreign-")));
  const ownerId = "foreign-field-owner";
  const manager = new BackgroundRunManager(
    async (_task, runId, control) => {
      control.onStage({ phase: "plan", step: 1, cost: 1 });
      return completedResult(runId);
    },
    {},
    targetDir,
    ownerId,
    () => undefined,
  );
  const requested = await manager.startDetached("SECRET foreign-field task");
  // A live worker finishes the detached record, so the owner holds the entry
  // and the outcome is durable.
  const worker = new BackgroundRunManager(
    async (_task, runId) => completedResult(runId),
    {},
    targetDir,
    ownerId,
  );
  worker.claim(requested.runId, "SECRET foreign-field task");
  await worker.wait(requested.runId);
  expect(manager.status(requested.runId).lifecycle).toBe("completed");

  // A field no writer of this version emits: a newer or drifted writer.
  // Strict stays strict for fields nobody here writes -- learning the code's
  // own fields must never decay into ignoring everything.
  const record = backgroundRecord(targetDir, requested.runId);
  if (record.value === undefined || record.value.outcome === undefined)
    throw new Error("expected a durable terminal outcome");
  (record.value.outcome as Record<string, unknown>).spoiler = 1;
  fs.writeFileSync(backgroundFile(targetDir, requested.runId), JSON.stringify(record), {
    mode: 0o600,
  });

  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    // Explicit caller paths keep the typed, strict failure (refresh rejects it).
    expect(() => manager.status(requested.runId)).toThrow(
      new BackgroundRunError("state_unavailable", requested.runId),
    );
    expect(() => manager.result(requested.runId)).toThrow(
      new BackgroundRunError("state_unavailable", requested.runId),
    );
    // The wake drain path does not: the unreadable record is skipped with one
    // bounded, identifier-only stderr line -- names and counts, never content.
    const pending = manager.pendingWakes();
    expect(pending.some((w) => w.runId === requested.runId)).toBe(true);
    expect(logged).toHaveLength(1);
    const line = logged.join(" ");
    expect(line).toContain("state_unavailable");
    expect(line).toContain(requested.runId);
    expect(line).not.toContain("SECRET");
    // And a fresh session documents the load path: the record is dropped
    // silently from the registry rather than crashing the construction.
    const reconnected = new BackgroundRunManager(
      async () => {
        throw new Error("not used");
      },
      {},
      targetDir,
      ownerId,
    );
    expect(() => reconnected.status(requested.runId)).toThrow(new BackgroundRunError("not_found"));
    await reconnected.close();
  } finally {
    console.error = originalError;
  }
  await worker.close();
  await manager.close();
});

test("one unreadable record does not kill the pendingWakes of the others (issue #430)", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-drain-skip-")));
  const ownerId = "drain-skip-owner";
  // Two durable unhandled pauses...
  const makePauseManager = () =>
    new BackgroundRunManager(
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
      { sameTargetPolicy: "allow" },
      targetDir,
      ownerId,
    );
  const manager = makePauseManager();
  const first = manager.start("drains first");
  const second = manager.start("drains second");
  await manager.wait(first.runId);
  await manager.wait(second.runId);
  expect(manager.pendingWakes().length).toBe(2);

  // ...and one of their records becomes unreadable to the strict parser.
  const record = backgroundRecord(targetDir, first.runId);
  if (record.value === undefined) throw new Error("expected a durable record");
  (record.value as Record<string, unknown>).spoilerField = 1;
  fs.writeFileSync(backgroundFile(targetDir, first.runId), JSON.stringify(record), {
    mode: 0o600,
  });

  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    // pendingWakes() skips the unreadable record (one bounded line, no
    // content) and still returns the WHOLE wake set, so a broken state file
    // can never hollow out the drain of everything this owner knows.
    const pending = manager.pendingWakes();
    expect(pending).toHaveLength(2);
    expect(pending.map((w) => w.runId).sort()).toEqual([first.runId, second.runId].sort());
    expect(logged).toHaveLength(1);
    const line = logged.join(" ");
    expect(line).toContain("state_unavailable");
    expect(line).toContain(first.runId);
    expect(line).not.toContain("SECRET");
    // Explicit reader paths on the broken record keep the typed refusal.
    expect(() => manager.status(first.runId)).toThrow(
      new BackgroundRunError("state_unavailable", first.runId),
    );
  } finally {
    console.error = originalError;
  }
  await manager.close();
});
