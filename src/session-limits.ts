import type { AssistantMessage, Models } from "@earendil-works/pi-ai";

export interface SessionLimits {
  maxTurns?: number;
  maxCostUsd?: number;
}

export type SessionLimitReason = "turns" | "cost" | "cost_in_flight" | "cost_unknown";

export interface SessionLimitSnapshot {
  readonly maxTurns: number;
  readonly maxCostUsd: number;
  readonly admittedTurns: number;
  readonly observedCostUsd: number;
  readonly costInFlight: boolean;
  readonly terminalReason: SessionLimitReason | undefined;
}

/** Safe, numeric-only resource-limit failure. Provider and prompt content never enter it. */
export class SessionLimitError extends Error {
  override readonly name = "SessionLimitError";
  readonly code = "session_limit" as const;
  readonly reason: SessionLimitReason;
  readonly limit: number;
  readonly observed: number;

  constructor(reason: SessionLimitReason, limit: number, observed: number) {
    super(`session ${reason} limit reached (${observed}/${limit})`);
    this.reason = reason;
    this.limit = limit;
    this.observed = observed;
  }
}

function resolveLimits(limits: SessionLimits | undefined): Required<SessionLimits> {
  const maxTurns = limits?.maxTurns ?? 0;
  const maxCostUsd = limits?.maxCostUsd ?? 0;
  if (!Number.isInteger(maxTurns) || maxTurns < 0) {
    throw new TypeError("maxTurns must be a non-negative integer");
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0) {
    throw new TypeError("maxCostUsd must be a non-negative finite number");
  }
  return { maxTurns, maxCostUsd };
}

export class SessionLimitController {
  readonly limits: Readonly<Required<SessionLimits>>;
  private admittedTurns = 0;
  private observedCostUsd = 0;
  private costInFlight = false;
  private terminalReason: SessionLimitReason | undefined;
  private boundaryFailure: SessionLimitError | undefined;

  constructor(limits?: SessionLimits) {
    this.limits = Object.freeze(resolveLimits(limits));
  }

  snapshot(): Readonly<SessionLimitSnapshot> {
    const current = this.currentError();
    return Object.freeze({
      ...this.limits,
      admittedTurns: this.admittedTurns,
      observedCostUsd: this.observedCostUsd,
      costInFlight: this.costInFlight,
      terminalReason: current?.reason,
    });
  }

  assertActive(): void {
    const error = this.currentError();
    if (error !== undefined) throw error;
  }

  /** Rethrow a Models-boundary rejection that an upstream harness converted to a result. */
  assertNoBoundaryFailure(): void {
    if (this.boundaryFailure !== undefined) throw this.boundaryFailure;
  }

  private currentError(): SessionLimitError | undefined {
    if (this.terminalReason !== undefined) {
      return new SessionLimitError(
        this.terminalReason,
        this.limits.maxCostUsd,
        this.observedCostUsd,
      );
    }
    if (this.limits.maxTurns > 0 && this.admittedTurns >= this.limits.maxTurns) {
      return new SessionLimitError("turns", this.limits.maxTurns, this.admittedTurns);
    }
    if (this.limits.maxCostUsd > 0 && this.observedCostUsd >= this.limits.maxCostUsd) {
      return new SessionLimitError("cost", this.limits.maxCostUsd, this.observedCostUsd);
    }
    if (this.limits.maxCostUsd > 0 && this.costInFlight) {
      return new SessionLimitError("cost_in_flight", this.limits.maxCostUsd, this.observedCostUsd);
    }
    return undefined;
  }

  private reserve(): void {
    try {
      this.assertActive();
    } catch (error) {
      if (error instanceof SessionLimitError) this.boundaryFailure = error;
      throw error;
    }
    this.admittedTurns += 1;
    if (this.limits.maxCostUsd > 0) this.costInFlight = true;
  }

  private settle(message: AssistantMessage | undefined): void {
    if (this.limits.maxCostUsd === 0) return;
    this.costInFlight = false;
    const cost = message?.usage.cost.total;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      this.terminalReason = "cost_unknown";
      return;
    }
    this.observedCostUsd += cost;
  }

  /** Wrap all six generation methods at their shared Models admission boundary. */
  wrap(models: Models): Models {
    const controller = this;
    const promiseMethods = new Set(["complete", "completeSimple", "fetchDeferred"]);
    const streamMethods = new Set(["stream", "streamSimple", "streamDeferred"]);
    return new Proxy(models, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || typeof value !== "function") return value;
        if (promiseMethods.has(property)) {
          return (...args: unknown[]) => {
            try {
              controller.reserve();
            } catch (error) {
              return Promise.reject(error);
            }
            let operation: Promise<AssistantMessage>;
            try {
              operation = Reflect.apply(value, target, args) as Promise<AssistantMessage>;
            } catch (error) {
              controller.settle(undefined);
              throw error;
            }
            return operation.then(
              (message) => {
                controller.settle(message);
                return message;
              },
              (error: unknown) => {
                controller.settle(undefined);
                throw error;
              },
            );
          };
        }
        if (streamMethods.has(property)) {
          return (...args: unknown[]) => {
            controller.reserve();
            let stream: { result(): Promise<AssistantMessage> };
            try {
              stream = Reflect.apply(value, target, args) as {
                result(): Promise<AssistantMessage>;
              };
            } catch (error) {
              controller.settle(undefined);
              throw error;
            }
            void stream.result().then(
              (message) => controller.settle(message),
              () => controller.settle(undefined),
            );
            return stream;
          };
        }
        return value.bind(target);
      },
    });
  }
}
