import type { AssistantMessage, Models } from "@earendil-works/pi-ai";

export interface StageLimits {
  maxDurationMs?: number;
  maxModelTurns?: number;
  maxToolTurns?: number;
  maxInputTokens?: number;
  maxCostUsd?: number;
  finalResponseReserveModelTurns?: number;
  finalResponseReserveDurationMs?: number;
  finalResponseReserveToolTurns?: number;
  finalResponseReserveInputTokens?: number;
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
  lastInputTokens: number;
  costUsd: number;
  costInFlight: boolean;
}

/** Safe live capacity exposed after a tool turn; zero limits are intentionally omitted. */
export interface StageBudgetProjection {
  durationMs?: number;
  modelTurns?: number;
  toolTurns?: number;
  inputTokens?: number;
  costUsd?: number;
  /** Tool admissions available before the configured final-response reserve. */
  toolTurnsBeforeCloseout?: number;
}

export function projectRemainingStageBudget(
  snapshot: Readonly<StageLimitSnapshot>,
): StageBudgetProjection {
  const remaining = (limit: number, used: number): number | undefined =>
    limit === 0 ? undefined : Math.max(0, limit - used);
  const toolCloseoutLimit =
    snapshot.maxToolTurns === 0
      ? undefined
      : Math.max(0, snapshot.maxToolTurns - snapshot.finalResponseReserveToolTurns);
  const durationMs = remaining(snapshot.maxDurationMs, snapshot.elapsedMs);
  const modelTurns = remaining(snapshot.maxModelTurns, snapshot.modelTurns);
  const toolTurns = remaining(snapshot.maxToolTurns, snapshot.toolTurns);
  const inputTokens = remaining(snapshot.maxInputTokens, snapshot.inputTokens);
  const costUsd = remaining(snapshot.maxCostUsd, snapshot.costUsd);
  return {
    ...(durationMs !== undefined && { durationMs }),
    ...(modelTurns !== undefined && { modelTurns }),
    ...(toolTurns !== undefined && { toolTurns }),
    ...(inputTokens !== undefined && { inputTokens }),
    ...(costUsd !== undefined && { costUsd }),
    ...(toolCloseoutLimit !== undefined && {
      toolTurnsBeforeCloseout: Math.max(0, toolCloseoutLimit - snapshot.toolTurns),
    }),
  };
}

export class StageLimitError extends Error {
  override readonly name = "StageLimitError";
  readonly code = "stage_limit" as const;

  constructor(
    readonly reason: StageLimitReason,
    readonly limit: number,
    readonly observed: number,
    readonly snapshot?: Readonly<StageLimitSnapshot>,
  ) {
    super(`stage ${reason} limit reached (${observed}/${limit})`);
  }
}

export type StageCloseoutReason = "duration" | "model_turns" | "tool_turns" | "input";

/** A non-terminal tool rejection that preserves capacity for the role's final answer. */
export class StageCloseoutError extends Error {
  override readonly name = "StageCloseoutError";
  readonly code = "stage_closeout" as const;

  constructor(
    readonly reason: StageCloseoutReason,
    detail: string,
  ) {
    super(
      `stage closeout reserve reached; stop using tools and return the final response (${detail})`,
    );
  }
}

export const DEFAULT_STAGE_LIMITS: Readonly<Required<StageLimits>> = Object.freeze({
  maxDurationMs: 0,
  maxModelTurns: 0,
  maxToolTurns: 0,
  maxInputTokens: 0,
  maxCostUsd: 0,
  finalResponseReserveModelTurns: 0,
  finalResponseReserveDurationMs: 0,
  finalResponseReserveToolTurns: 0,
  finalResponseReserveInputTokens: 0,
});

function resolveStageLimits(input: StageLimits = {}): Required<StageLimits> {
  const limits = { ...DEFAULT_STAGE_LIMITS, ...input };
  for (const key of [
    "maxDurationMs",
    "maxModelTurns",
    "maxToolTurns",
    "maxInputTokens",
    "finalResponseReserveModelTurns",
    "finalResponseReserveDurationMs",
    "finalResponseReserveToolTurns",
    "finalResponseReserveInputTokens",
  ] as const) {
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
  private lastInputTokens = 0;
  private costUsd = 0;
  private costInFlight = false;
  private closeoutReason: StageCloseoutReason | undefined;
  private terminalReason: StageLimitReason | undefined;
  private boundaryFailure: StageLimitError | undefined;

  constructor(
    limits: StageLimits = {},
    private readonly now: () => number = () => performance.now(),
    initial: Partial<
      Pick<
        StageLimitSnapshot,
        "elapsedMs" | "modelTurns" | "toolTurns" | "inputTokens" | "lastInputTokens" | "costUsd"
      >
    > = {},
    private readonly onSnapshot?: (snapshot: Readonly<StageLimitSnapshot>) => void,
  ) {
    this.limits = Object.freeze(resolveStageLimits(limits));
    if (!Number.isFinite(initial.elapsedMs ?? 0) || (initial.elapsedMs ?? 0) < 0)
      throw new TypeError("elapsedMs must be a non-negative finite number");
    for (const key of ["modelTurns", "toolTurns", "inputTokens", "lastInputTokens"] as const) {
      const value = initial[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0)
        throw new TypeError(`${key} must be a non-negative safe integer`);
    }
    if (!Number.isFinite(initial.costUsd ?? 0) || (initial.costUsd ?? 0) < 0)
      throw new TypeError("costUsd must be a non-negative finite number");
    this.startedAt = now() - (initial.elapsedMs ?? 0);
    this.modelTurns = initial.modelTurns ?? 0;
    this.toolTurns = initial.toolTurns ?? 0;
    this.inputTokens = initial.inputTokens ?? 0;
    this.lastInputTokens = initial.lastInputTokens ?? 0;
    this.costUsd = initial.costUsd ?? 0;
  }

  snapshot(): Readonly<StageLimitSnapshot> {
    return Object.freeze({
      ...this.limits,
      elapsedMs: this.elapsedMs(),
      modelTurns: this.modelTurns,
      toolTurns: this.toolTurns,
      inputTokens: this.inputTokens,
      lastInputTokens: this.lastInputTokens,
      costUsd: this.costUsd,
      costInFlight: this.costInFlight,
    });
  }

  assertActive(): void {
    if (this.terminalReason !== undefined)
      throw new StageLimitError(
        this.terminalReason,
        this.limits.maxCostUsd,
        this.costUsd,
        this.snapshot(),
      );
    this.assertBelow("duration", this.limits.maxDurationMs, this.elapsedMs());
    this.assertBelow("model_turns", this.limits.maxModelTurns, this.modelTurns);
    this.assertBelow("tool_turns", this.limits.maxToolTurns, this.toolTurns);
    this.assertBelow("input", this.limits.maxInputTokens, this.inputTokens);
    this.assertBelow("cost", this.limits.maxCostUsd, this.costUsd);
    if (this.limits.maxCostUsd > 0 && this.costInFlight)
      throw new StageLimitError(
        "cost_in_flight",
        this.limits.maxCostUsd,
        this.costUsd,
        this.snapshot(),
      );
  }

  /** Rethrow a model-boundary rejection that the harness converted to its generic fault. */
  assertNoBoundaryFailure(): void {
    if (this.boundaryFailure !== undefined) throw this.boundaryFailure;
  }

  admitModelTurn(): void {
    this.assertActive();
    this.modelTurns += 1;
    if (this.limits.maxCostUsd > 0) this.costInFlight = true;
    this.onSnapshot?.(this.snapshot());
  }

  admitToolTurn(): void {
    this.assertActive();
    const {
      maxDurationMs,
      maxModelTurns,
      finalResponseReserveDurationMs,
      finalResponseReserveModelTurns,
      finalResponseReserveToolTurns,
      finalResponseReserveInputTokens,
      maxInputTokens,
      maxToolTurns,
    } = this.limits;
    if (
      maxDurationMs > 0 &&
      finalResponseReserveDurationMs > 0 &&
      this.elapsedMs() >= Math.max(0, maxDurationMs - finalResponseReserveDurationMs)
    ) {
      this.closeoutReason = "duration";
      throw new StageCloseoutError(
        "duration",
        `${Math.round(this.elapsedMs())}/${maxDurationMs} ms used, ${finalResponseReserveDurationMs} ms reserved`,
      );
    }
    if (
      maxModelTurns > 0 &&
      finalResponseReserveModelTurns > 0 &&
      this.modelTurns >= Math.max(0, maxModelTurns - finalResponseReserveModelTurns)
    ) {
      this.closeoutReason = "model_turns";
      throw new StageCloseoutError(
        "model_turns",
        `${this.modelTurns}/${maxModelTurns} model turns used, ${finalResponseReserveModelTurns} reserved`,
      );
    }
    if (
      maxInputTokens > 0 &&
      finalResponseReserveInputTokens > 0 &&
      this.inputTokens >= Math.max(0, maxInputTokens - finalResponseReserveInputTokens)
    ) {
      this.closeoutReason = "input";
      throw new StageCloseoutError(
        "input",
        `${this.inputTokens}/${maxInputTokens} input tokens used, ${finalResponseReserveInputTokens} reserved`,
      );
    }
    if (
      maxToolTurns > 0 &&
      finalResponseReserveToolTurns > 0 &&
      this.toolTurns >= Math.max(0, maxToolTurns - finalResponseReserveToolTurns)
    ) {
      this.closeoutReason = "tool_turns";
      throw new StageCloseoutError(
        "tool_turns",
        `${this.toolTurns}/${maxToolTurns} tool turns used, ${finalResponseReserveToolTurns} reserved`,
      );
    }
    this.toolTurns += 1;
    this.onSnapshot?.(this.snapshot());
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
    this.lastInputTokens = inputTokens;
    this.costUsd = totalCost;
    this.costInFlight = false;
    this.onSnapshot?.(this.snapshot());
  }

  failUnknownCost(): void {
    if (this.limits.maxCostUsd > 0) {
      this.costInFlight = false;
      this.terminalReason = "cost_unknown";
      this.onSnapshot?.(this.snapshot());
    }
  }

  wrap(models: Models): Models {
    const promiseMethods = new Set(["complete", "completeSimple", "fetchDeferred"]);
    const streamMethods = new Set(["stream", "streamSimple", "streamDeferred"]);
    const reserve = () => {
      try {
        this.admitModelTurn();
      } catch (error) {
        if (error instanceof StageLimitError) this.boundaryFailure = error;
        throw error;
      }
    };
    const prepareCloseout = () => {
      if (this.closeoutReason !== undefined) return;
      const {
        maxDurationMs,
        maxModelTurns,
        maxToolTurns,
        maxInputTokens,
        finalResponseReserveDurationMs,
        finalResponseReserveModelTurns,
        finalResponseReserveToolTurns,
        finalResponseReserveInputTokens,
      } = this.limits;
      if (
        maxDurationMs > 0 &&
        finalResponseReserveDurationMs > 0 &&
        this.elapsedMs() >= maxDurationMs - finalResponseReserveDurationMs
      )
        this.closeoutReason = "duration";
      else if (
        maxModelTurns > 0 &&
        finalResponseReserveModelTurns > 0 &&
        this.modelTurns >= maxModelTurns - finalResponseReserveModelTurns
      )
        this.closeoutReason = "model_turns";
      else if (
        maxInputTokens > 0 &&
        finalResponseReserveInputTokens > 0 &&
        this.inputTokens + this.lastInputTokens >= maxInputTokens - finalResponseReserveInputTokens
      )
        this.closeoutReason = "input";
      else if (
        maxToolTurns > 0 &&
        finalResponseReserveToolTurns > 0 &&
        this.toolTurns >= maxToolTurns - finalResponseReserveToolTurns
      )
        this.closeoutReason = "tool_turns";
    };
    const withoutToolsDuringCloseout = (args: unknown[]): unknown[] => {
      if (this.closeoutReason === undefined) return args;
      const context = args[1];
      if (
        context === null ||
        typeof context !== "object" ||
        !("messages" in context) ||
        !Array.isArray(context.messages)
      )
        return args;
      const next = [...args];
      next[1] = { ...context, tools: [] };
      return next;
    };
    const settle = (message: AssistantMessage | undefined) => {
      if (message === undefined) return this.failUnknownCost();
      this.observeUsage(message.usage.input + message.usage.cacheRead, message.usage.cost.total);
    };
    return new Proxy(models, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || typeof value !== "function") return value;
        if (promiseMethods.has(property))
          return (...args: unknown[]) => {
            try {
              reserve();
              prepareCloseout();
            } catch (error) {
              return Promise.reject(error);
            }
            let operation: Promise<AssistantMessage>;
            try {
              operation = Reflect.apply(
                value,
                target,
                withoutToolsDuringCloseout(args),
              ) as Promise<AssistantMessage>;
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
            reserve();
            prepareCloseout();
            let stream: { result(): Promise<AssistantMessage> };
            try {
              stream = Reflect.apply(
                value,
                target,
                withoutToolsDuringCloseout(args),
              ) as typeof stream;
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
    if (limit > 0 && observed >= limit)
      throw new StageLimitError(reason, limit, observed, this.snapshot());
  }
}
