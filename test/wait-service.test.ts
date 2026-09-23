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

test("cancellation keeps an in-flight dispatch witness when a late adapter result arrives", async () => {
  const durable = store();
  let resolve!: (observation: { lifecycle: "satisfied"; evidence: "condition_met" }) => void;
  const service = new WaitService(durable, [
    sourceAdapter(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  ]);
  service.create(input());
  const reconciling = service.reconcile("wait_one");
  await Bun.sleep(1);

  expect(service.cancel("wait_one").reconciliation).toBeDefined();
  resolve({ lifecycle: "satisfied", evidence: "condition_met" });
  await expect(reconciling).rejects.toEqual(
    new WaitServiceError("reconcile_uncertain", "wait_one"),
  );

  const reopened = new WaitService(durable, [sourceAdapter(() => ({ lifecycle: "pending" }))]);
  const record = reopened.reopen("wait_one");
  expect(record.lifecycle).toBe("cancelled");
  expect(record.reconciliation).toBeDefined();
  expect(record.evidence.at(-1)?.code).toBe("cancelled");
});

test("a deadline also retains an in-flight dispatch witness for a late adapter result", async () => {
  const durable = store();
  let now = 100;
  let resolve!: (observation: { lifecycle: "satisfied"; evidence: "condition_met" }) => void;
  const service = new WaitService(
    durable,
    [
      sourceAdapter(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    ],
    {},
    () => now,
  );
  service.create({ ...input(), deadlineAt: 101 });
  const reconciling = service.reconcile("wait_one");
  now = 101;
  expect((await service.reconcile("wait_one")).lifecycle).toBe("timed_out");
  resolve({ lifecycle: "satisfied", evidence: "condition_met" });
  await expect(reconciling).rejects.toEqual(
    new WaitServiceError("reconcile_uncertain", "wait_one"),
  );
  expect(service.reopen("wait_one").reconciliation).toBeDefined();
});

test("persisted wait event data is strictly shaped and bounded before it can be exposed", () => {
  const durable = store();
  const service = new WaitService(durable, [sourceAdapter(() => ({ lifecycle: "pending" }))], {
    maxEventsPerWait: 1,
    maxEvidenceEntries: 1,
  });
  service.create(input());
  const statePath = durable.waitStatePath("wait_one");
  const corrupt = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    version: number;
    value: { events: unknown[]; evidence: unknown[] };
  };
  corrupt.value.events = [
    { version: 1, sequence: 1, waitId: "wait_one", lifecycle: "pending", timestamp: 1 },
    { version: 1, sequence: 2, waitId: "wait_one", lifecycle: "pending", timestamp: 2 },
  ];
  fs.writeFileSync(statePath, `${JSON.stringify(corrupt)}\n`);
  expect(() => service.events("wait_one")).toThrow(
    new WaitServiceError("invalid_request", "wait_one"),
  );

  corrupt.value.events = [
    {
      version: 1,
      sequence: 1,
      waitId: "wait_one",
      lifecycle: "pending",
      timestamp: 1,
      evidence: { code: "condition_met", at: 1, raw: "must-not-escape" },
    },
  ];
  fs.writeFileSync(statePath, `${JSON.stringify(corrupt)}\n`);
  expect(() => service.reopen("wait_one")).toThrow(
    new WaitServiceError("invalid_request", "wait_one"),
  );

  corrupt.value.events = [
    { version: 1, sequence: 1, waitId: "wait_one", lifecycle: "pending", timestamp: 1 },
  ];
  corrupt.value.evidence = [
    { code: "condition_met", at: 1 },
    { code: "condition_met", at: 2 },
  ];
  fs.writeFileSync(statePath, `${JSON.stringify(corrupt)}\n`);
  expect(() => service.get("wait_one")).toThrow(
    new WaitServiceError("invalid_request", "wait_one"),
  );
});

test("an unknown top-level persisted wait field is refused before any read surface can expose it", () => {
  const durable = store();
  const service = new WaitService(durable, [sourceAdapter(() => ({ lifecycle: "pending" }))]);
  service.create(input());
  const statePath = durable.waitStatePath("wait_one");
  const corrupt = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    version: number;
    value: Record<string, unknown>;
  };
  corrupt.value.untypedTransportDetail = "secret-value-must-not-escape";
  fs.writeFileSync(statePath, `${JSON.stringify(corrupt)}\n`);

  for (const read of [
    () => service.get("wait_one"),
    () => service.events("wait_one"),
    () => service.reopen("wait_one"),
  ])
    expect(read).toThrow(new WaitServiceError("invalid_request", "wait_one"));
});

test("a valid but oversized persisted wait record is refused before every read surface", () => {
  const durable = store();
  const limits = { maxEventsPerWait: 100_000, maxPersistedStateBytes: 64 * 1024 };
  const service = new WaitService(
    durable,
    [sourceAdapter(() => ({ lifecycle: "pending" }))],
    limits,
  );
  service.create(input());
  const statePath = durable.waitStatePath("wait_one");
  const oversized = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    version: number;
    value: { events: unknown[]; nextSequence: number };
  };
  oversized.value.events = Array.from({ length: 100_000 }, (_, index) => ({
    version: 1,
    sequence: index + 1,
    waitId: "wait_one",
    lifecycle: "pending",
    timestamp: index + 1,
  }));
  oversized.value.nextSequence = 100_001;
  fs.writeFileSync(statePath, `${JSON.stringify(oversized)}\n`);

  expect(fs.statSync(statePath).size).toBeGreaterThan(limits.maxPersistedStateBytes);
  expect(() => service.get("wait_one")).toThrow(
    new WaitServiceError("state_too_large", "wait_one"),
  );
  expect(() => service.events("wait_one")).toThrow(
    new WaitServiceError("state_too_large", "wait_one"),
  );
  expect(() => service.reopen("wait_one")).toThrow(
    new WaitServiceError("state_too_large", "wait_one"),
  );
});

test("the wait byte ceiling uses the actual next storage-envelope version", () => {
  const durable = store();
  const now = 100;
  const unbounded = new WaitService(
    durable,
    [sourceAdapter(() => ({ lifecycle: "pending" }))],
    {},
    () => now,
  );
  unbounded.create(input());
  const statePath = durable.waitStatePath("wait_one");
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    version: number;
    value: {
      lifecycle: string;
      updatedAt: number;
      nextSequence: number;
      events: unknown[];
      evidence: unknown[];
    };
  };
  const projected = structuredClone(persisted.value);
  projected.lifecycle = "cancelled";
  projected.updatedAt = now;
  projected.events.push({
    version: 1,
    sequence: projected.nextSequence,
    waitId: "wait_one",
    lifecycle: "cancelled",
    timestamp: now,
    evidence: { code: "cancelled", at: now },
  });
  projected.nextSequence += 1;
  projected.evidence.push({ code: "cancelled", at: now });
  // Version 1 is one byte shorter than the actual next envelope, version 10.
  const versionOneBytes = Buffer.byteLength(JSON.stringify({ version: 1, value: projected })) + 1;
  fs.writeFileSync(statePath, `${JSON.stringify({ version: 9, value: persisted.value })}\n`);

  const bounded = new WaitService(
    durable,
    [sourceAdapter(() => ({ lifecycle: "pending" }))],
    { maxPersistedStateBytes: versionOneBytes },
    () => now,
  );
  expect(() => bounded.cancel("wait_one")).toThrow(
    new WaitServiceError("state_too_large", "wait_one"),
  );
  expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({
    version: 9,
    value: { lifecycle: "pending" },
  });
});
