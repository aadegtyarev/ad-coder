import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  COST_ANOMALY_STATE_PATH,
  CostAnomalyBlockedError,
  CostAnomalyDetector,
  type CostAnomalyObservation,
  DEFAULT_COST_ANOMALY_CONFIG,
  FileCostAnomalyStore,
  MemoryCostAnomalyStore,
} from "../src/economics/cost-anomaly";

/**
 * One settled response billed at `ratio` times the declared price.
 *
 * `expectedUsd` varies freely because it MUST NOT matter: the point of the
 * ratio is that the size and token mix of a response cancel out.
 */
function at(ratio: number, expectedUsd = 0.002): CostAnomalyObservation {
  return {
    provider: "openrouter",
    model: "deepseekflash",
    chargedUsd: ratio * expectedUsd,
    expectedUsd,
  };
}

/** Bill at the declared price until the scope is established as normal. */
function settle(detector: CostAnomalyDetector, count = 5): void {
  for (let index = 0; index < count; index += 1) detector.observe(at(1));
}

test("billing the declared price is normal however large or small the response", () => {
  const detector = new CostAnomalyDetector();
  // Four orders of magnitude of response size, all correctly billed. A
  // detector watching dollars-per-token would see these as wildly different
  // rates; the ratio is 1.00 for every one of them.
  detector.observe(at(1, 0.0001));
  detector.observe(at(1, 0.05));
  detector.observe(at(1, 0.9));
  expect(detector.status("openrouter", "deepseekflash")).toMatchObject({
    state: "normal",
    ratio: 1,
    samples: 3,
  });
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
});

test("the first response is already checked, so a reprice already in effect is caught", () => {
  // NO WARM-UP. A learned baseline must see normal traffic before it can judge
  // anything, so a price that was already wrong when this project started gets
  // learned as correct and never reported. The declared price needs no warm-up.
  const detector = new CostAnomalyDetector();
  expect(detector.observe(at(3))).toBeUndefined();
  const block = detector.observe(at(3));
  expect(block).toBeDefined();
  expect(block?.ratio).toBeCloseTo(3, 5);
});

test("a discount never blocks, and neither does the discount ending", () => {
  // THE FALSE-ALARM THIS DESIGN EXISTS TO PREVENT. A cheap backend bills half
  // the declared price for a long stretch, then stops being available and the
  // next one bills the ordinary price. Against a LEARNED baseline that is a
  // doubling and blocks the session; against the declared price it is a return
  // to 1.00, which is what the operator agreed to pay in the first place.
  const detector = new CostAnomalyDetector();
  for (let index = 0; index < 10; index += 1) detector.observe(at(0.5));
  expect(detector.status("openrouter", "deepseekflash")).toMatchObject({ ratio: 0.5 });

  for (let index = 0; index < 5; index += 1) expect(detector.observe(at(1))).toBeUndefined();
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
  expect(detector.status("openrouter", "deepseekflash").state).toBe("normal");
});

test("token composition cannot trip the detector, however extreme", () => {
  // Within one price list an output token costs many times an input token and
  // an input token many times a cache read, so dollars-per-token swings by
  // orders of magnitude at a constant price. Every one of these is billed
  // correctly, and the expectation moves with the composition.
  const detector = new CostAnomalyDetector();
  for (const expectedUsd of [0.00003, 0.02, 0.00007, 0.3, 0.000005, 0.11]) {
    expect(detector.observe(at(1, expectedUsd))).toBeUndefined();
  }
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
});

test("a single over-threshold reading never blocks, and a return to normal discards it", () => {
  const detector = new CostAnomalyDetector();
  settle(detector);

  expect(detector.observe(at(3))).toBeUndefined();
  expect(detector.status("openrouter", "deepseekflash")).toMatchObject({
    state: "watching",
    pending: 1,
    required: 2,
  });
  // Back to the declared price: the artifact is discarded, not banked toward a
  // later false confirmation hours away.
  detector.observe(at(1));
  expect(detector.status("openrouter", "deepseekflash").state).toBe("normal");
  expect(detector.observe(at(3))).toBeUndefined();
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
});

test("a confirmed overcharge blocks new runs and names every number the operator needs", () => {
  const detector = new CostAnomalyDetector({}, undefined, () => 1_600_000_000_000);
  settle(detector);
  detector.observe(at(4, 0.002));
  const block = detector.observe(at(4, 0.003));

  expect(block).toBeDefined();
  expect(block?.ratio).toBeCloseTo(4, 5);
  // The SUMS over the confirming responses: two amounts the operator can check
  // against the provider's own invoice.
  expect(block?.chargedUsd).toBeCloseTo(0.02, 10);
  expect(block?.expectedUsd).toBeCloseTo(0.005, 10);
  expect(block?.acceptedRatio).toBe(1);
  expect(block?.confirmingObservations).toBe(2);
  expect(block?.at).toBe(1_600_000_000_000);

  let caught: unknown;
  try {
    detector.admit("openrouter", "deepseekflash");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CostAnomalyBlockedError);
  const message = (caught as Error).message;
  // The scope, the ratio, the release action -- an actionable refusal, not an
  // empty result and not a silent downgrade to another model.
  expect(message).toContain("openrouter/deepseekflash");
  expect(message).toContain("4.00x");
  expect(message).toContain("cost release");
  expect((caught as CostAnomalyBlockedError).code).toBe("cost_anomaly_blocked");
});

test("a provider that reports no charge is unmeasured, never silently approved", () => {
  // OpenCode Zen returns token counts and no cost at all. The wrapper drops
  // such responses entirely rather than contributing a ratio of 1, because a
  // scope that reads "normal" claims a check that never happened.
  const detector = new CostAnomalyDetector();
  expect(detector.status("openrouter", "deepseekflash")).toEqual({
    state: "no_charge_data",
    acceptedRatio: 1,
  });
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
});

test("a block is per scope: another model keeps running", () => {
  const detector = new CostAnomalyDetector();
  settle(detector);
  detector.observe(at(4));
  detector.observe(at(4));

  expect(() => detector.admit("openrouter", "deepseekflash")).toThrow(CostAnomalyBlockedError);
  expect(() => detector.admit("openrouter", "glm53flash")).not.toThrow();
  expect(() => detector.admit("anthropic", "deepseekflash")).not.toThrow();
});

test("a refusal is replayed once, and never charged to a later run or another scope", () => {
  const detector = new CostAnomalyDetector();
  settle(detector);
  detector.observe(at(4));
  detector.observe(at(4));

  // The blocked scope refuses, and the stashed refusal is what the runner
  // replays after the harness swallows the throw.
  expect(() => detector.admit("openrouter", "deepseekflash")).toThrow(CostAnomalyBlockedError);
  expect(() => detector.assertNoBoundaryFailure()).toThrow(CostAnomalyBlockedError);
  // Replayed ONCE: the refusal answered the run it refused. A second replay
  // would blame whatever ran next for a block that was never about it.
  expect(() => detector.assertNoBoundaryFailure()).not.toThrow();

  // A different model is not implicated by another scope's block, and the
  // detector is long-lived, so the stale refusal must not survive into it.
  expect(() => detector.admit("openrouter", "glm53flash")).not.toThrow();
  expect(() => detector.assertNoBoundaryFailure()).not.toThrow();

  // And after the operator accepts the new price, the released scope runs.
  expect(() => detector.admit("openrouter", "deepseekflash")).toThrow(CostAnomalyBlockedError);
  detector.release("openrouter", "deepseekflash");
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
  expect(() => detector.assertNoBoundaryFailure()).not.toThrow();
});

test("a block and a release survive on disk, so a later process sees and can lift them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-anomaly-"));
  try {
    const overcharge = (detector: CostAnomalyDetector): void => {
      settle(detector);
      detector.observe(at(4));
      detector.observe(at(4));
    };
    overcharge(new CostAnomalyDetector({}, new FileCostAnomalyStore(dir)));

    // A SEPARATE detector over the same directory -- what the next invocation
    // of the CLI is -- still refuses the scope. An in-memory store would have
    // forgotten the block the moment the blocked run exited.
    const reopened = new CostAnomalyDetector({}, new FileCostAnomalyStore(dir));
    expect(reopened.blocked().map((entry) => entry.model)).toEqual(["deepseekflash"]);
    expect(() => reopened.admit("openrouter", "deepseekflash")).toThrow(CostAnomalyBlockedError);

    // Nothing but names and numbers is written where an operator can read it.
    const raw = fs.readFileSync(path.join(dir, COST_ANOMALY_STATE_PATH), "utf8");
    for (const secret of ["sk-", "Authorization", "apiKey", "prompt", "http"])
      expect(raw).not.toContain(secret);

    // And the accepted price is durable too, not just the lifting of the block:
    // a restart must not re-trip on the price the operator already accepted.
    reopened.release("openrouter", "deepseekflash");
    const afterRelease = new CostAnomalyDetector({}, new FileCostAnomalyStore(dir));
    expect(afterRelease.blocked()).toEqual([]);
    expect(() => afterRelease.admit("openrouter", "deepseekflash")).not.toThrow();
    afterRelease.observe(at(4));
    afterRelease.observe(at(4));
    expect(() => afterRelease.admit("openrouter", "deepseekflash")).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable or corrupt state file costs history, never a false all-clear", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-anomaly-"));
  try {
    // No file at all: a first run in a fresh project, not an error.
    expect(new FileCostAnomalyStore(dir).load()).toBeUndefined();

    // Garbage, and a well-formed document of the WRONG version, are both
    // discarded rather than half-read into scopes the detector cannot use.
    const file = path.join(dir, COST_ANOMALY_STATE_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    expect(new FileCostAnomalyStore(dir).load()).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ version: 2, scopes: {} }));
    expect(new FileCostAnomalyStore(dir).load()).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ version: 1, scopes: null }));
    expect(new FileCostAnomalyStore(dir).load()).toBeUndefined();

    // A detector over the bad file starts clean rather than throwing.
    expect(() =>
      new CostAnomalyDetector({}, new FileCostAnomalyStore(dir)).admit("openrouter", "x"),
    ).not.toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an overcharge cannot raise the bar it is measured against", () => {
  // THE SELF-SILENCING HAZARD, in the form it can still take here: the
  // reference must not drift toward whatever is being billed, or a reprice
  // arriving in small steps would be absorbed one acceptable-looking step at a
  // time. Only an explicit release moves it.
  const detector = new CostAnomalyDetector({ confirmingObservations: 5 });
  settle(detector);
  for (let index = 0; index < 4; index += 1) detector.observe(at(3));

  expect(detector.status("openrouter", "deepseekflash")).toMatchObject({
    state: "watching",
    pending: 4,
    acceptedRatio: 1,
  });
  // The fifth still confirms at the full ratio, undiminished by the four
  // before it.
  expect(detector.observe(at(3))?.ratio).toBeCloseTo(3, 5);
});

test("a release accepts that price for that scope, and never lowers the bar later", () => {
  const detector = new CostAnomalyDetector();
  settle(detector);
  detector.observe(at(4));
  detector.observe(at(4));
  expect(() => detector.admit("openrouter", "deepseekflash")).toThrow();

  const released = detector.release("openrouter", "deepseekflash");
  expect(released?.ratio).toBeCloseTo(4, 5);
  expect(detector.status("openrouter", "deepseekflash")).toMatchObject({ acceptedRatio: 4 });

  // The accepted price is now normal. Without recording it, these would
  // immediately re-trip and the release would be worthless.
  detector.observe(at(4));
  detector.observe(at(4));
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();

  // And billing LESS than the accepted price does not quietly re-arm the
  // detector at the lower number: the operator accepted 4x, so 4x stays
  // acceptable until they say otherwise.
  for (let index = 0; index < 5; index += 1) detector.observe(at(1));
  detector.observe(at(4));
  detector.observe(at(4));
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();

  // Above the accepted price, it blocks again.
  detector.observe(at(9));
  expect(detector.observe(at(9))).toBeDefined();
  expect(() => detector.admit("openrouter", "deepseekflash")).toThrow(CostAnomalyBlockedError);
});

test("releasing one scope never releases another", () => {
  const detector = new CostAnomalyDetector();
  const overcharge = (provider: string, model: string): void => {
    for (let index = 0; index < 5; index += 1)
      detector.observe({ provider, model, chargedUsd: 0.002, expectedUsd: 0.002 });
    for (let index = 0; index < 2; index += 1)
      detector.observe({ provider, model, chargedUsd: 0.008, expectedUsd: 0.002 });
  };
  overcharge("openrouter", "a");
  overcharge("openrouter", "b");
  expect(
    detector
      .blocked()
      .map((entry) => entry.model)
      .sort(),
  ).toEqual(["a", "b"]);

  detector.release("openrouter", "a");
  expect(detector.blocked().map((entry) => entry.model)).toEqual(["b"]);
  expect(() => detector.admit("openrouter", "b")).toThrow(CostAnomalyBlockedError);
});

test("a block survives a restart, and so does an accepted price", () => {
  const store = new MemoryCostAnomalyStore();
  const first = new CostAnomalyDetector({}, store);
  settle(first);
  first.observe(at(4));
  first.observe(at(4));

  // A fresh process, same store: the block is still there. Otherwise a restart
  // is a free bypass of the operator's decision.
  const restarted = new CostAnomalyDetector({}, store);
  expect(() => restarted.admit("openrouter", "deepseekflash")).toThrow(CostAnomalyBlockedError);
  expect(restarted.blocked()).toHaveLength(1);

  restarted.release("openrouter", "deepseekflash");
  const afterRelease = new CostAnomalyDetector({}, store);
  expect(() => afterRelease.admit("openrouter", "deepseekflash")).not.toThrow();
  expect(afterRelease.status("openrouter", "deepseekflash")).toMatchObject({ acceptedRatio: 4 });
});

test("a blocked scope cannot deepen or lift its own block by observing", () => {
  const detector = new CostAnomalyDetector();
  settle(detector);
  detector.observe(at(4));
  const block = detector.observe(at(4));

  // An in-flight stage still settles after the block -- its money was already
  // committed -- but nothing it reports changes the operator's decision.
  detector.observe(at(1));
  detector.observe(at(1));
  detector.observe(at(1));
  const status = detector.status("openrouter", "deepseekflash");
  expect(status).toEqual({ state: "blocked", block: block as NonNullable<typeof block> });
  expect(() => detector.admit("openrouter", "deepseekflash")).toThrow();
});

test("disabled means silent and never blocking, and is never a side effect", () => {
  const detector = new CostAnomalyDetector({ enabled: false });
  settle(detector);
  expect(detector.observe(at(50))).toBeUndefined();
  expect(detector.observe(at(50))).toBeUndefined();
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
  expect(detector.status("openrouter", "deepseekflash")).toEqual({ state: "disabled" });
  // The default is ON: disabling took an explicit flag.
  expect(DEFAULT_COST_ANOMALY_CONFIG.enabled).toBe(true);
});

test("a response a ratio cannot be computed from is ignored, not treated as free or infinite", () => {
  const detector = new CostAnomalyDetector();
  const provider = "openrouter";
  const model = "deepseekflash";
  // A response the provider reported no charge for, and a free model the price
  // list expects nothing for, say nothing about whether a price rose -- and
  // dividing by the second manufactures an infinity that outranks every real
  // ratio.
  detector.observe({ provider, model, chargedUsd: 0, expectedUsd: 0.002 });
  detector.observe({ provider, model, chargedUsd: 0.002, expectedUsd: 0 });
  detector.observe({ provider, model, chargedUsd: Number.NaN, expectedUsd: 0.002 });
  detector.observe({ provider, model, chargedUsd: -1, expectedUsd: 0.002 });
  expect(detector.status(provider, model).state).toBe("no_charge_data");
});

test("a nonsensical configuration is refused rather than silently repaired", () => {
  // A threshold at or below 1 would block on any normal reading; a single
  // confirming observation would block on one artifact. Both are the kind of
  // setting that looks plausible and destroys the behavior.
  expect(() => new CostAnomalyDetector({ thresholdRatio: 1 })).toThrow(TypeError);
  expect(() => new CostAnomalyDetector({ thresholdRatio: 0.5 })).toThrow(TypeError);
  expect(() => new CostAnomalyDetector({ confirmingObservations: 1 })).toThrow(TypeError);
});

test("nothing but names and numbers reaches a projection of an anomaly", () => {
  const store = new MemoryCostAnomalyStore();
  const detector = new CostAnomalyDetector({}, store);
  settle(detector);
  detector.observe(at(4));
  detector.observe(at(4));

  let caught: unknown;
  try {
    detector.admit("openrouter", "deepseekflash");
  } catch (error) {
    caught = error;
  }
  const projected = [
    (caught as Error).message,
    JSON.stringify(store.load()),
    JSON.stringify(detector.blocked()),
    JSON.stringify(detector.status("openrouter", "deepseekflash")),
  ].join("\n");

  // Only provider, model, amounts, ratio, counts and a timestamp -- the whole
  // serialised state is checked, not just the message.
  for (const forbidden of ["sk-", "Authorization", "prompt", "apiKey", "http"])
    expect(projected).not.toContain(forbidden);
  expect(JSON.parse(JSON.stringify(detector.blocked()[0]?.block ?? {})).at).toBeNumber();
});
