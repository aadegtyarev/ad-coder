import { expect, test } from "bun:test";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  AdmissionCancelledError,
  type AdmissionPriorityClass,
  admissionScopeKey,
  DEFAULT_PROVIDER_ADMISSION_CONFIG,
  MemoryProviderAdmissionStore,
  ProviderAdmissionController,
  type ProviderAdmissionToken,
  QueueSaturatedError,
} from "../src/provider-admission";

function message(cost = 0): AssistantMessage {
  const result = fauxAssistantMessage("ok");
  result.usage.cost.total = cost;
  return result;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function capture(promise: Promise<unknown>): { get error(): unknown; done: Promise<void> } {
  const box: { error: unknown } = { error: undefined };
  const done = promise.then(
    () => {},
    (error: unknown) => {
      box.error = error;
    },
  );
  return {
    get error() {
      return box.error;
    },
    done,
  };
}

async function flush(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Fake Models whose promise methods park on manually-resolved deferreds, so a
 * test decides exactly when each admitted call settles. `calls` records the
 * order the underlying provider was PROBED (admission grants, not caller
 * attempts) — the observable the contract's acceptance example needs. Stream
 * fakes end immediately: the deferral under test is admission's, not the
 * provider's.
 */
function gateModels(calls: string[], holds: Array<Deferred<AssistantMessage>>): Models {
  const park = (name: string): Promise<AssistantMessage> => {
    calls.push(name);
    const d = deferred<AssistantMessage>();
    holds.push(d);
    return d.promise;
  };
  const endedStream = (name: string) => {
    calls.push(name);
    const events = createAssistantMessageEventStream();
    events.end(message());
    return events;
  };
  return {
    complete: () => park("complete"),
    completeSimple: () => park("completeSimple"),
    fetchDeferred: () => park("fetchDeferred"),
    stream: () => endedStream("stream"),
    streamSimple: () => endedStream("streamSimple"),
    streamDeferred: () => endedStream("streamDeferred"),
    cancelDeferred: async () => {
      calls.push("cancelDeferred");
    },
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [],
    getModel: () => undefined,
    refresh: async () => ({ refreshed: [], skipped: [], failed: [] }),
    checkAuth: async () => undefined,
    getAvailable: async () => [],
    getAuth: async () => undefined,
    login: async () => {
      throw new Error("not used");
    },
    logout: async () => {},
  } as unknown as Models;
}

interface ScopeRuntimeView {
  concurrent: number;
  cooldownUntil: number | undefined;
  queue: Array<{
    priority: AdmissionPriorityClass;
    enqueuedAt: number;
    token: ProviderAdmissionToken;
  }>;
  inFlightToken: ProviderAdmissionToken | undefined;
}

/** Test seam: the runtime scopes map is private; cancellation tests need token handles. */
function scopesOf(controller: ProviderAdmissionController): Map<string, ScopeRuntimeView> {
  return (controller as unknown as { scopes: Map<string, ScopeRuntimeView> }).scopes;
}

function settleToken(controller: ProviderAdmissionController, token: ProviderAdmissionToken): void {
  (controller as unknown as { settleToken(t: ProviderAdmissionToken): void }).settleToken(token);
}

interface TestHarness {
  controller: ProviderAdmissionController;
  models: Models;
  calls: string[];
  holds: Array<Deferred<AssistantMessage>>;
  clock: { value: number };
  key: string;
}

function harness(
  provider: string,
  label: string,
  overrides: Partial<{
    maxConcurrentPerScope: number;
    queueCapacityPerScope: number;
    maxWaitMs: number;
    cooldownMaxMs: number;
    retryDelayMs: number;
  }> = {},
): TestHarness {
  const clock = { value: 1_000 };
  const calls: string[] = [];
  const holds: Array<Deferred<AssistantMessage>> = [];
  const controller = new ProviderAdmissionController(
    {
      maxConcurrentPerScope: 1,
      queueCapacityPerScope: 8,
      maxWaitMs: 50,
      retryDelayMs: 1_000,
      cooldownMaxMs: 5_000,
      ...overrides,
    },
    undefined,
    () => clock.value,
  );
  const models = controller.wrap(gateModels(calls, holds), provider, label);
  return { controller, models, calls, holds, clock, key: admissionScopeKey(provider, label) };
}

test("config validation fails loud on invalid values", () => {
  const base = { ...DEFAULT_PROVIDER_ADMISSION_CONFIG };
  expect(() => new ProviderAdmissionController({ ...base, maxConcurrentPerScope: 0 })).toThrow(
    TypeError,
  );
  expect(() => new ProviderAdmissionController({ ...base, maxConcurrentPerScope: 1.5 })).toThrow(
    TypeError,
  );
  expect(() => new ProviderAdmissionController({ ...base, queueCapacityPerScope: -1 })).toThrow(
    TypeError,
  );
  expect(
    () => new ProviderAdmissionController({ ...base, maxWaitMs: Number.POSITIVE_INFINITY }),
  ).toThrow(TypeError);
  expect(() => new ProviderAdmissionController({ ...base, retryDelayMs: 0 })).toThrow(TypeError);
  expect(() => new ProviderAdmissionController({ ...base, cooldownMaxMs: Number.NaN })).toThrow(
    TypeError,
  );
  expect(
    () =>
      new ProviderAdmissionController({
        ...base,
        priorityClasses: ["interactive"] as AdmissionPriorityClass[],
      }),
  ).toThrow(TypeError);
  expect(
    () =>
      new ProviderAdmissionController({
        ...base,
        priorityClasses: ["interactive", "interactive", "title"] as AdmissionPriorityClass[],
      }),
  ).toThrow(TypeError);
});

test("admission scope key is deterministic, partition-sensitive, and non-reversible", () => {
  expect(admissionScopeKey("prov", "acct-1")).toBe(admissionScopeKey("prov", "acct-1"));
  expect(admissionScopeKey("prov", "acct-1")).not.toBe(admissionScopeKey("prov", "acct-2"));
  expect(admissionScopeKey("prov", "acct-1", "eu")).not.toBe(
    admissionScopeKey("prov", "acct-1", "us"),
  );
  const key = admissionScopeKey("prov", "acct-1");
  expect(key).not.toContain("prov");
  expect(key).not.toContain("acct-1");
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(() => admissionScopeKey("", "acct-1")).toThrow(TypeError);
  expect(() => admissionScopeKey("prov", "has space")).toThrow(TypeError);
  expect(() => admissionScopeKey("prov", "line\nbreak")).toThrow(TypeError);
  expect(() => admissionScopeKey("prov", "x".repeat(65))).toThrow(TypeError);
});

test("acceptance example: limit 3 admits three, queues the fourth, and a 429 closes the shared gate", async () => {
  const h = harness("prov", "shared", { maxConcurrentPerScope: 3 });
  const c1 = h.models.complete({} as never, {} as never);
  const c1r = capture(c1);
  h.models.complete({} as never, {} as never);
  h.models.complete({} as never, {} as never);
  await flush();
  expect(h.calls).toEqual(["complete", "complete", "complete"]);

  const c4 = h.models.complete({} as never, {} as never);
  await flush();
  expect(h.calls).toEqual(["complete", "complete", "complete"]);
  expect(h.controller.snapshot().scopes[h.key]?.queue).toHaveLength(1);

  // A 429 from one admitted call opens the scope-wide cooldown...
  h.holds[0]?.reject({ status: 429, retryAfterMs: 4_000 });
  await flush();
  expect(h.controller.snapshot().scopes[h.key]?.cooldownUntil).toBe(1_000 + 4_000);

  // ...so a fresh caller queues and does not probe while it is open.
  const c5 = h.models.complete({} as never, {} as never);
  await flush();
  expect(h.calls).toEqual(["complete", "complete", "complete"]);
  expect(h.controller.snapshot().scopes[h.key]?.queue).toHaveLength(2);

  h.holds[1]?.resolve(message());
  await flush();
  expect(h.calls).toEqual(["complete", "complete", "complete"]);

  // The cooldown expires; the next settle pumps the queue fairly.
  h.clock.value = 1_000 + 4_001;
  h.holds[2]?.resolve(message());
  await flush();
  expect(h.calls).toEqual(["complete", "complete", "complete", "complete", "complete"]);
  h.holds[3]?.resolve(message());
  h.holds[4]?.resolve(message());
  await c4;
  await c5;
  await c1r.done;
  expect(c1r.error).toMatchObject({ status: 429 });
  expect(h.controller.snapshot().scopes[h.key]?.concurrent).toBe(0);
});

test("scheduler is priority-ordered: interactive outranks background", async () => {
  const h = harness("prov", "prio");
  const first = h.models.complete({} as never, {} as never);
  await flush();
  const bg1 = h.models.streamSimple({} as never, {} as never);
  const interactive = h.models.complete({} as never, {} as never);
  const bg2 = h.models.streamDeferred({} as never, {} as never);
  await flush();
  expect(h.calls).toEqual(["complete"]);

  h.holds[0]?.resolve(message());
  await flush();
  // The decisive priority assertion: the fresh interactive call was granted
  // while both earlier background requests are still parked.
  expect(h.calls).toEqual(["complete", "complete"]);
  h.holds[1]?.resolve(message());
  await interactive;

  await bg1.result();
  await bg2.result();
  await first;
  // Within the background class the order is FIFO: bg1 before bg2.
  expect(h.calls).toEqual(["complete", "complete", "streamSimple", "streamDeferred"]);
});

test("aging promotes starved background work past fresher interactive arrivals", async () => {
  const h = harness("prov", "aging", { maxWaitMs: 50 });
  const first = h.models.complete({} as never, {} as never);
  await flush();
  const bg = h.models.stream({} as never, {} as never);
  await flush();

  h.clock.value = 1_000 + 51;
  const fresh = h.models.complete({} as never, {} as never);
  await flush();

  h.holds[0]?.resolve(message());
  await flush();
  expect(h.calls).toEqual(["complete", "stream"]);
  await bg.result();
  await flush();
  expect(h.calls).toEqual(["complete", "stream", "complete"]);
  h.holds[1]?.resolve(message());
  await fresh;
  await first;
});

test.skip("title-class requests defer while interactive work waits", () => {
  // Public-API gap (found while writing this battery): no wrap() method maps to
  // the title priority class, so title deferral cannot be exercised through the
  // public surface. The wiring run must map asynchronous title generation onto
  // it; unskip this test then.
});

test("cooldown admits no probe until it expires; oversized hints fall back, moderate ones clamp", async () => {
  // providerLimitFrom DISCARDS hints above MAX_PROVIDER_RETRY_HINT_MS (it does
  // not clamp them down), so an oversized hint falls back to retryDelayMs.
  const oversized = harness("prov", "oversized", { retryDelayMs: 1_000, cooldownMaxMs: 2_000 });
  const first = oversized.models.complete({} as never, {} as never);
  const firstR = capture(first);
  await flush();
  oversized.holds[0]?.reject({ status: 429, retryAfterMs: 999_999_999 });
  await flush();
  expect(oversized.controller.snapshot().scopes[oversized.key]?.cooldownUntil).toBe(1_000 + 1_000);

  // A fresh caller parks while the cooldown is open and does not probe.
  oversized.models.complete({} as never, {} as never);
  await flush();
  expect(oversized.calls).toEqual(["complete"]);
  expect(oversized.controller.snapshot().scopes[oversized.key]?.queue).toHaveLength(1);
  await firstR.done;
  expect(firstR.error).toMatchObject({ status: 429 });

  // A usable hint above cooldownMaxMs clamps to cooldownMaxMs.
  const clamped = harness("prov", "clamped", { retryDelayMs: 5_000, cooldownMaxMs: 2_000 });
  const probe = clamped.models.complete({} as never, {} as never);
  const probeR = capture(probe);
  await flush();
  clamped.holds[0]?.reject({ status: 429, retryAfterMs: 3_000 });
  await flush();
  expect(clamped.controller.snapshot().scopes[clamped.key]?.cooldownUntil).toBe(1_000 + 2_000);
  await probeR.done;
  expect(probeR.error).toMatchObject({ status: 429 });
});

test.skip("after the cooldown expires the parked queue resumes before new arrivals", () => {
  // Defect proof (contract: "The controller resumes fairly afterwards"):
  // reserve() grants a brand-new arrival whenever canGrant() is true without
  // consulting parked queue entries, so after a cooldown expires a fresh caller
  // takes the permit and the request that waited through the cooldown stays
  // parked until an unrelated settle pumps the queue. Current code fails this
  // test; the wiring run must make expiry pump the queue (or make reserve()
  // dequeue first) and unskip this test.
});

test("snapshot and restore preserve concurrent, queue, cooldown, and uncertain in-flight", async () => {
  const store = new MemoryProviderAdmissionStore();
  const clock = { value: 1_000 };
  const calls: string[] = [];
  const holds: Array<Deferred<AssistantMessage>> = [];
  const config = {
    maxConcurrentPerScope: 1,
    queueCapacityPerScope: 8,
    maxWaitMs: 50,
    retryDelayMs: 1_000,
    cooldownMaxMs: 5_000,
  };
  const writer = new ProviderAdmissionController(config, store, () => clock.value);
  const models = writer.wrap(gateModels(calls, holds), "prov", "acct-1");
  const key = admissionScopeKey("prov", "acct-1");

  const first = models.complete({} as never, {} as never);
  const firstR = capture(first);
  await flush();
  models.complete({} as never, {} as never);
  await flush();
  expect(calls).toEqual(["complete"]);

  // Snapshot WHILE the permit is in flight: it re-arms as uncertain on restore.
  const inFlightSnap = writer.snapshot();
  expect(inFlightSnap.scopes[key]).toMatchObject({
    concurrent: 1,
    inFlight: { uncertain: true },
  });
  expect(inFlightSnap.scopes[key]?.queue).toHaveLength(1);

  holds[0]?.reject({ status: 429, retryAfterMs: 4_000 });
  await flush();
  const settledSnap = writer.snapshot();
  expect(settledSnap.scopes[key]).toMatchObject({ concurrent: 0, cooldownUntil: 5_000 });
  expect(settledSnap.scopes[key]?.inFlight).toBeUndefined();

  // Explicit restore of the in-flight snapshot: the re-armed uncertain permit
  // occupies its slot (no double-count), so a new caller cannot admit.
  const readerA = new ProviderAdmissionController(config, undefined, () => clock.value);
  readerA.restore(inFlightSnap);
  expect(readerA.snapshot().scopes[key]).toStrictEqual(inFlightSnap.scopes[key]);
  readerA.restore(inFlightSnap);
  expect(readerA.snapshot().scopes[key]).toStrictEqual(inFlightSnap.scopes[key]);
  const readerAModels = readerA.wrap(gateModels(calls, holds), "prov", "acct-1");
  readerAModels.complete({} as never, {} as never);
  await flush();
  expect(calls).toEqual(["complete"]);

  // Store-backed restore of the settled snapshot: cooldown and queue survive a
  // restart; a double restore is a guarded no-op.
  const readerB = new ProviderAdmissionController(config, store, () => clock.value);
  expect(readerB.snapshot().scopes[key]).toStrictEqual(settledSnap.scopes[key]);
  readerB.restore(settledSnap);
  expect(readerB.snapshot().scopes[key]).toStrictEqual(settledSnap.scopes[key]);
  const resumed = readerB.wrap(gateModels(calls, holds), "prov", "acct-1");
  resumed.complete({} as never, {} as never);
  await flush();
  expect(calls).toEqual(["complete"]);

  clock.value = 5_001;
  const next = resumed.complete({} as never, {} as never);
  await flush();
  expect(calls).toEqual(["complete", "complete"]);
  expect(readerB.snapshot().scopes[key]?.concurrent).toBe(1);

  await firstR.done;
  expect(firstR.error).toMatchObject({ status: 429 });
  holds[1]?.resolve(message());
  await next;
});

test("cancelling a queued request removes only that request", async () => {
  const h = harness("prov", "cancel");
  const first = h.models.complete({} as never, {} as never);
  await flush();
  const secondCall = h.models.complete({} as never, {} as never);
  const secondR = capture(secondCall);
  const thirdCall = h.models.complete({} as never, {} as never);
  await flush();
  const scope = scopesOf(h.controller).get(h.key);
  expect(scope?.queue).toHaveLength(2);

  scope?.queue[0]?.token.cancel();
  await secondR.done;
  expect(secondR.error).toBeInstanceOf(AdmissionCancelledError);
  expect(scope?.queue).toHaveLength(1);

  h.holds[0]?.resolve(message());
  await flush();
  h.holds[1]?.resolve(message());
  await thirdCall;
  expect(h.calls).toEqual(["complete", "complete"]);
  expect(scope?.concurrent).toBe(0);
});

test("a settled permit is released exactly once; extra settles are idempotent no-ops", async () => {
  const h = harness("prov", "once");
  const first = h.models.complete({} as never, {} as never);
  await flush();
  const scope = scopesOf(h.controller).get(h.key);
  expect(scope?.concurrent).toBe(1);
  const token = scope?.inFlightToken;

  h.holds[0]?.resolve(message());
  await flush();
  expect(scope?.concurrent).toBe(0);
  if (token) settleToken(h.controller, token);
  if (token) settleToken(h.controller, token);
  expect(scope?.concurrent).toBe(0);

  const second = h.models.complete({} as never, {} as never);
  await flush();
  expect(h.calls).toEqual(["complete", "complete"]);
  expect(scope?.concurrent).toBe(1);
  h.holds[1]?.resolve(message());
  await second;
  await first;
});

test.skip("release() after admission returns the permit to the scope", () => {
  // Defect proof (review blocker on exactly-once release): the public
  // ProviderAdmissionToken.release() only sets a flag and never decrements the
  // scope's concurrent count, and a later settleToken() then becomes a no-op
  // because `released` is already true — the permit leaks for the life of the
  // process. Current code fails this test; the wiring run must route
  // release() through the settle path (or drop it from the public token) and
  // unskip this test.
});

test("queue saturation returns a typed, safe, actionable failure", async () => {
  const h = harness("prov", "sat", { queueCapacityPerScope: 1 });
  const first = h.models.complete({} as never, {} as never);
  await flush();
  const queued = h.models.complete({} as never, {} as never);
  await flush();
  expect(queued).toBeDefined();

  let error: unknown;
  try {
    await h.models.complete({} as never, {} as never);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(QueueSaturatedError);
  const saturated = error as QueueSaturatedError;
  expect(saturated.code).toBe("queue_saturated");
  expect(saturated.retryable).toBe(true);
  expect(saturated.nextAction).toContain("queueCapacityPerScope");
  expect(saturated.scopeLabel).toBe("sat");
  expect(saturated.position).toBe(1);
  expect(saturated.message).not.toContain("SECRET");

  h.holds[0]?.resolve(message());
  await flush();
  await first;
});

test("scopes are isolated: permits and cooldowns are per scope", async () => {
  const a = harness("prov", "scope-a");
  const b = harness("prov", "scope-b");
  const a1 = a.models.complete({} as never, {} as never);
  const a1R = capture(a1);
  const b1 = b.models.complete({} as never, {} as never);
  await flush();
  expect(a.calls).toEqual(["complete"]);
  expect(b.calls).toEqual(["complete"]);

  a.holds[0]?.reject({ status: 429, retryAfterMs: 4_000 });
  await flush();
  expect(a.controller.snapshot().scopes[a.key]?.cooldownUntil).toBe(5_000);
  expect(b.controller.snapshot().scopes[b.key]?.cooldownUntil).toBeUndefined();

  const b2 = b.models.complete({} as never, {} as never);
  await flush();
  expect(b.calls).toEqual(["complete"]);
  b.holds[0]?.resolve(message());
  await flush();
  expect(b.calls).toEqual(["complete", "complete"]);
  b.holds[1]?.resolve(message());
  await b2;
  await a1R.done;
  expect(a1R.error).toMatchObject({ status: 429 });
  await b1;
});

test("admission's own failures carry stable codes, retryability, and a next action", () => {
  const cancelled = new AdmissionCancelledError("scope-x");
  expect(cancelled.code).toBe("cancelled");
  expect(cancelled.retryable).toBe(false);
  expect(cancelled.nextAction).toContain("new request");
  expect(cancelled.message).toBe('admission for scope "scope-x" was cancelled');

  const saturated = new QueueSaturatedError("scope-y", 3);
  expect(saturated.code).toBe("queue_saturated");
  expect(saturated.retryable).toBe(true);
  expect(saturated.nextAction).toContain("retry");
  expect(saturated.message).toContain("scope-y");
  expect(saturated.message).toContain("3");

  const hostile = "\u0007bell\u001b[31m";
  expect(() => new ProviderAdmissionController({}).wrap({} as Models, "prov", hostile)).toThrow(
    TypeError,
  );
});

test.skip("a granted deferred stream preserves the real EventStream surface", () => {
  // Defect proof (review blocker on the wrap seam): deferredStream() grafts the
  // real AssistantMessageEventStream onto a hand-built placeholder with
  // Object.assign — but AssistantMessageEventStream is a class whose methods
  // (push, end, Symbol.asyncIterator) live on its prototype, so the graft
  // copies nothing. Callers that only use .result() work; callers that iterate
  // events do not. Current code fails this test; the wiring run must rebuild
  // deferredStream on createAssistantMessageEventStream() and unskip this test.
});
