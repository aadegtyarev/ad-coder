import { expect, test } from "bun:test";
import { WaitHost } from "../src/orchestration/wait-host";

function service(initial: any) {
  const current = { ...initial };
  let reads = 0;
  return {
    reads: () => reads,
    create: () => current,
    reopen: () => current,
    reconcile: async () => current,
    get: () => {
      reads += 1;
      return { ...current, events: [...(current.events ?? [])] };
    },
    listIds: (after = "", _limit = 32) => {
      const ids = after === "" ? [current.id] : [current.id];
      return { ids, nextCursor: "", gap: false };
    },
  };
}

function record(
  lifecycle = "pending",
  owner: { kind: string; id: string } = { kind: "run", id: "run-1" },
) {
  return {
    id: "wait-1",
    lifecycle,
    owner: { ...owner, kind: owner.kind },
    updatedAt: 20,
    events: lifecycle === "pending" ? [] : [{ lifecycle, timestamp: 42 }],
  };
}

test("WaitHost reads committed terminal state and derives one timestamp-keyed wake", async () => {
  const source = service(record("satisfied"));
  const wakes: unknown[] = [];
  let notifications = 0;
  const host = new WaitHost(
    source as any,
    {
      recordWakeWindow: (...args: unknown[]) => {
        wakes.push(args);
        return { recorded: wakes.length === 1 };
      },
    } as any,
    { notifyChange: () => (notifications += 1) },
    { cadenceMs: 100, maxWaitsPerScan: 1 },
  );
  host.watch("wait-1");
  await host.scan();
  await host.scan();
  expect(source.reads()).toBe(2);
  expect(wakes).toHaveLength(2);
  expect(wakes[0]).toEqual(["run-1", "completed", 42]);
  // Idempotent projection: the second sweep re-derives the same
  // (kind, terminal timestamp) window and recordWakeWindow hashes it out.
  expect(notifications).toBe(1);
});

test("WaitHost projects cancellation as the normal durable operator_attention wake", async () => {
  const source = service(record("cancelled"));
  const wakes: unknown[] = [];
  const host = new WaitHost(
    source as any,
    {
      recordWakeWindow: (runId: string, kind: string, at: number) => {
        wakes.push([kind, at]);
        return { recorded: true };
      },
    } as any,
    { notifyChange: () => {} },
    { cadenceMs: 100, maxWaitsPerScan: 1 },
  );
  host.watch("wait-1");
  const result = await host.scan();
  // docs/contracts/waiting.md: cancellation creates the normal durable wake,
  // projected onto the existing operator_attention window.
  expect(wakes).toEqual([["operator_attention", 42]]);
  expect(result.terminal).toBe(1);
});

test("WaitHost skips non-run owners cleanly instead of erroring every cycle", async () => {
  const source = service(record("satisfied", { kind: "session", id: "sess-1" }));
  const failures: unknown[] = [];
  const host = new WaitHost(
    source as any,
    { recordWakeWindow: () => ({ recorded: true }) } as any,
    { notifyChange: () => {} },
    { cadenceMs: 100, maxWaitsPerScan: 4, onError: (error) => failures.push(error) },
  );
  host.watch("wait-1");
  const first = await host.scan();
  const second = await host.scan();
  expect(first).toEqual({ checked: 1, terminal: 0, skipped: 1, errors: 0 });
  expect(second).toEqual(first);
  expect(failures).toHaveLength(0);
});

test("WaitHost restart enumeration is bounded and cursor advances without a bus turn", async () => {
  const source = service(record("pending"));
  let enumerated = 0;
  source.listIds = (after = "", _limit = 1) => {
    enumerated += 1;
    // Keyset page: the boundary exists on the first sweep, then the set is
    // exhausted and the sweep wraps to an empty page.
    return {
      ids: after === "" ? ["wait-1"] : [],
      nextCursor: "",
      gap: false,
    };
  };
  let turns = 0;
  const host = new WaitHost(
    source as any,
    { recordWakeWindow: () => ({ recorded: true }) } as any,
    { notifyChange: () => (turns += 1) },
    { cadenceMs: 100, maxWaitsPerScan: 1 },
  );
  await host.scan();
  await host.scan();
  expect(enumerated).toBe(2);
  expect(turns).toBe(0);
});

test("WaitHost recovers from a durable enumeration gap by restarting the sweep", async () => {
  const source = service(record("satisfied"));
  const calls: string[] = [];
  source.listIds = (after = "", _limit = 32) => {
    calls.push(after);
    if (after === "gone-1") return { ids: [], nextCursor: "", gap: true };
    return { ids: ["wait-1"], nextCursor: "", gap: false };
  };
  const host = new WaitHost(
    source as any,
    { recordWakeWindow: () => ({ recorded: true }) } as any,
    { notifyChange: () => {} },
    { cadenceMs: 100, maxWaitsPerScan: 4 },
  );
  (host as any).cursor = "gone-1";
  const gapped = await host.scan();
  expect(gapped).toEqual({ checked: 0, terminal: 0, skipped: 0, errors: 0 });
  expect(calls).toEqual(["gone-1"]);
  const next = await host.scan();
  // The gap reset the keyset boundary; the recovery sweep enumerates from "".
  expect(calls).toEqual(["gone-1", ""]);
  expect(next).toEqual({ checked: 1, terminal: 1, skipped: 0, errors: 0 });
});
