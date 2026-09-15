import * as fs from "node:fs";
import * as path from "node:path";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { type ChargeCapture, instrumentChargedCost } from "./charged-cost";

/**
 * Detection of a PROVIDER CHARGING MORE THAN THE PRICE IT DECLARED, and the
 * block that keeps an unattended session from paying it over and over.
 *
 * The failure this exists for is not a large run and not a slow drift in a
 * monthly bill: per-stage `maxCostUsd` already bounds the first, and nothing
 * mechanical can decide the second. It is a provider repricing a model, or a
 * preset rerouting to a costlier backend, while every individual run stays
 * comfortably under its own ceiling.
 *
 * THE REFERENCE IS THE DECLARED PRICE, NOT A LEARNED ONE. Two independent
 * reasons, either of which alone would settle it:
 *
 * A learned baseline cannot tell a discount ending from a price rising. A
 * cheap backend that bills half the declared price teaches the baseline that
 * half is normal; when that backend goes away and the next one bills the
 * ordinary price, the baseline sees a doubling and blocks a session that is
 * paying exactly what the operator agreed to. The detector would fire hardest
 * on the most ordinary event there is.
 *
 * And a learned baseline cannot be denominated in anything stable. Dollars per
 * token is not a property of a price: within one price list, output tokens
 * cost multiples of input tokens and input costs multiples of a cache read, so
 * the same price yields rates a hundredfold apart depending only on how much
 * of the turn was cached. Every such swing reads as a spike.
 *
 * Both dissolve when the observable is the RATIO of what the provider actually
 * billed to what the operator's own price list predicts for that exact token
 * mix. Composition cancels -- it is in both halves -- so the ratio moves only
 * when the price does. A discount is a ratio below one and never blocks; a
 * discount ending returns it to one and never blocks; only billing ABOVE the
 * declared price moves it up. See `docs/contracts/cost-anomaly.md`.
 *
 * WHAT THIS CANNOT DO. The billed amount has to come from the provider, and
 * not every provider reports one -- OpenRouter does when asked, OpenCode Zen
 * returns token counts and nothing else. A scope whose provider reports no
 * charge has no evidence, so it reports exactly that and never blocks. It is
 * not the detector's place to manufacture a verdict out of the very price list
 * it is supposed to be checking.
 */

/**
 * One settled response: what the provider billed, and what our own price list
 * says that response should have cost.
 */
export interface CostAnomalyObservation {
  provider: string;
  model: string;
  /** Dollars the PROVIDER reported billing for this one response. */
  chargedUsd: number;
  /** Dollars the operator's declared price list predicts for the same tokens. */
  expectedUsd: number;
}

export interface CostAnomalyConfig {
  /** Default ON. Disabling is an explicit operator choice, never a side effect. */
  enabled: boolean;
  /** Billed-over-declared ratio that counts as overcharging. */
  thresholdRatio: number;
  /** How many consecutive over-threshold observations confirm it. Never 1. */
  confirmingObservations: number;
}

export const DEFAULT_COST_ANOMALY_CONFIG: Readonly<CostAnomalyConfig> = Object.freeze({
  enabled: true,
  // Tight on purpose, and affordable only because the reference is a declared
  // number rather than a learned one. A correctly billed response sits at 1.00
  // whatever its token mix, so the whole 25% is headroom for rounding and for
  // a provider's own minor fees -- not, as under a learned baseline, for the
  // hundredfold swing that composition alone produces.
  thresholdRatio: 1.25,
  confirmingObservations: 2,
});

/**
 * One scope's durable state: ratios and counts, no identifiers beyond the
 * provider and model NAMES that define the scope.
 *
 * `accepted` is the ceiling this scope is currently judged against: 1 until an
 * operator accepts a higher price, then whatever they accepted. It is the only
 * thing here that a run can change, and only through an explicit release --
 * observations never move it. That asymmetry is the whole guarantee: a
 * baseline that learned from traffic would absorb a slow reprice one
 * acceptable-looking step at a time, which is precisely the failure this
 * detector exists to catch.
 *
 * `pending` holds consecutive over-threshold ratios, discarded the moment a
 * normal one arrives, so unrelated one-off readings cannot accumulate across
 * hours into a false confirmation.
 */
export interface CostAnomalyScopeState {
  provider: string;
  model: string;
  /** Ratios of billed to declared for recent responses, most recent last. */
  observed: number[];
  pending: number[];
  /** Dollars billed across the `pending` responses, so a block can report real amounts. */
  pendingChargedUsd?: number;
  /** Dollars the declared price list predicted for those same responses. */
  pendingExpectedUsd?: number;
  /** Billed-over-declared ratio the operator has accepted; absent means 1. */
  accepted?: number;
  block?: CostAnomalyBlock;
}

/** What was observed when a scope was blocked. Numbers and names only; safe to persist and to show. */
export interface CostAnomalyBlock {
  at: number;
  /** Dollars the provider billed across the confirming responses. */
  chargedUsd: number;
  /** Dollars the declared price list predicted for those same responses. */
  expectedUsd: number;
  /** Billed over declared. Above 1 means the provider charged more than declared. */
  ratio: number;
  /** What the scope was judged against: 1, or a previously accepted higher ratio. */
  acceptedRatio: number;
  confirmingObservations: number;
}

export interface CostAnomalyStateSnapshot {
  /**
   * 2 since the reference became the declared price (0.10.0).
   *
   * Version 1 held a LEARNED baseline: scopes carried `baseline` rates and
   * blocks carried `baselineRateUsdPerToken`. Both are gone, and the numbers
   * themselves are meaningless now -- they were dollars-per-token measured
   * against other dollars-per-token, which is the comparison this release
   * exists to abolish. Reading such a file as if it were current is worse
   * than discarding it: a v1 scope has no `observed` array and a v1 block no
   * `chargedUsd`, so the detector would fault on the first observation and,
   * for an already-blocked scope, at the Models boundary every generation
   * passes through. Bumping the tag makes the existing guard discard them.
   */
  version: 2;
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
 * How many recent ratios a scope retains. Not a baseline -- nothing is
 * computed from them -- only enough recent history for a front to show that
 * the scope is being measured at all, bounded so the state file cannot grow
 * without limit.
 */
const OBSERVED_HISTORY = 20;

/** Where a project's cost-anomaly state lives, and nowhere else. */
export const COST_ANOMALY_STATE_PATH = ".ad-coder/cost-anomaly.json";

/**
 * Scope state on disk, so a block and an accepted price survive a restart.
 *
 * WHY A WHOLE-FILE REWRITE rather than the ledger's append-only descriptor:
 * this is current state, not history. A release must ERASE a block, and an
 * append-only log can only record that it happened, leaving the next start to
 * replay a block the operator already lifted.
 *
 * Written through a temp file and renamed, because the alternative -- truncate
 * then write -- leaves an empty file if the process dies between the two, and
 * an empty state file reads as "no blocks" and silently unblocks every scope.
 *
 * Reads are TOLERANT and writes are not: a corrupt or unreadable file yields
 * `undefined`, which costs only recent history, while a failed write
 * throws, because silently not persisting a block is how an unattended session
 * pays the spike again tomorrow.
 */
export class FileCostAnomalyStore implements CostAnomalyStore {
  private readonly filePath: string;

  constructor(targetDir: string) {
    this.filePath = path.resolve(targetDir, COST_ANOMALY_STATE_PATH);
  }

  load(): CostAnomalyStateSnapshot | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as CostAnomalyStateSnapshot;
      // A file from an older, future, or hand-edited shape is discarded
      // rather than half-trusted: a `scopes` that is not an object -- or a
      // version-1 scope whose learned baseline this release no longer
      // understands -- would otherwise reach the detector as entries it
      // cannot read. Discarding costs only recent history; the reference is
      // the declared price and is not learned, so nothing needs rebuilding.
      if (parsed?.version !== 2) return undefined;
      if (typeof parsed.scopes !== "object" || parsed.scopes === null) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  save(snapshot: CostAnomalyStateSnapshot): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
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
      `${provider}/${model} billed ${block.ratio.toFixed(2)}x its declared price ` +
        `(${formatUsd(block.chargedUsd)} charged against ${formatUsd(block.expectedUsd)} ` +
        `expected from the configured price list, confirmed by ` +
        `${block.confirmingObservations} settled responses); new runs on this model are blocked ` +
        "until released -- accept the new price with `ad-coder cost release " +
        `${provider}/${model}\`, or route this role to another model`,
    );
  }
}

/** A single response costs fractions of a cent, so toFixed(2) reads as "$0.00" for all of them. */
function formatUsd(amount: number): string {
  return `$${amount.toPrecision(3)}`;
}

/** What a scope currently reports, for a front to render. Never a decision a front makes itself. */
export type CostAnomalyStatus =
  | { state: "disabled" }
  /**
   * The provider reports no billed amount, so there is nothing to check. NOT a
   * transient state that more traffic resolves: it is a property of the
   * provider, and it stays until that provider starts reporting charges.
   */
  | { state: "no_charge_data"; acceptedRatio: number }
  | { state: "normal"; ratio: number; samples: number; acceptedRatio: number }
  | { state: "watching"; ratio: number; pending: number; required: number; acceptedRatio: number }
  | { state: "blocked"; block: Readonly<CostAnomalyBlock> };

function assertConfig(config: CostAnomalyConfig): void {
  if (!Number.isFinite(config.thresholdRatio) || config.thresholdRatio <= 1)
    throw new TypeError("thresholdRatio must be greater than 1");
  // A single reading never blocks: providers report incomplete usage, and one
  // anomalous number is an artifact until it repeats.
  if (!Number.isInteger(config.confirmingObservations) || config.confirmingObservations < 2)
    throw new TypeError("confirmingObservations must be at least 2");
}

/** Median, not mean, so one extreme reading among the confirming ones cannot set the reported ratio. */
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
    // Cleared FIRST, on every path. The stash below outlives the throw that
    // set it, and this detector is long-lived and shared across every scope a
    // session routes to -- so without this reset, one blocked scope would
    // replay its refusal into the next run on a DIFFERENT model, and into the
    // same model after the operator released it. The refusal must be reachable
    // exactly once, by the call that actually failed.
    this.boundaryFailure = undefined;
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

  /**
   * Replay a boundary refusal the harness converted into a generic fault.
   *
   * Consumes it: a refusal answers the one run it refused. Leaving it set
   * would blame the next run for a block that is not its own -- and the
   * throw here means no later `admit` on this path gets to clear it.
   */
  assertNoBoundaryFailure(): void {
    const error = this.boundaryFailure;
    if (error === undefined) return;
    this.boundaryFailure = undefined;
    throw error;
  }

  /**
   * Fold one settled response into its scope, and block if this confirms that
   * the provider is billing above the price the operator declared.
   *
   * Returns the block when THIS observation confirmed one, so a caller can warn
   * the operator at the moment it happened rather than polling.
   */
  observe(observation: CostAnomalyObservation): CostAnomalyBlock | undefined {
    if (!this.config.enabled) return undefined;
    const { provider, model, chargedUsd, expectedUsd } = observation;
    // Both halves must be real money. A provider that reported no charge is
    // the `no_charge_data` case and must reach no verdict at all; a zero
    // expectation cannot be divided by, and would turn any charge into an
    // infinite ratio -- which is exactly the shape a free-tier model has.
    if (!Number.isFinite(chargedUsd) || chargedUsd <= 0) return undefined;
    if (!Number.isFinite(expectedUsd) || expectedUsd <= 0) return undefined;

    const key = costAnomalyScopeKey(provider, model);
    const state = this.scopes.get(key) ?? { provider, model, observed: [], pending: [] };
    this.scopes.set(key, state);
    const ratio = chargedUsd / expectedUsd;

    // A blocked scope keeps observing -- an in-flight stage still settles --
    // but nothing it reports can deepen or lift its own block. Only an
    // operator release does that.
    if (state.block !== undefined) {
      this.persist();
      return undefined;
    }

    // NO WARM-UP. There is no baseline to accumulate, so the very first
    // response is already checkable against the declared price, and a
    // repricing that is in effect before this project's first run is caught on
    // that first run instead of being silently learned as normal.
    const acceptedRatio = state.accepted ?? 1;
    if (ratio < acceptedRatio * this.config.thresholdRatio) {
      state.pending.length = 0;
      delete state.pendingChargedUsd;
      delete state.pendingExpectedUsd;
      state.observed.push(ratio);
      this.trim(state);
      this.persist();
      return undefined;
    }

    state.pending.push(ratio);
    state.pendingChargedUsd = (state.pendingChargedUsd ?? 0) + chargedUsd;
    state.pendingExpectedUsd = (state.pendingExpectedUsd ?? 0) + expectedUsd;
    if (state.pending.length < this.config.confirmingObservations) {
      this.persist();
      return undefined;
    }

    // The sums over the confirming responses, not one of them: this is what
    // the operator was actually billed while the alarm was being confirmed,
    // and two amounts they can check against their provider invoice.
    const confirming = state.pending.length;
    const block: CostAnomalyBlock = {
      at: this.now(),
      chargedUsd: state.pendingChargedUsd ?? 0,
      expectedUsd: state.pendingExpectedUsd ?? 0,
      ratio: median(state.pending),
      acceptedRatio,
      confirmingObservations: confirming,
    };
    state.block = block;
    this.persist();
    return block;
  }

  /**
   * The operator accepting the new price for ONE scope.
   *
   * Records the confirmed ratio as this scope's accepted ceiling, because a
   * permanent reprice is a fact to accept once, not an alarm to dismiss on
   * every subsequent run -- without this, the next response would re-trip
   * against the declared price immediately. Per-scope on purpose: releasing one
   * model never releases another that happens to have been caught at the same
   * time.
   *
   * Note what accepting does NOT do: it never lowers the ceiling. Accepting a
   * 1.4x price means 1.4x is now tolerated for this model; a later response at
   * 1.0x is simply normal, and does not quietly re-arm the detector at the
   * lower number.
   */
  release(provider: string, model: string): Readonly<CostAnomalyBlock> | undefined {
    const key = costAnomalyScopeKey(provider, model);
    const state = this.scopes.get(key);
    if (state?.block === undefined) return undefined;
    const released = state.block;
    delete state.block;
    state.accepted = Math.max(state.accepted ?? 1, released.ratio);
    state.observed = [...state.pending];
    state.pending = [];
    delete state.pendingChargedUsd;
    delete state.pendingExpectedUsd;
    this.trim(state);
    this.persist();
    return released;
  }

  status(provider: string, model: string): CostAnomalyStatus {
    if (!this.config.enabled) return { state: "disabled" };
    const state = this.scopes.get(costAnomalyScopeKey(provider, model));
    if (state?.block !== undefined) return { state: "blocked", block: state.block };
    const acceptedRatio = state?.accepted ?? 1;
    const pending = state?.pending ?? [];
    if (pending.length > 0)
      return {
        state: "watching",
        ratio: median(pending),
        pending: pending.length,
        required: this.config.confirmingObservations,
        acceptedRatio,
      };
    const observed = state?.observed ?? [];
    // Distinguishes "this provider never reports what it billed" from "it
    // does, and it matches". Both are quiet, but only one of them is measured,
    // and an operator deciding whether to trust the detector needs to know
    // which one they are looking at.
    if (observed.length === 0) return { state: "no_charge_data", acceptedRatio };
    return { state: "normal", ratio: median(observed), samples: observed.length, acceptedRatio };
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
    return { version: 2, scopes: Object.fromEntries(structuredClone([...this.scopes])) };
  }

  /**
   * Wrap the same `Models` admission boundary the session limits use, so a
   * blocked scope refuses at the one seam every generation path goes through
   * and no front can start a run around it.
   *
   * This wrapper also OWNS THE MEASUREMENT, because the two halves of a
   * comparison come from different places and only this seam sees both. The
   * billed amount exists only on the wire, so the request has to ask for it and
   * the response has to be read on its way past -- that is what
   * `instrumentChargedCost` splices into the per-call options. The expectation
   * comes from `usage.cost.total`, which is NOT a provider fact: pi-ai computes
   * it by multiplying the settled token counts by the prices in the operator's
   * own registry config. That is worthless as a charge and exactly right as an
   * expectation, and mistaking the first for the second is what made the
   * previous version compare the config against itself.
   */
  wrap(models: Models, provider: string, model: string): Models {
    const detector = this;
    const promiseMethods = new Set(["complete", "completeSimple", "fetchDeferred"]);
    const streamMethods = new Set(["stream", "streamSimple", "streamDeferred"]);
    const settle = (message: AssistantMessage | undefined, capture: ChargeCapture): void => {
      const usage = message?.usage;
      if (usage === undefined) return;
      // No reported charge is NO OBSERVATION, never a passing one: a provider
      // that reports nothing must leave the scope unmeasured rather than
      // contribute a ratio of 1 that reads as a checked, correct price.
      if (capture.chargedUsd === undefined) return;
      detector.observe({
        provider,
        model,
        chargedUsd: capture.chargedUsd,
        expectedUsd: usage.cost.total,
      });
    };
    // The options argument sits at a different position per method, so it is
    // located by shape rather than by index -- and a call that passes none
    // still gets instrumented, since that is the common case.
    const instrument = (args: unknown[], capture: ChargeCapture): unknown[] => {
      const next = [...args];
      const last = next.length - 1;
      const target =
        last >= 1 && (typeof next[last] === "object" || next[last] === undefined) ? last : -1;
      if (target === -1) return next;
      next[target] = instrumentChargedCost(next[target], capture);
      return next;
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
            const capture: ChargeCapture = {};
            const operation = Reflect.apply(
              value,
              target,
              instrument(args, capture),
            ) as Promise<AssistantMessage>;
            return operation.then((message) => {
              settle(message, capture);
              return message;
            });
          };
        }
        if (streamMethods.has(property)) {
          return (...args: unknown[]) => {
            detector.admit(provider, model);
            const capture: ChargeCapture = {};
            const stream = Reflect.apply(value, target, instrument(args, capture)) as {
              result(): Promise<AssistantMessage>;
            };
            void stream.result().then(
              (message) => settle(message, capture),
              () => undefined,
            );
            return stream;
          };
        }
        return value;
      },
    });
  }

  private trim(state: CostAnomalyScopeState): void {
    const overflow = state.observed.length - OBSERVED_HISTORY;
    if (overflow > 0) state.observed.splice(0, overflow);
  }

  private persist(): void {
    this.store?.save(this.snapshot());
  }
}
