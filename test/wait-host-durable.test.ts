import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BackgroundRunManager } from "../src/orchestration/background-runs";
import { WaitHost } from "../src/orchestration/wait-host";
import type { WaitSourceAdapter } from "../src/orchestration/wait-service";
import { WaitService } from "../src/orchestration/wait-service";
import { ProjectStore } from "../src/project-store/project-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wait-host-"));
  roots.push(created);
  return created;
}

function adapter(): WaitSourceAdapter {
  return {
    id: "fixture",
    version: 1,
    validate() {},
    reconcile: () => ({ lifecycle: "satisfied", evidence: "condition_met" }),
  };
}

function waitInput(owner: { kind: "run" | "session" | "operator"; id: string }) {
  return {
    source: { adapter: "fixture", version: 1, target: { kind: "fixture", id: "external_one" } },
    condition: { kind: "complete" },
    owner,
    policy: { delivery: "events" as const },
    recovery: "inspect" as const,
  };
}

test("Restart with real ProjectStore+WaitService+BackgroundRunManager proves terminal-before-wake and handled/unhandled exactly-once", async () => {
  const target = root();
  const AWAIT = 1_000;
  const ownerId = "wait-host-restart";
  // Instance 1: create the run anchor and the terminal wait without any wake
  // recording, simulating a crash after the terminal transition committed but
  // before the host projected its wake.
  const runs1 = new BackgroundRunManager(
    async (runId) => ({ runId, result: {} }) as never,
    { closeDrainMs: 1 },
    target,
    ownerId,
  );
  const { runId } = runs1.start("anchor the owning run");
  const service1 = new WaitService(new ProjectStore(target), [adapter()], {}, () => AWAIT);
  const wait = service1.create(waitInput({ kind: "run", id: runId }));
  await service1.reconcile(wait.id);
  // The terminal transition is durable on disk before anything projects a wake.
  expect(service1.get(wait.id).lifecycle).toBe("satisfied");
  await runs1.wait(runId);
  await runs1.close(true);

  // Restart 2: a fresh manager over the same target reads only persisted state
  // and the wake is projected exactly once from the durable terminal record.
  const notifications = [0, 0, 0];
  const runs2 = new BackgroundRunManager(
    async () => ({}) as never,
    { closeDrainMs: 1 },
    target,
    ownerId,
  );
  const service2 = new WaitService(new ProjectStore(target), [adapter()], {}, () => AWAIT);
  const host2 = new WaitHost(
    service2,
    runs2,
    { notifyChange: () => (notifications[0] = (notifications[0] ?? 0) + 1) },
    {
      cadenceMs: 60_000,
      maxWaitsPerScan: 4,
    },
  );
  expect(await host2.scan()).toEqual({ checked: 1, terminal: 1, skipped: 0, errors: 0 });
  const wakesAfterProjection = runs2.pendingWakes().filter((wake) => wake.runId === runId);
  // The real manager fixture also has its native failed wake at the run's
  // lifecycle timestamp. Isolate the wait-derived identity without masking
  // that pre-existing window or any additional wait-derived window.
  expect(wakesAfterProjection).toHaveLength(2);
  expect(wakesAfterProjection.filter((wake) => wake.kind === "failed")).toHaveLength(1);
  expect(
    wakesAfterProjection.filter((wake) => wake.kind === "completed" && wake.firstAt === AWAIT),
  ).toEqual([
    {
      runId,
      kind: "completed",
      firstAt: AWAIT,
      lastAt: AWAIT,
      count: 1,
      handled: false,
      metrics: { steps: 0, totalCost: 0 },
    },
  ]);

  // Exactly-once against the durable path: another restart re-derives the same
  // (kind, terminal timestamp) and must not duplicate the unhandled window.
  const runs3 = new BackgroundRunManager(
    async () => ({}) as never,
    { closeDrainMs: 1 },
    target,
    ownerId,
  );
  const service3 = new WaitService(new ProjectStore(target), [adapter()], {}, () => AWAIT);
  const host3 = new WaitHost(
    service3,
    runs3,
    { notifyChange: () => (notifications[1] = (notifications[1] ?? 0) + 1) },
    {
      cadenceMs: 60_000,
    },
  );
  expect(await host3.scan()).toEqual({ checked: 1, terminal: 0, skipped: 0, errors: 0 });
  const wakesAfterRestart = runs3.pendingWakes().filter((wake) => wake.runId === runId);
  expect(wakesAfterRestart).toHaveLength(2);
  expect(
    wakesAfterRestart.filter((wake) => wake.kind === "completed" && wake.firstAt === AWAIT),
  ).toHaveLength(1);

  // Handled exactly-once: the durable handled checkpoint survives a restart,
  // and the handled window does not reappear as unhandled.
  runs3.markWakesHandled(runId, ["completed"]);
  const wakesAfterHandling = runs3.pendingWakes().filter((wake) => wake.runId === runId);
  expect(wakesAfterHandling).toHaveLength(1);
  expect(wakesAfterHandling[0]?.kind).toBe("failed");
  const runs4 = new BackgroundRunManager(
    async () => ({}) as never,
    { closeDrainMs: 1 },
    target,
    ownerId,
  );
  const wakesAfterHandledRestart = runs4.pendingWakes().filter((wake) => wake.runId === runId);
  expect(wakesAfterHandledRestart).toHaveLength(1);
  expect(wakesAfterHandledRestart[0]?.kind).toBe("failed");
  await Promise.all([runs2.close(), runs3.close(), runs4.close()]);
});

test("Durable cancellation wait projects the operator_attention wake exactly once", async () => {
  const target = root();
  const ownerId = "wait-host-cancel";
  const runs1 = new BackgroundRunManager(
    async (runId) => ({ runId, result: {} }) as never,
    { closeDrainMs: 1 },
    target,
    ownerId,
  );
  const { runId } = runs1.start("anchor the owning run");
  const service1 = new WaitService(new ProjectStore(target), [adapter()], {}, () => 1_000);
  const wait = service1.create(waitInput({ kind: "run", id: runId }));
  service1.cancel(wait.id);
  await runs1.close().catch(() => {});

  const runs2 = new BackgroundRunManager(
    async () => ({}) as never,
    { closeDrainMs: 1 },
    target,
    ownerId,
  );
  const service2 = new WaitService(new ProjectStore(target), [adapter()], {}, () => 1_000);
  const host = new WaitHost(service2, runs2, { notifyChange: () => {} }, { cadenceMs: 60_000 });
  expect(await host.scan()).toEqual({ checked: 1, terminal: 1, skipped: 0, errors: 0 });
  const wakes = runs2
    .pendingWakes()
    .filter((wake) => wake.runId === runId && wake.kind === "operator_attention");
  expect(wakes).toHaveLength(1);
  // No terminal event preceded the wake with any other lifecycle: the durable
  // record is cancelled at its terminal timestamp and the window keys on it.
  const record = service2.get(wait.id);
  expect(record.lifecycle).toBe("cancelled");
  expect(wakes[0]?.firstAt).toBe(record.updatedAt);
  // Exactly-once: a restart re-scan does not duplicate the cancelled wake.
  const runs3 = new BackgroundRunManager(
    async () => ({}) as never,
    { closeDrainMs: 1 },
    target,
    ownerId,
  );
  const service3 = new WaitService(new ProjectStore(target), [adapter()], {}, () => 1_000);
  const host3 = new WaitHost(service3, runs3, { notifyChange: () => {} }, { cadenceMs: 60_000 });
  expect(await host3.scan()).toEqual({ checked: 1, terminal: 0, skipped: 0, errors: 0 });
  await Promise.all([runs2.close(), runs3.close()]);
});

test("Non-run owners are durably reconciled and skipped without errors", async () => {
  const target = root();
  const service1 = new WaitService(new ProjectStore(target), [adapter()], {}, () => 1_000);
  const wait = service1.create(waitInput({ kind: "session", id: "sess-1" }));
  await service1.reconcile(wait.id);

  const runs = new BackgroundRunManager(async () => ({}) as never, { closeDrainMs: 1 }, target);
  const service2 = new WaitService(new ProjectStore(target), [adapter()], {}, () => 1_000);
  const host = new WaitHost(service2, runs, { notifyChange: () => {} }, { cadenceMs: 60_000 });
  const first = await host.scan();
  const second = await host.scan();
  expect(first).toEqual({ checked: 1, terminal: 0, skipped: 1, errors: 0 });
  expect(second).toEqual(first);
  expect(runs.pendingWakes()).toHaveLength(0);
  await runs.close();
});
