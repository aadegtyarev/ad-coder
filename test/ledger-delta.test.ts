import { expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import { diffUsage, UsageDeltaTracker } from "../src/ledger/usage";

/**
 * Synthetic cumulative readings only -- this suite makes no provider call and
 * reads no credentials.
 */
function reading(fields: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cacheWrite1h?: number;
  reasoning?: number;
}): Usage {
  return fields;
}

const turn1 = reading({
  input: 100,
  output: 20,
  cacheRead: 10,
  cacheWrite: 5,
  totalTokens: 135,
  cost: { input: 0.004, output: 0.005, cacheRead: 0.0005, cacheWrite: 0.0005, total: 0.01 },
});
const turn2 = reading({
  input: 250,
  output: 60,
  cacheRead: 30,
  cacheWrite: 9,
  totalTokens: 349,
  cost: { input: 0.01, output: 0.0135, cacheRead: 0.0008, cacheWrite: 0.0007, total: 0.025 },
});
const turn3 = reading({
  input: 400,
  output: 95,
  cacheRead: 44,
  cacheWrite: 12,
  totalTokens: 551,
  cost: { input: 0.016, output: 0.0221, cacheRead: 0.001, cacheWrite: 0.0009, total: 0.04 },
});

test("first reading of a stream is its own delta", () => {
  const delta = diffUsage(undefined, turn1);
  expect(delta.input).toBe(100);
  expect(delta.output).toBe(20);
  expect(delta.cacheRead).toBe(10);
  expect(delta.cacheWrite).toBe(5);
  expect(delta.totalTokens).toBe(135);
  expect(delta.cost).toEqual(turn1.cost);
  expect(delta.anomaly).toBeUndefined();
});

test("tracker turns a cumulative sequence into pairwise per-turn deltas", () => {
  const tracker = new UsageDeltaTracker();
  const key = "run-1:main";

  const d1 = tracker.delta(key, turn1);
  const d2 = tracker.delta(key, turn2);
  const d3 = tracker.delta(key, turn3);

  expect(d1.input).toBe(100);
  expect(d2.input).toBe(150);
  expect(d3.input).toBe(150);

  expect(d1.output).toBe(20);
  expect(d2.output).toBe(40);
  expect(d3.output).toBe(35);

  expect(d1.cacheRead).toBe(10);
  expect(d2.cacheRead).toBe(20);
  expect(d3.cacheRead).toBe(14);

  expect(d1.cacheWrite).toBe(5);
  expect(d2.cacheWrite).toBe(4);
  expect(d3.cacheWrite).toBe(3);

  expect(d1.totalTokens).toBe(135);
  expect(d2.totalTokens).toBe(214);
  expect(d3.totalTokens).toBe(202);

  expect(d1.cost.total).toBeCloseTo(0.01, 10);
  expect(d2.cost.total).toBeCloseTo(0.015, 10);
  expect(d3.cost.total).toBeCloseTo(0.015, 10);

  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    expect(d2.cost[field]).toBeCloseTo(turn2.cost[field] - turn1.cost[field], 10);
    expect(d3.cost[field]).toBeCloseTo(turn3.cost[field] - turn2.cost[field], 10);
  }

  // The per-turn totals must reconstruct the last cumulative reading; a delta
  // that returned the raw cumulative value would sum to far more.
  expect(d1.input + d2.input + d3.input).toBe(turn3.input);
  expect(d1.totalTokens + d2.totalTokens + d3.totalTokens).toBe(turn3.totalTokens);
});

test("provider-optional fields are omitted when neither reading reports them", () => {
  const tracker = new UsageDeltaTracker();
  const key = "run-1:main";

  const d1 = tracker.delta(key, turn1);
  expect("cacheWrite1h" in d1).toBe(false);
  expect("reasoning" in d1).toBe(false);

  const withSubsets = reading({ ...turn2, cacheWrite1h: 4, reasoning: 25 });
  const d2 = tracker.delta(key, withSubsets);
  expect(d2.cacheWrite1h).toBe(4);
  expect(d2.reasoning).toBe(25);

  const laterSubsets = reading({ ...turn3, cacheWrite1h: 6, reasoning: 40 });
  const d3 = tracker.delta(key, laterSubsets);
  expect(d3.cacheWrite1h).toBe(2);
  expect(d3.reasoning).toBe(15);
  // Subsets of cacheWrite and output respectively: never added to the parent.
  expect(d3.cacheWrite).toBe(3);
  expect(d3.output).toBe(35);
});

test("a reading that goes backwards clamps to zero and flags the anomaly", () => {
  const tracker = new UsageDeltaTracker();
  const key = "run-1:main";
  tracker.delta(key, turn2);

  const reset = tracker.delta(key, turn1);
  expect(reset.anomaly).toBe("non_monotonic");
  expect(reset.input).toBe(0);
  expect(reset.output).toBe(0);
  expect(reset.totalTokens).toBe(0);
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    expect(reset.cost[field]).toBe(0);
    expect(reset.cost[field]).toBeGreaterThanOrEqual(0);
  }
});

test("independent keys keep independent baselines", () => {
  const tracker = new UsageDeltaTracker();

  const aFirst = tracker.delta("run-1:main", turn1);
  const bFirst = tracker.delta("run-2:main", turn1);
  expect(bFirst.input).toBe(aFirst.input);

  const aSecond = tracker.delta("run-1:main", turn2);
  expect(aSecond.input).toBe(150);

  const bSecond = tracker.delta("run-2:main", turn3);
  expect(bSecond.input).toBe(300);
  expect(bSecond.anomaly).toBeUndefined();
});

test("forget drops a finished stream's baseline", () => {
  const tracker = new UsageDeltaTracker();
  tracker.delta("run-1:main", turn1);
  expect(tracker.trackedKeys).toBe(1);

  tracker.forget("run-1:main");
  expect(tracker.trackedKeys).toBe(0);
  expect(tracker.delta("run-1:main", turn1).input).toBe(100);
});

test("a mutated caller object cannot rewrite a stored baseline", () => {
  const tracker = new UsageDeltaTracker();
  const mutable = reading({ ...turn1, cost: { ...turn1.cost } });
  tracker.delta("run-1:main", mutable);
  mutable.input = 9999;

  expect(tracker.delta("run-1:main", turn2).input).toBe(150);
});
