import type { AssistantMessage, Models } from "@earendil-works/pi-ai";

export interface StageLimits {
  maxDurationMs?: number;
  maxModelTurns?: number;
  maxToolTurns?: number;
  maxInputTokens?: number;
  maxCostUsd?: number;
}

export type StageLimitReason =
  | "duration"
  | "model_turns"
  | "tool_turns"
  | "input"
  | "cost"
  | "cost_in_flight"
  | "cost_unknown";

export interface StageLimitSnapshot extends Required<StageLimits> {
  elapsedMs: number;
  modelTurns: number;
  toolTurns: number;
  inputTokens: number;
  costUsd: number;
  costInFlight: boolean;
}

export class StageLimitError extends Error {
  override readonly name = "StageLimitError";
  readonly code = "stage_limit" as const;

  constructor(
    readonly reason: StageLimitReason,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`stage ${reason} limit reached (${observed}/${limit})`);
  }
}

export const DEFAULT_STAGE_LIMITS: Readonly<Required<StageLimits>> = Object.freeze({
  maxDurationMs: 0,
  maxModelTurns: 0,
  maxToolTurns: 0,
  maxInputTokens: 0,
  maxCostUsd: 0,
});

function resolveStageLimits(input: StageLimits = {}): Required<StageLimits> {
  const limits = { ...DEFAULT_STAGE_LIMITS, ...input };
  for (const key of ["maxDurationMs", "maxModelTurns", "maxToolTurns", "maxInputTokens"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0)
      throw new TypeError(`${key} must be a non-negative safe integer`);
  }
  if (!Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd < 0)
    throw new TypeError("maxCostUsd must be a non-negative finite number");
  return limits;
}

export class StageLimitController {
  readonly limits: Readonly<Required<StageLimits>>;
  private readonly startedAt: number;
  private modelTurns = 0;
  private toolTurns = 0;
  private inputTokens = 0;
  private costUsd = 0;
  private costInFlight = false;
  private terminalReason: StageLimitReason | undefined;

  constructor(
    limits: StageLimits = {},
    private readonly now: () => number = () => performance.now(),
  ) {
    this.limits = Object.freeze(resolveStageLimits(limits));
    this.startedAt = now();
  }

  snapshot(): Readonly<StageLimitSnapshot> {
    return Object.freeze({
      ...this.limits,
      elapsedMs: this.elapsedMs(),
      modelTurns: this.modelTurns,
      toolTurns: this.toolTurns,
      inputTokens: this.inputTokens,
      costUsd: this.costUsd,
      costInFlight: this.costInFlight,
    });
  }

  assertActive(): void {
    if (this.terminalReason !== undefined)
      throw new StageLimitError(this.terminalReason, this.limits.maxCostUsd, this.costUsd);
    this.assertBelow("duration", this.limits.maxDurationMs, this.elapsedMs());
    this.assertBelow("model_turns", this.limits.maxModelTurns, this.modelTurns);
    this.assertBelow("tool_turns", this.limits.maxToolTurns, this.toolTurns);
    this.assertBelow("input", this.limits.maxInputTokens, this.inputTokens);
    this.assertBelow("cost", this.limits.maxCostUsd, this.costUsd);
    if (this.limits.maxCostUsd > 0 && this.costInFlight)
      throw new StageLimitError("cost_in_flight", this.limits.maxCostUsd, this.costUsd);
  }

  admitModelTurn(): void {
    this.assertActive();
    this.modelTurns += 1;
    if (this.limits.maxCostUsd > 0) this.costInFlight = true;
  }

  admitToolTurn(): void {
    this.assertActive();
    this.toolTurns += 1;
  }

  observeUsage(inputTokens: number, costUsd: number): void {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0)
      throw new TypeError("inputTokens must be a non-negative safe integer");
    if (!Number.isFinite(costUsd) || costUsd < 0)
      throw new TypeError("costUsd must be a non-negative finite number");
    const totalInput = this.inputTokens + inputTokens;
    const totalCost = this.costUsd + costUsd;
    if (!Number.isSafeInteger(totalInput)) throw new TypeError("inputTokens total is unsafe");
    if (!Number.isFinite(totalCost)) throw new TypeError("costUsd total is unsafe");
    this.inputTokens = totalInput;
    this.costUsd = totalCost;
    this.costInFlight = false;
  }

  failUnknownCost(): void {
    if (this.limits.maxCostUsd > 0) {
      this.costInFlight = false;
      this.terminalReason = "cost_unknown";
    }
  }

  wrap(models: Models): Models {
    const controller = this;
    const promiseMethods = new Set(["complete", "completeSimple", "fetchDeferred"]);
    const streamMethods = new Set(["stream", "streamSimple", "streamDeferred"]);
    const settle = (message: AssistantMessage | undefined) => {
      if (message === undefined) return controller.failUnknownCost();
      controller.observeUsage(
        message.usage.input + message.usage.cacheRead,
        message.usage.cost.total,
      );
    };
    return new Proxy(models, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || typeof value !== "function") return value;
        if (promiseMethods.has(property))
          return (...args: unknown[]) => {
            try {
              controller.admitModelTurn();
            } catch (error) {
              return Promise.reject(error);
            }
            let operation: Promise<AssistantMessage>;
            try {
              operation = Reflect.apply(value, target, args) as Promise<AssistantMessage>;
            } catch (error) {
              settle(undefined);
              throw error;
            }
            return operation.then(
              (message) => {
                settle(message);
                return message;
              },
              (error: unknown) => {
                settle(undefined);
                throw error;
              },
            );
          };
        if (streamMethods.has(property))
          return (...args: unknown[]) => {
            controller.admitModelTurn();
            let stream: { result(): Promise<AssistantMessage> };
            try {
              stream = Reflect.apply(value, target, args) as typeof stream;
            } catch (error) {
              settle(undefined);
              throw error;
            }
            void stream.result().then(
              (message) => settle(message),
              () => settle(undefined),
            );
            return stream;
          };
        return value.bind(target);
      },
    });
  }

  private elapsedMs(): number {
    const elapsed = this.now() - this.startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw new TypeError("monotonic clock moved backwards");
    return elapsed;
  }

  private assertBelow(reason: StageLimitReason, limit: number, observed: number): void {
    if (limit > 0 && observed >= limit) throw new StageLimitError(reason, limit, observed);
  }
}
