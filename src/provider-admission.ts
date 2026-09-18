import * as crypto from "node:crypto";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import {
  MAX_PROVIDER_RETRY_HINT_MS,
  type ProviderLimitError,
  providerLimitFrom,
} from "./runner/errors";

/**
 * Scope-keyed admission control over a provider's generation methods.
 *
 * Where session limits bound COST and TURNS per session, and cost-anomaly
 * bounds PRICE per model, this module bounds CONCURRENCY and RETRY-RATE per
 * provider scope: how many generation calls a provider may serve at once, and
 * how long the whole scope stands down after the provider answers with a
 * structured capacity limit (a 429 or a rate/quota code).
 *
 * The scope KEY is a SHA-256 digest, never the raw identifier (threat F1): the
 * controller sees a stable per-scope gate without the provider's credential
 * account id ever reaching a snapshot, an error message, or a durable file.
 *
 * TWO DIFFERENT BOUNDS LIVE HERE:
 *  - CONCURRENCY (`maxConcurrentPerScope`) caps calls in flight, so an
 *    unattended session cannot open unbounded parallel connections.
 *  - COOLDOWN caps the rate of retries after the provider answered "slow
 *    down". It is a scope-wide stand-down: while it is open, no request — not
 *    even one already queued — may probe the provider, so a burst of sessions
 *    sharing one scope cannot each independently re-trigger the 429 they were
 *    just told to pause for (requirement 6, retry-storm threat).
 */

export const ADMISSION_PRIORITY_CLASSES = ["interactive", "background", "title"] as const;

export type AdmissionPriorityClass = (typeof ADMISSION_PRIORITY_CLASSES)[number];

export interface ProviderAdmissionConfig {
  /** Positive integer: generation calls a scope may have in flight at once. */
  maxConcurrentPerScope: number;
  /** Positive integer: queued-but-not-admitted calls a scope may hold. */
  queueCapacityPerScope: number;
  /**
   * Positive finite milliseconds a queued request may wait before aging
   * promotions apply; title deferral is bounded by this too, so background and
   * title work can never be starved past the bound.
   */
  maxWaitMs: number;
  /** Ordered scheduling classes, interactive before background before title. */
  priorityClasses: readonly AdmissionPriorityClass[];
  /** Positive integer: default stand-down when a provider limit carries no usable hint. */
  retryDelayMs: number;
  /** Upper clamp for any cooldown, reusing the shared provider-retry clamp. */
  cooldownMaxMs: number;
}

export const DEFAULT_PROVIDER_ADMISSION_CONFIG: Readonly<ProviderAdmissionConfig> = Object.freeze({
  maxConcurrentPerScope: 1,
  queueCapacityPerScope: 8,
  maxWaitMs: 60_000,
  priorityClasses: ADMISSION_PRIORITY_CLASSES,
  retryDelayMs: 1_000,
  cooldownMaxMs: MAX_PROVIDER_RETRY_HINT_MS,
});

function assertConfig(config: ProviderAdmissionConfig): void {
  if (!Number.isInteger(config.maxConcurrentPerScope) || config.maxConcurrentPerScope <= 0)
    throw new TypeError("maxConcurrentPerScope must be a positive integer");
  if (!Number.isInteger(config.queueCapacityPerScope) || config.queueCapacityPerScope <= 0)
    throw new TypeError("queueCapacityPerScope must be a positive integer");
  if (!Number.isFinite(config.maxWaitMs) || config.maxWaitMs <= 0)
    throw new TypeError("maxWaitMs must be a positive finite number");
  if (!Number.isInteger(config.retryDelayMs) || config.retryDelayMs <= 0)
    throw new TypeError("retryDelayMs must be a positive integer");
  if (!Number.isFinite(config.cooldownMaxMs) || config.cooldownMaxMs <= 0)
    throw new TypeError("cooldownMaxMs must be a positive finite number");
  if (
    config.priorityClasses.length < 2 ||
    config.priorityClasses.length !== ADMISSION_PRIORITY_CLASSES.length
  )
    throw new TypeError("priorityClasses must set all three admission classes");
  const seen = new Set<AdmissionPriorityClass>();
  for (const p of config.priorityClasses) {
    if (!ADMISSION_PRIORITY_CLASSES.includes(p))
      throw new TypeError(`priorityClasses contains an unknown class: ${String(p)}`);
    if (seen.has(p))
      throw new TypeError(`priorityClasses contains a duplicate class: ${String(p)}`);
    seen.add(p);
  }
}

/**
 * A scope label is caller-supplied text and NOT a security boundary. It is
 * validated against the same character class run ids use (no control chars, no
 * whitespace, no newlines) BEFORE it can enter any error, status or snapshot, so
 * a raw account id or a log-injection sequence is refused at the door rather
 * than echoed into a log line (threat F5, T4).
 */
const SCOPE_LABEL_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function assertScopeLabel(label: string): string {
  if (!SCOPE_LABEL_PATTERN.test(label)) {
    throw new TypeError(
      `scope label must match ${String(SCOPE_LABEL_PATTERN)} (no whitespace or control characters)`,
    );
  }
  return label;
}

/**
 * A non-secret, deterministic, non-reversible scope key. SHA-256 over the
 * provider, the (validated) scope label, and an optional provider-documented
 * capacity partition. The raw inputs never appear in the key; only the digest is
 * persisted or compared, so no credential or account id is recoverable from a
 * snapshot (threat F1).
 */
export function admissionScopeKey(
  provider: string,
  scopeLabel: string,
  partition?: string,
): string {
  if (typeof provider !== "string" || provider.length === 0) {
    throw new TypeError("provider must be a non-empty string");
  }
  assertScopeLabel(scopeLabel);
  const part = partition ?? "";
  return crypto.createHash("sha256").update(`${provider}\n${scopeLabel}\n${part}`).digest("hex");
}

/** Safe, numeric-only saturation failure: a scope's queue is already full. */
export class QueueSaturatedError extends Error {
  override readonly name = "QueueSaturatedError";
  readonly code = "queue_saturated" as const;
  readonly retryable = true as const;
  readonly nextAction = "retry later, or raise queueCapacityPerScope" as const;

  constructor(
    readonly scopeLabel: string,
    readonly position: number,
  ) {
    super(
      `admission queue for scope "${scopeLabel}" is full (${position} waiting); ` +
        "retry later or raise queueCapacityPerScope",
    );
  }
}

/** Raised when a queued or admitted request is cancelled. Not retryable: the caller chose to stop. */
export class AdmissionCancelledError extends Error {
  override readonly name = "AdmissionCancelledError";
  readonly code = "cancelled" as const;
  readonly retryable = false as const;
  readonly nextAction = "start a new request if one is still wanted" as const;

  constructor(readonly scopeLabel: string) {
    super(`admission for scope "${scopeLabel}" was cancelled`);
  }
}

export interface ProviderAdmissionSnapshot {
  readonly version: 1;
  readonly scopes: Record<string, ProviderAdmissionScopeState>;
}

export interface ProviderAdmissionScopeState {
  readonly concurrent: number;
  readonly queue: ReadonlyArray<{
    readonly priority: AdmissionPriorityClass;
    readonly enqueuedAt: number;
  }>;
  readonly cooldownUntil?: number;
  readonly inFlight?: { readonly uncertain: true };
}

export interface ProviderAdmissionStore {
  load(): ProviderAdmissionSnapshot | undefined;
  save(snapshot: ProviderAdmissionSnapshot): void;
}

export class MemoryProviderAdmissionStore implements ProviderAdmissionStore {
  private snapshot: ProviderAdmissionSnapshot | undefined;

  load(): ProviderAdmissionSnapshot | undefined {
    return this.snapshot;
  }

  save(snapshot: ProviderAdmissionSnapshot): void {
    this.snapshot = structuredClone(snapshot);
  }
}

export interface ProviderAdmissionToken {
  readonly scopeLabel: string;
  readonly scopeKey: string;
  readonly state: "admitted" | "queued" | "cancelled" | "settled" | "uncertain";
  readonly uncertain: boolean;
  /** Resolve once admitted (or reject on cancel / provider limit). */
  wait(): Promise<void>;
  /** Cancel while queued: removes only this entry. */
  cancel(): void;
  /** Release the permit exactly once (idempotent). */
  release(): void;
}

interface QueueEntry {
  priority: AdmissionPriorityClass;
  enqueuedAt: number;
  token: AdmissionToken;
}

interface ScopeRuntime {
  concurrent: number;
  cooldownUntil: number | undefined;
  queue: QueueEntry[];
  inFlightToken: AdmissionToken | undefined;
}

class AdmissionToken implements ProviderAdmissionToken {
  state: "admitted" | "queued" | "cancelled" | "settled" | "uncertain" = "queued";
  uncertain = false;
  released = false;
  limitError: ProviderLimitError | undefined;
  private waitResolvers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(
    readonly scopeLabel: string,
    readonly scopeKey: string,
    readonly priority: AdmissionPriorityClass,
  ) {}

  takeResolvers(): Array<{ resolve: () => void; reject: (error: unknown) => void }> {
    const current = this.waitResolvers;
    this.waitResolvers = [];
    return current;
  }

  wait(): Promise<void> {
    if (this.state === "admitted") return Promise.resolve();
    if (this.state === "cancelled")
      return Promise.reject(new AdmissionCancelledError(this.scopeLabel));
    if (this.state === "settled" && this.limitError !== undefined)
      return Promise.reject(this.limitError);
    return new Promise<void>((resolve, reject) => {
      this.waitResolvers.push({ resolve, reject });
    });
  }

  cancel(): void {
    if (this.state !== "queued") return;
    this.state = "cancelled";
    for (const { reject } of this.waitResolvers)
      reject(new AdmissionCancelledError(this.scopeLabel));
    this.waitResolvers = [];
  }

  release(): void {
    if (this.released) return;
    this.released = true;
  }
}

export class ProviderAdmissionController {
  readonly config: Readonly<ProviderAdmissionConfig>;
  private readonly scopes = new Map<string, ScopeRuntime>();
  private restored = false;
  private readonly now: () => number;
  private readonly store: ProviderAdmissionStore | undefined;

  constructor(
    config: Partial<ProviderAdmissionConfig> = {},
    store?: ProviderAdmissionStore,
    now: () => number = () => Date.now(),
  ) {
    const resolved = { ...DEFAULT_PROVIDER_ADMISSION_CONFIG, ...config };
    assertConfig(resolved);
    this.config = Object.freeze(resolved);
    this.store = store;
    this.now = now;
    const loaded = this.store?.load();
    if (loaded !== undefined) this.restore(loaded);
  }

  /** Guarded partition: admission, cancellation, snapshots, and recovery. */

  /**
   * Guarded and idempotent (T3): loads at most once, and refuses a mismatched
   * version. Second and later calls are a no-op, never a re-arm, so a double
   * restore cannot double-count an in-flight permit.
   */
  restore(snapshot: Readonly<ProviderAdmissionSnapshot>): void {
    if (this.restored) return;
    if (snapshot.version !== 1)
      throw new TypeError("unsupported provider admission snapshot version");
    for (const [key, state] of Object.entries(snapshot.scopes)) {
      const scope: ScopeRuntime = {
        concurrent: state.concurrent,
        cooldownUntil: state.cooldownUntil,
        queue: [],
        inFlightToken: undefined,
      };
      for (const entry of state.queue) {
        // Restored queue entries are placeholders that preserve order and
        // occupancy; a restart has no waiting caller to hand them to, so they
        // are re-created as unowned tokens that still occupy capacity. Their
        // admission order is retained via enqueuedAt for the scheduler.
        const token = new AdmissionToken("", key, entry.priority);
        token.state = "queued";
        scope.queue.push({ priority: entry.priority, enqueuedAt: entry.enqueuedAt, token });
      }
      if (state.inFlight !== undefined) {
        // An admission granted just before a crash whose outcome the restarted
        // controller cannot know. Re-armed as `uncertain` so a resume never
        // silently re-issues a non-idempotent provider call AND never
        // double-counts concurrency: the persisted `concurrent` already counts
        // this permit, so the re-armed token stays counted until the caller
        // resolves it (threat F4).
        const token = new AdmissionToken("", key, "interactive");
        token.state = "uncertain";
        token.uncertain = true;
        scope.inFlightToken = token;
      }
      this.scopes.set(key, scope);
    }
    this.restored = true;
  }

  /** Resolve a re-armed uncertain token to a terminal outcome (release once). */
  resolveUncertain(token: ProviderAdmissionToken): void {
    const admission = token as AdmissionToken;
    if (!admission.uncertain || admission.state !== "uncertain") return;
    this.settleToken(admission);
  }

  snapshot(): ProviderAdmissionSnapshot {
    const scopes: Record<string, ProviderAdmissionScopeState> = {};
    for (const [key, scope] of this.scopes) {
      const state: ProviderAdmissionScopeState = {
        concurrent: scope.concurrent,
        queue: scope.queue.map((entry) => ({
          priority: entry.priority,
          enqueuedAt: entry.enqueuedAt,
        })),
        ...(scope.cooldownUntil !== undefined ? { cooldownUntil: scope.cooldownUntil } : {}),
        ...(scope.inFlightToken !== undefined ? { inFlight: { uncertain: true as const } } : {}),
      };
      scopes[key] = state;
    }
    return { version: 1, scopes: structuredClone(scopes) };
  }

  /** Reserve a permit, waiting through the priority/aging/title scheduler and cooldown. */
  private async reserve(
    scopeKey: string,
    scopeLabel: string,
    priority: AdmissionPriorityClass,
  ): Promise<AdmissionToken> {
    const scope = this.ensureScope(scopeKey);
    // A per-call priority override is not part of the public surface; the
    // wrap() seam assigns priority per method (see priorityOf).
    const token = new AdmissionToken(scopeLabel, scopeKey, priority);

    if (this.canGrant(scope)) {
      this.grant(scope, token);
      this.persist();
      return token;
    }

    if (scope.queue.length >= this.config.queueCapacityPerScope) {
      throw new QueueSaturatedError(scopeLabel, scope.queue.length);
    }

    scope.queue.push({ priority, enqueuedAt: this.now(), token });
    this.persist();

    await token.wait();

    // Woken either by a grant (state "admitted") or by a cancel/late-fill.
    if (token.state === "cancelled") {
      this.removeFromQueue(scope, token);
      this.persist();
      throw new AdmissionCancelledError(scopeLabel);
    }
    return token;
  }

  private ensureScope(key: string): ScopeRuntime {
    let scope = this.scopes.get(key);
    if (scope === undefined) {
      scope = { concurrent: 0, cooldownUntil: undefined, queue: [], inFlightToken: undefined };
      this.scopes.set(key, scope);
    }
    return scope;
  }

  /** Cooldown is part of the grant decision (T1), re-checked at dequeue, not trusted from enqueue. */
  private canGrant(scope: ScopeRuntime): boolean {
    return (
      scope.concurrent < this.config.maxConcurrentPerScope &&
      (scope.cooldownUntil === undefined || this.now() >= scope.cooldownUntil)
    );
  }

  private grant(scope: ScopeRuntime, token: AdmissionToken): void {
    token.state = "admitted";
    token.uncertain = false;
    scope.concurrent += 1;
    scope.inFlightToken = token;
    const resolvers = token.takeResolvers();
    for (const { resolve } of resolvers) resolve();
  }

  private removeFromQueue(scope: ScopeRuntime, token: AdmissionToken): void {
    const index = scope.queue.findIndex((entry) => entry.token === token);
    if (index !== -1) scope.queue.splice(index, 1);
  }

  /** Dequeue the best candidate, enforcing priority order, aging, and title deferral. */
  private dequeueCandidate(scope: ScopeRuntime): AdmissionToken | undefined {
    const now = this.now();
    const entries = scope.queue;

    const effectivePriority = (entry: QueueEntry): AdmissionPriorityClass =>
      now - entry.enqueuedAt >= this.config.maxWaitMs ? "interactive" : entry.priority;

    // Title deferral: a title-class (non-aged) entry never runs while any
    // interactive (or aged-to-interactive) entry is still waiting (T5: aging
    // still applies, so a title deferred past the bound is promoted and cannot
    // be starved indefinitely).
    const anyInteractiveWaiting = entries.some(
      (entry) => effectivePriority(entry) === "interactive",
    );

    let bestIndex = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    let bestEnqueuedAt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i] as QueueEntry;
      const cls = effectivePriority(entry);
      if (cls === "title" && anyInteractiveWaiting) continue;
      const rank = this.config.priorityClasses.indexOf(cls);
      if (rank < bestRank || (rank === bestRank && entry.enqueuedAt < bestEnqueuedAt)) {
        bestRank = rank;
        bestEnqueuedAt = entry.enqueuedAt;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) return undefined;
    const [chosen] = scope.queue.splice(bestIndex, 1);
    return chosen?.token;
  }

  private settleToken(token: AdmissionToken): void {
    if (token.released) return;
    token.release();
    const scope = this.scopes.get(token.scopeKey);
    if (scope === undefined) return;
    if (scope.inFlightToken === token) scope.inFlightToken = undefined;
    if (scope.concurrent > 0) scope.concurrent -= 1;
    this.persist();
    this.pump();
  }

  private pump(): void {
    for (const scope of this.scopes.values()) {
      while (this.canGrant(scope) && scope.queue.length > 0) {
        const candidate = this.dequeueCandidate(scope);
        if (candidate === undefined) break;
        this.grant(scope, candidate);
      }
    }
    this.persist();
  }

  /** Open a scope-wide cooldown from a structured provider limit (T6). */
  private openCooldown(scopeKey: string, error: ProviderLimitError): ProviderLimitError {
    const scope = this.scopes.get(scopeKey);
    if (scope === undefined) return error;
    const hint = error.retryAfterMs;
    const delay =
      hint !== undefined ? Math.min(hint, this.config.cooldownMaxMs) : this.config.retryDelayMs;
    scope.cooldownUntil = this.now() + delay;
    this.persist();
    return error;
  }

  /** React to a rejected provider call: on provider_limit, open the scope cooldown. */
  private reactRejection(scopeKey: string, error: unknown): void {
    const limit = providerLimitFrom(error, this.now());
    if (limit !== undefined) this.openCooldown(scopeKey, limit);
  }

  /**
   * Wrap the six generation methods at their shared admission boundary, exactly
   * as session-limits and cost-anomaly do. Promise methods reserve then settle
   * on resolve/reject; stream methods reserve and settle via `result()`.
   */
  wrap(models: Models, provider: string, scopeLabel = "default"): Models {
    const controller = this;
    const label = assertScopeLabel(scopeLabel);
    const scopeKey = admissionScopeKey(provider, label);
    const promiseMethods = new Set(["complete", "completeSimple", "fetchDeferred"]);
    const streamMethods = new Set(["stream", "streamSimple", "streamDeferred"]);

    const priorityOf = (method: string): AdmissionPriorityClass =>
      streamMethods.has(method) || method === "completeSimple" ? "background" : "interactive";

    return new Proxy(models, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || typeof value !== "function") return value;

        if (promiseMethods.has(property)) {
          return async (...args: unknown[]): Promise<AssistantMessage> => {
            let token: AdmissionToken;
            try {
              token = await controller.reserve(scopeKey, label, priorityOf(property));
            } catch (error) {
              return Promise.reject(error);
            }
            let operation: Promise<AssistantMessage>;
            try {
              operation = Reflect.apply(value, target, args) as Promise<AssistantMessage>;
            } catch (error) {
              controller.settleToken(token);
              throw error;
            }
            return operation.then(
              (message) => {
                controller.settleToken(token);
                return message;
              },
              (error: unknown) => {
                controller.settleToken(token);
                controller.reactRejection(scopeKey, error);
                throw error;
              },
            );
          };
        }

        if (streamMethods.has(property)) {
          return (...args: unknown[]): ReturnType<Models["stream"]> =>
            controller.deferredStream(
              scopeKey,
              label,
              priorityOf(property),
              value as (...a: unknown[]) => unknown,
              target,
              args,
            );
        }

        // cancelDeferred and every non-generation method pass through unchanged.
        return value.bind(target);
      },
    });
  }

  /**
   * Stream methods must return a stream synchronously, but admission can wait
   * (queue/cooldown). Return a deferred stream that wires the real one only
   * once admission resolves, so the provider is never probed during the
   * cooldown/saturation window (requirement 6, T1).
   */
  private deferredStream(
    scopeKey: string,
    label: string,
    priority: AdmissionPriorityClass,
    value: (...args: unknown[]) => unknown,
    target: Models,
    args: unknown[],
  ): ReturnType<Models["stream"]> {
    const state: {
      result: (() => Promise<AssistantMessage>) | undefined;
    } = { result: undefined };
    const callers: Array<() => void> = [];

    // A minimal stream object; its `result()` resolves once the real stream is
    // wired after admission.
    const stream = {
      result: (): Promise<AssistantMessage> => {
        if (state.result !== undefined) return state.result();
        return new Promise<AssistantMessage>((resolve, reject) => {
          callers.push(() => {
            const settled = state.result;
            if (settled === undefined) {
              reject(new Error("admission stream flushed without a result"));
              return;
            }
            settled().then(resolve, reject);
          });
        });
      },
    };

    void this.reserve(scopeKey, label, priority).then(
      (token) => {
        let real: { result(): Promise<AssistantMessage> };
        try {
          real = Reflect.apply(value, target, args) as { result(): Promise<AssistantMessage> };
        } catch (error) {
          this.settleToken(token);
          state.result = () => Promise.reject(error);
          for (const c of callers) c();
          return;
        }
        Object.assign(stream, real);
        state.result = () =>
          real.result().then(
            (message) => {
              this.settleToken(token);
              return message;
            },
            (error: unknown) => {
              this.settleToken(token);
              this.reactRejection(scopeKey, error);
              throw error;
            },
          );
        for (const c of callers) c();
      },
      (error: unknown) => {
        state.result = () => Promise.reject(error);
        for (const c of callers) c();
      },
    );

    return stream as unknown as ReturnType<Models["stream"]>;
  }

  private persist(): void {
    this.store?.save(this.snapshot());
  }
}
