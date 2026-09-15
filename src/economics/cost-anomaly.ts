import type { AssistantMessage, Models } from "@earendil-works/pi-ai";

/**
 * Detection of a STEP CHANGE in what a model charges, and the block that keeps
 * an unattended session from paying it over and over.
 *
 * The failure this exists for is not a large run and not a slow drift in a
 * monthly bill: per-stage `maxCostUsd` already bounds the first, and nothing
 * mechanical can decide the second. It is a provider repricing a model, a
 * preset rerouting to a costlier backend, or a cache that stopped being hit --
 * each individual run stays comfortably under its own ceiling while every one
 * of them costs several times what the same work cost yesterday.
 *
 * So the observable here is the RATE, not the total. A run that is simply
 * bigger than the last one is not an anomaly; the same work at a higher rate
 * is. See `docs/contracts/cost-anomaly.md`.
 */

/** Cost per token for one settled response: the observable the whole module is built on. */
export interface CostRateObservation {
  provider: string;
  model: string;
  /** Provider-reported dollars for this one response. */
  costUsd: number;
  /** Provider-reported tokens for this one response. */
  totalTokens: number;
}

export interface CostAnomalyConfig {
  /** Default ON. Disabling is an explicit operator choice, never a side effect. */
  enabled: boolean;
  /** Observed rate over baseline rate that counts as a spike. */
  thresholdRatio: number;
  /** Below this many settled observations a scope reports insufficient evidence, never a verdict. */
  minBaselineSamples: number;
  /** How many consecutive over-threshold observations confirm a spike. Never 1. */
  confirmingObservations: number;
  /** How many recent settled observations the baseline is computed from. */
  baselineWindow: number;
}

export const DEFAULT_COST_ANOMALY_CONFIG: Readonly<CostAnomalyConfig> = Object.freeze({
  enabled: true,
  thresholdRatio: 2,
  minBaselineSamples: 5,
  confirmingObservations: 2,
  baselineWindow: 20,
});

/**
 * One scope's durable state: rates and counts, no identifiers beyond the
 * provider and model NAMES that define the scope.
 *
 * `baseline` holds only rates judged normal when they arrived. An
 * over-threshold rate is held in `pending` instead, and that separation is
 * load-bearing: folding a spike into the baseline it is measured against would
 * raise the baseline toward the spike and silence the detector exactly when it
 * is needed -- the alarm would teach itself to stop ringing.
 */
export interface CostAnomalyScopeState {
  provider: string;
  model: string;
  baseline: number[];
  pending: number[];
  block?: CostAnomalyBlock;
}

/** What was observed when a scope was blocked. Numbers and names only; safe to persist and to show. */
export interface CostAnomalyBlock {
  at: number;
  baselineRateUsdPerToken: number;
  observedRateUsdPerToken: number;
  ratio: number;
  confirmingObservations: number;
}

export interface CostAnomalyStateSnapshot {
  version: 1;
  scopes: Record<string, CostAnomalyScopeState>;
}

/** Where scope state survives a restart. Injected exactly like `LedgerSink`. */
export interface CostAnomalyStore {
  load(): CostAnomalyStateSnapshot | undefined;
  save(snapshot: CostAnomalyStateSnapshot): void;
}

export class MemoryCostAnomalyStore implements CostAnomalyStore {
  private snapshot: CostAnomalyStateSnapshot | undefined;

  load(): CostAnomalyStateSnapshot | undefined {
    return this.snapshot;
  }

  save(snapshot: CostAnomalyStateSnapshot): void {
    this.snapshot = structuredClone(snapshot);
  }
}

/**
 * The refusal a blocked scope raises instead of starting a run.
 *
 * Carries the scope, the two rates, the ratio and the release action -- every
 * number the operator needs to decide -- and nothing else. No prompt, no
 * credential, no provider response body.
 */
export class CostAnomalyBlockedError extends Error {
  override readonly name = "CostAnomalyBlockedError";
  readonly code = "cost_anomaly_blocked" as const;

  constructor(
    readonly provider: string,
    readonly model: string,
    readonly block: Readonly<CostAnomalyBlock>,
  ) {
    super(
      `${provider}/${model} is charging ${block.ratio.toFixed(2)}x its recent rate ` +
        `(${formatRate(block.observedRateUsdPerToken)} against a baseline of ` +
        `${formatRate(block.baselineRateUsdPerToken)} per token, confirmed by ` +
        `${block.confirmingObservations} settled responses); new runs on this model are blocked ` +
        "until released -- accept the new price with `ad-coder cost release " +
        `${provider}/${model}\`, or route this role to another model`,
    );
  }
}

/** Dollars per token are small enough that toFixed(2) reads as "0.00" for every model. */
function formatRate(rate: number): string {
  return `$${rate.toPrecision(3)}`;
}

/** What a scope currently reports, for a front to render. Never a decision a front makes itself. */
export type CostAnomalyStatus =
  | { state: "disabled" }
  | { state: "insufficient_evidence"; samples: number; required: number }
  | { state: "normal"; baselineRateUsdPerToken: number; samples: number }
  | { state: "watching"; baselineRateUsdPerToken: number; pending: number; required: number }
  | { state: "blocked"; block: Readonly<CostAnomalyBlock> };

function assertConfig(config: CostAnomalyConfig): void {
  if (!Number.isFinite(config.thresholdRatio) || config.thresholdRatio <= 1)
    throw new TypeError("thresholdRatio must be greater than 1");
  if (!Number.isInteger(config.minBaselineSamples) || config.minBaselineSamples < 1)
    throw new TypeError("minBaselineSamples must be a positive integer");
  // A single reading never blocks: providers report incomplete usage, and one
  // anomalous number is an artifact until it repeats.
  if (!Number.isInteger(config.confirmingObservations) || config.confirmingObservations < 2)
    throw new TypeError("confirmingObservations must be at least 2");
  if (!Number.isInteger(config.baselineWindow) || config.baselineWindow < 1)
    throw new TypeError("baselineWindow must be a positive integer");
  if (config.baselineWindow < config.minBaselineSamples)
    throw new TypeError("baselineWindow must be at least minBaselineSamples");
}

/**
 * MEDIAN, not mean. The baseline must describe what the model normally charges,
 * and a mean is dragged toward any single outlier that reached the window --
 * including the leading edge of the very repricing being detected, which would
 * shrink the measured ratio and could push a genuine spike back under the
 * threshold.
 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2) as number;
}

export function costAnomalyScopeKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * The detector. Headless: it decides, and a CLI or console renders what it
 * decided. A front must not carry its own threshold and must not be able to
 * start a run this refused.
 */
export class CostAnomalyDetector {
  readonly config: Readonly<CostAnomalyConfig>;
  private readonly scopes = new Map<string, CostAnomalyScopeState>();
  private boundaryFailure: CostAnomalyBlockedError | undefined;

  constructor(
    config: Partial<CostAnomalyConfig> = {},
    private readonly store?: CostAnomalyStore,
    private readonly now: () => number = () => Date.now(),
  ) {
    const resolved = { ...DEFAULT_COST_ANOMALY_CONFIG, ...config };
    assertConfig(resolved);
    this.config = Object.freeze(resolved);
    const loaded = this.store?.load();
    if (loaded !== undefined)
      for (const [key, state] of Object.entries(loaded.scopes))
        this.scopes.set(key, structuredClone(state));
  }

  /**
   * Refuse to START a run on a blocked scope.
   *
   * Only a start. Work already in flight is never killed: the money for the
   * current response is committed the moment the request leaves, and aborting
   * mid-stage spends it without buying the result.
   */
  admit(provider: string, model: string): void {
    if (!this.config.enabled) return;
    const state = this.scopes.get(costAnomalyScopeKey(provider, model));
    if (state?.block === undefined) return;
    const error = new CostAnomalyBlockedError(provider, model, state.block);
    // Retained because the harness CATCHES a throw at the Models boundary and
    // re-reports it as its own generic storage/invariant fault, which would
    // reach the operator as an unexplained crash instead of a priced refusal.
    // The caller replays this typed error afterwards; the same reason
    // `SessionLimitController` keeps one.
    this.boundaryFailure = error;
    throw error;
  }

  /** Replay a boundary refusal the harness converted into a generic fault. */
  assertNoBoundaryFailure(): void {
    if (this.boundaryFailure !== undefined) throw this.boundaryFailure;
  }

  /**
   * Fold one settled response into its scope, and block if this confirms a spike.
   *
   * Returns the block when THIS observation confirmed one, so a caller can warn
   * the operator at the moment it happened rather than polling.
   */
  observe(observation: CostRateObservation): CostAnomalyBlock | undefined {
    if (!this.config.enabled) return undefined;
    const { provider, model, costUsd, totalTokens } = observation;
    // Only numbers the provider actually returned, and only ones a rate can be
    // computed from. A zero-token or zero-cost response says nothing about
    // price -- a cached-only turn legitimately costs nothing -- and dividing by
    // it would manufacture an infinity or a zero that outranks every real rate.
    if (!Number.isFinite(costUsd) || costUsd <= 0) return undefined;
    if (!Number.isInteger(totalTokens) || totalTokens <= 0) return undefined;

    const key = costAnomalyScopeKey(provider, model);
    const state = this.scopes.get(key) ?? { provider, model, baseline: [], pending: [] };
    this.scopes.set(key, state);
    const rate = costUsd / totalTokens;

    // A blocked scope keeps observing -- an in-flight stage still settles --
    // but nothing it reports can deepen or lift its own block. Only an
    // operator release does that.
    if (state.block !== undefined) {
      this.persist();
      return undefined;
    }

    // A first observation establishes a baseline and can never itself be a
    // spike: there is nothing to compare it against.
    if (state.baseline.length < this.config.minBaselineSamples) {
      state.baseline.push(rate);
      this.trim(state);
      this.persist();
      return undefined;
    }

    const baselineRate = median(state.baseline);
    const ratio = baselineRate > 0 ? rate / baselineRate : 0;
    if (ratio < this.config.thresholdRatio) {
      // Normal again. A run of over-threshold readings that did not reach the
      // confirming count was an artifact, so it is discarded rather than left
      // to accumulate across unrelated hours into a false confirmation.
      state.pending.length = 0;
      state.baseline.push(rate);
      this.trim(state);
      this.persist();
      return undefined;
    }

    state.pending.push(rate);
    if (state.pending.length < this.config.confirmingObservations) {
      this.persist();
      return undefined;
    }

    const block: CostAnomalyBlock = {
      at: this.now(),
      baselineRateUsdPerToken: baselineRate,
      // The confirming rates, not just the last one: the median of what was
      // actually charged while the alarm was being confirmed.
      observedRateUsdPerToken: median(state.pending),
      ratio: median(state.pending) / baselineRate,
      confirmingObservations: state.pending.length,
    };
    state.block = block;
    this.persist();
    return block;
  }

  /**
   * The operator accepting the new price for ONE scope.
   *
   * Re-baselines to the rates that tripped it, because a permanent reprice is a
   * fact to accept once, not an alarm to dismiss on every subsequent run --
   * without this, the next response would re-trip against the old baseline
   * immediately. Per-scope on purpose: releasing one model never releases
   * another that happens to have spiked at the same time.
   */
  release(provider: string, model: string): Readonly<CostAnomalyBlock> | undefined {
    const key = costAnomalyScopeKey(provider, model);
    const state = this.scopes.get(key);
    if (state?.block === undefined) return undefined;
    const released = state.block;
    delete state.block;
    state.baseline = [...state.pending];
    state.pending = [];
    this.persist();
    return released;
  }

  status(provider: string, model: string): CostAnomalyStatus {
    if (!this.config.enabled) return { state: "disabled" };
    const state = this.scopes.get(costAnomalyScopeKey(provider, model));
    if (state?.block !== undefined) return { state: "blocked", block: state.block };
    const samples = state?.baseline.length ?? 0;
    if (samples < this.config.minBaselineSamples)
      return {
        state: "insufficient_evidence",
        samples,
        required: this.config.minBaselineSamples,
      };
    const baselineRateUsdPerToken = median((state as CostAnomalyScopeState).baseline);
    const pending = state?.pending.length ?? 0;
    if (pending > 0)
      return {
        state: "watching",
        baselineRateUsdPerToken,
        pending,
        required: this.config.confirmingObservations,
      };
    return { state: "normal", baselineRateUsdPerToken, samples };
  }

  /** Every blocked scope, for a front that lists what is waiting on the operator. */
  blocked(): Array<{ provider: string; model: string; block: Readonly<CostAnomalyBlock> }> {
    return [...this.scopes.values()]
      .filter((state) => state.block !== undefined)
      .map((state) => ({
        provider: state.provider,
        model: state.model,
        block: state.block as CostAnomalyBlock,
      }));
  }

  snapshot(): CostAnomalyStateSnapshot {
    return { version: 1, scopes: Object.fromEntries(structuredClone([...this.scopes])) };
  }

  /**
   * Wrap the same `Models` admission boundary the session limits use, so a
   * blocked scope refuses at the one seam every generation path goes through
   * and no front can start a run around it.
   */
  wrap(models: Models, provider: string, model: string): Models {
    const detector = this;
    const promiseMethods = new Set(["complete", "completeSimple", "fetchDeferred"]);
    const streamMethods = new Set(["stream", "streamSimple", "streamDeferred"]);
    const settle = (message: AssistantMessage | undefined): void => {
      const usage = message?.usage;
      if (usage === undefined) return;
      detector.observe({
        provider,
        model,
        costUsd: usage.cost.total,
        totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
      });
    };
    return new Proxy(models, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || typeof value !== "function") return value;
        if (promiseMethods.has(property)) {
          return (...args: unknown[]) => {
            try {
              detector.admit(provider, model);
            } catch (error) {
              return Promise.reject(error);
            }
            const operation = Reflect.apply(value, target, args) as Promise<AssistantMessage>;
            return operation.then((message) => {
              settle(message);
              return message;
            });
          };
        }
        if (streamMethods.has(property)) {
          return (...args: unknown[]) => {
            detector.admit(provider, model);
            const stream = Reflect.apply(value, target, args) as {
              result(): Promise<AssistantMessage>;
            };
            void stream.result().then(settle, () => undefined);
            return stream;
          };
        }
        return value;
      },
    });
  }

  private trim(state: CostAnomalyScopeState): void {
    const overflow = state.baseline.length - this.config.baselineWindow;
    if (overflow > 0) state.baseline.splice(0, overflow);
  }

  private persist(): void {
    this.store?.save(this.snapshot());
  }
}
