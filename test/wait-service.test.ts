import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProjectStore, WaitService, WaitServiceError, type WaitSourceAdapter } from "../src";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function store(): ProjectStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-wait-"));
  roots.push(root);
  return new ProjectStore(root);
}
function sourceAdapter(reconcile: WaitSourceAdapter["reconcile"]): WaitSourceAdapter {
  return {
    id: "fixture",
    version: 1,
    validate(target, condition) {
      if (target.kind !== "fixture" || condition.kind !== "complete") throw new Error("invalid");
    },
    reconcile,
  };
}
function input(id = "wait_one") {
  return {
    id,
    source: { adapter: "fixture", version: 1, target: { kind: "fixture", id: "external_one" } },
    condition: { kind: "complete" },
    owner: { kind: "run" as const, id: "run_one" },
    policy: { delivery: "events" as const },
    recovery: "inspect" as const,
  };
}

test("durable lifecycle publishes ordered versioned events and safe bounded evidence", async () => {
  let now = 100;
  const durable = store();
  const service = new WaitService(
    durable,
    [sourceAdapter(() => ({ lifecycle: "satisfied", evidence: "condition_met" }))],
    { maxEventsPerWait: 2, maxEvidenceEntries: 1 },
    () => now,
  );
  expect(service.create(input()).lifecycle).toBe("pending");
  now = 125;
  expect((await service.reconcile("wait_one")).lifecycle).toBe("satisfied");
  expect(service.events("wait_one")).toEqual({
    events: [
      { version: 1, sequence: 1, waitId: "wait_one", lifecycle: "pending", timestamp: 100 },
      {
        version: 1,
        sequence: 2,
        waitId: "wait_one",
        lifecycle: "satisfied",
        timestamp: 125,
        evidence: { code: "condition_met", at: 125 },
      },
    ],
    nextCursor: 2,
    gap: false,
  });
  const bytes = fs.readFileSync(durable.waitStatePath("wait_one"), "utf8");
  expect(bytes).not.toContain("external payload");
});

test("reopen and terminal reconcile are idempotent", async () => {
  const durable = store();
  let calls = 0;
  const adapter = sourceAdapter(() => {
    calls += 1;
    return { lifecycle: "satisfied", evidence: "condition_met" };
  });
  const first = new WaitService(durable, [adapter]);
  first.create(input());
  await first.reconcile("wait_one");
  const reopened = new WaitService(durable, [adapter]);
  expect(reopened.reopen("wait_one").lifecycle).toBe("satisfied");
  await reopened.reconcile("wait_one");
  expect(calls).toBe(1);
  first.create(input("wait_cancel"));
  expect(reopened.cancel("wait_cancel").lifecycle).toBe("cancelled");
  expect(reopened.cancel("wait_cancel").lifecycle).toBe("cancelled");
});

test("input and adapters are strict and never persist untyped secret-shaped fields", () => {
  const service = new WaitService(store(), [sourceAdapter(() => ({ lifecycle: "pending" }))]);
  expect(() => service.create(input("wait.one"))).toThrow(
    new WaitServiceError("invalid_request", "wait.one"),
  );
  expect(() =>
    service.create({
      ...input(),
      source: { ...input().source, target: { ...input().source.target, token: "secret-value" } },
    } as never),
  ).toThrow(new WaitServiceError("invalid_request", "wait_one"));
  expect(
    () =>
      new WaitService(store(), [
        sourceAdapter(() => ({ lifecycle: "pending" })),
        sourceAdapter(() => ({ lifecycle: "pending" })),
      ]),
  ).toThrow(new WaitServiceError("invalid_adapter"));
  expect(() =>
    service.create({ ...input(), policy: { delivery: "poll", pollIntervalMs: 1 } } as never),
  ).toThrow(new WaitServiceError("invalid_request", "wait_one"));
});

test("poll policy is a bounded eligibility gate, not a busy-waiting timer", async () => {
  let now = 1_000;
  let calls = 0;
  const service = new WaitService(
    store(),
    [
      sourceAdapter(() => {
        calls += 1;
        return { lifecycle: "pending" };
      }),
    ],
    { minPollIntervalMs: 100 },
    () => now,
  );
  service.create({ ...input(), policy: { delivery: "poll", pollIntervalMs: 100 } });
  await Bun.sleep(5);
  expect(calls).toBe(0);
  await service.reconcile("wait_one");
  expect(calls).toBe(0);
  now = 1_100;
  await service.reconcile("wait_one");
  expect(calls).toBe(1);
  await service.reconcile("wait_one");
  expect(calls).toBe(1);
});

test("a crash after adapter dispatch never replays an uncertain external effect", async () => {
  const durable = store();
  let calls = 0;
  const adapter = sourceAdapter(() => {
    calls += 1;
    throw new Error("connection lost after dispatch");
  });
  const first = new WaitService(durable, [adapter]);
  first.create(input());
  await expect(first.reconcile("wait_one")).rejects.toEqual(
    new WaitServiceError("reconcile_uncertain", "wait_one"),
  );
  const reopened = new WaitService(durable, [adapter]);
  expect(reopened.reopen("wait_one").reconciliation).toBeDefined();
  await expect(reopened.reconcile("wait_one")).rejects.toEqual(
    new WaitServiceError("reconcile_uncertain", "wait_one"),
  );
  expect(calls).toBe(1);
});
