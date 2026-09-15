import { expect, test } from "bun:test";
import {
  CostAnomalyBlockedError,
  CostAnomalyDetector,
  DEFAULT_COST_ANOMALY_CONFIG,
  MemoryCostAnomalyStore,
} from "../src/economics/cost-anomaly";

/** One settled response at a given dollars-per-token rate. */
function at(
  rate: number,
  tokens = 1000,
): {
  provider: string;
  model: string;
  costUsd: number;
  totalTokens: number;
} {
  return {
    provider: "openrouter",
    model: "deepseekflash",
    costUsd: rate * tokens,
    totalTokens: tokens,
  };
}

test("a first observation establishes a baseline and can never itself be a spike", () => {
  const detector = new CostAnomalyDetector();
  // Even an absurd rate, arriving first, has nothing to be measured against.
  expect(detector.observe(at(1))).toBeUndefined();
  expect(detector.status("openrouter", "deepseekflash")).toEqual({
    state: "insufficient_evidence",
    samples: 1,
    required: DEFAULT_COST_ANOMALY_CONFIG.minBaselineSamples,
  });
  // And it does not block a run.
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
});

test("a thin baseline reports insufficient evidence rather than a verdict", () => {
  const detector = new CostAnomalyDetector({ minBaselineSamples: 5 });
  for (let index = 0; index < 4; index += 1) detector.observe(at(0.000001));
  // Four samples, then a 10x rate: still silent, because guessing from a thin
  // baseline is exactly what the contract forbids.
  expect(detector.observe(at(0.00001))).toBeUndefined();
  expect(detector.observe(at(0.00001))).toBeUndefined();
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
});

test("a run that is merely larger is not a spike; the same work at a higher rate is", () => {
  const detector = new CostAnomalyDetector();
  for (let index = 0; index < 5; index += 1) detector.observe(at(0.000002));

  // Fifty times the tokens at the SAME rate -- fifty times the money. Not an anomaly.
  expect(detector.observe(at(0.000002, 50_000))).toBeUndefined();
  expect(detector.status("openrouter", "deepseekflash").state).toBe("normal");

  // A third of the tokens at three times the rate -- LESS money than the run
  // above, and this is the anomaly. A per-run total would have it backwards.
  expect(detector.observe(at(0.000006, 300))).toBeUndefined();
  const block = detector.observe(at(0.000006, 300));
  expect(block).toBeDefined();
  expect(block?.ratio).toBeCloseTo(3, 5);
});

test("a single over-threshold reading never blocks, and a return to normal discards it", () => {
  const detector = new CostAnomalyDetector();
  for (let index = 0; index < 5; index += 1) detector.observe(at(0.000002));

  expect(detector.observe(at(0.00001))).toBeUndefined();
  expect(detector.status("openrouter", "deepseekflash")).toMatchObject({
    state: "watching",
    pending: 1,
    required: 2,
  });
  // Back to normal: the artifact is discarded, not banked toward a later
  // false confirmation hours away.
  detector.observe(at(0.000002));
  expect(detector.status("openrouter", "deepseekflash").state).toBe("normal");
  // So a fresh single spike still does not block.
  expect(detector.observe(at(0.00001))).toBeUndefined();
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
});

test("a confirmed spike blocks new runs and names every number the operator needs", () => {
  const detector = new CostAnomalyDetector({}, undefined, () => 1_600_000_000_000);
  for (let index = 0; index < 5; index += 1) detector.observe(at(0.000002));
  detector.observe(at(0.000008));
  const block = detector.observe(at(0.000008));

  expect(block).toBeDefined();
  expect(block?.ratio).toBeCloseTo(4, 5);
  expect(block?.baselineRateUsdPerToken).toBeCloseTo(0.000002, 12);
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

test("a block is per scope: another model keeps running", () => {
  const detector = new CostAnomalyDetector();
  for (let index = 0; index < 5; index += 1) detector.observe(at(0.000002));
  detector.observe(at(0.000008));
  detector.observe(at(0.000008));

  expect(() => detector.admit("openrouter", "deepseekflash")).toThrow(CostAnomalyBlockedError);
  expect(() => detector.admit("openrouter", "glm53flash")).not.toThrow();
  expect(() => detector.admit("anthropic", "deepseekflash")).not.toThrow();
});

test("a spike never folds into the baseline it is measured against", () => {
  // THE SELF-SILENCING HAZARD. If over-threshold rates joined the baseline, the
  // baseline would climb toward the new price and the detector would stop
  // reporting exactly when it matters -- the alarm teaching itself not to ring.
  const detector = new CostAnomalyDetector({ confirmingObservations: 5, baselineWindow: 6 });
  for (let index = 0; index < 5; index += 1) detector.observe(at(0.000002));
  const before = detector.status("openrouter", "deepseekflash");

  // Four consecutive 10x readings -- more than the baseline sample count, so a
  // baseline that absorbed them would be dominated by them.
  for (let index = 0; index < 4; index += 1) detector.observe(at(0.00002));
  const after = detector.status("openrouter", "deepseekflash");

  expect(after).toMatchObject({ state: "watching", pending: 4 });
  expect((after as { baselineRateUsdPerToken: number }).baselineRateUsdPerToken).toBe(
    (before as { baselineRateUsdPerToken: number }).baselineRateUsdPerToken,
  );
  // And the fifth still confirms at the full ratio.
  expect(detector.observe(at(0.00002))?.ratio).toBeCloseTo(10, 5);
});

test("the baseline is a median, so one outlier cannot mask a later spike", () => {
  const detector = new CostAnomalyDetector({ minBaselineSamples: 5, baselineWindow: 5 });
  // Four normal rates and one freak reading 100x higher.
  for (let index = 0; index < 4; index += 1) detector.observe(at(0.000002));
  detector.observe(at(0.0002));

  // A MEAN baseline here would be ~0.0000424, and a genuine 3x spike to
  // 0.000006 would measure as 0.14x -- silently under threshold. The median is
  // 0.000002, so the spike measures at its real size.
  detector.observe(at(0.000006));
  expect(detector.observe(at(0.000006))?.ratio).toBeCloseTo(3, 5);
});

test("a release re-baselines that one scope so the accepted price does not re-trip", () => {
  const detector = new CostAnomalyDetector();
  for (let index = 0; index < 5; index += 1) detector.observe(at(0.000002));
  detector.observe(at(0.000008));
  detector.observe(at(0.000008));
  expect(() => detector.admit("openrouter", "deepseekflash")).toThrow();

  const released = detector.release("openrouter", "deepseekflash");
  expect(released?.ratio).toBeCloseTo(4, 5);
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();

  // The accepted price is now normal. Without re-baselining, these would
  // immediately re-trip against the old baseline and the release would be
  // worthless.
  detector.observe(at(0.000008));
  detector.observe(at(0.000008));
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
});

test("releasing one scope never releases another", () => {
  const detector = new CostAnomalyDetector();
  const spike = (provider: string, model: string): void => {
    for (let index = 0; index < 5; index += 1)
      detector.observe({ provider, model, costUsd: 0.002, totalTokens: 1000 });
    for (let index = 0; index < 2; index += 1)
      detector.observe({ provider, model, costUsd: 0.008, totalTokens: 1000 });
  };
  spike("openrouter", "a");
  spike("openrouter", "b");
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
  for (let index = 0; index < 5; index += 1) first.observe(at(0.000002));
  first.observe(at(0.000008));
  first.observe(at(0.000008));

  // A fresh process, same store: the block is still there. Otherwise a restart
  // is a free bypass of the operator's decision.
  const restarted = new CostAnomalyDetector({}, store);
  expect(() => restarted.admit("openrouter", "deepseekflash")).toThrow(CostAnomalyBlockedError);
  expect(restarted.blocked()).toHaveLength(1);

  restarted.release("openrouter", "deepseekflash");
  const afterRelease = new CostAnomalyDetector({}, store);
  expect(() => afterRelease.admit("openrouter", "deepseekflash")).not.toThrow();
  expect(afterRelease.status("openrouter", "deepseekflash").state).not.toBe("blocked");
});

test("a blocked scope cannot deepen or lift its own block by observing", () => {
  const detector = new CostAnomalyDetector();
  for (let index = 0; index < 5; index += 1) detector.observe(at(0.000002));
  detector.observe(at(0.000008));
  const block = detector.observe(at(0.000008));

  // An in-flight stage still settles after the block -- its money was already
  // committed -- but nothing it reports changes the operator's decision.
  detector.observe(at(0.000002));
  detector.observe(at(0.000002));
  detector.observe(at(0.000002));
  const status = detector.status("openrouter", "deepseekflash");
  expect(status).toEqual({ state: "blocked", block: block! });
  expect(() => detector.admit("openrouter", "deepseekflash")).toThrow();
});

test("disabled means silent and never blocking, and is never a side effect", () => {
  const detector = new CostAnomalyDetector({ enabled: false });
  for (let index = 0; index < 5; index += 1) detector.observe(at(0.000002));
  expect(detector.observe(at(0.001))).toBeUndefined();
  expect(detector.observe(at(0.001))).toBeUndefined();
  expect(() => detector.admit("openrouter", "deepseekflash")).not.toThrow();
  expect(detector.status("openrouter", "deepseekflash")).toEqual({ state: "disabled" });
  // The default is ON: disabling took an explicit flag.
  expect(DEFAULT_COST_ANOMALY_CONFIG.enabled).toBe(true);
});

test("a response a rate cannot be computed from is ignored, not treated as free or infinite", () => {
  const detector = new CostAnomalyDetector({ minBaselineSamples: 2 });
  const provider = "openrouter";
  const model = "deepseekflash";
  // A cache-only turn legitimately costs nothing; zero tokens would divide by
  // zero. Neither says anything about price, and either would outrank every
  // real rate if admitted.
  detector.observe({ provider, model, costUsd: 0, totalTokens: 1000 });
  detector.observe({ provider, model, costUsd: 0.002, totalTokens: 0 });
  detector.observe({ provider, model, costUsd: Number.NaN, totalTokens: 1000 });
  detector.observe({ provider, model, costUsd: -1, totalTokens: 1000 });
  expect(detector.status(provider, model)).toMatchObject({ samples: 0 });
});

test("a nonsensical configuration is refused rather than silently repaired", () => {
  // A threshold at or below 1 would block on any normal reading; a single
  // confirming observation would block on one artifact. Both are the kind of
  // setting that looks plausible and destroys the behavior.
  expect(() => new CostAnomalyDetector({ thresholdRatio: 1 })).toThrow(TypeError);
  expect(() => new CostAnomalyDetector({ thresholdRatio: 0.5 })).toThrow(TypeError);
  expect(() => new CostAnomalyDetector({ confirmingObservations: 1 })).toThrow(TypeError);
  expect(() => new CostAnomalyDetector({ minBaselineSamples: 0 })).toThrow(TypeError);
  expect(() => new CostAnomalyDetector({ baselineWindow: 3, minBaselineSamples: 5 })).toThrow(
    TypeError,
  );
});

test("nothing but names and numbers reaches a projection of an anomaly", () => {
  const store = new MemoryCostAnomalyStore();
  const detector = new CostAnomalyDetector({}, store);
  for (let index = 0; index < 5; index += 1) detector.observe(at(0.000002));
  detector.observe(at(0.000008));
  detector.observe(at(0.000008));

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

  // Only provider, model, rates, ratio, counts and a timestamp -- the whole
  // serialised state is checked, not just the message.
  for (const forbidden of ["sk-", "Authorization", "prompt", "apiKey", "http"])
    expect(projected).not.toContain(forbidden);
  expect(JSON.parse(JSON.stringify(detector.blocked()[0]?.block ?? {})).at).toBeNumber();
});
