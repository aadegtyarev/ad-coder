import { expect, test } from "bun:test";
import type { Models } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  DEFAULT_STAGE_LIMITS,
  projectRemainingStageBudget,
  StageCloseoutError,
  StageLimitController,
  StageLimitError,
} from "../src/orchestration/stage-limits";

test("stage limits default to zero-disabled and count admitted work", () => {
  const controller = new StageLimitController();
  controller.admitModelTurn();
  controller.admitToolTurn();
  controller.observeUsage(25, 0.5);
  expect(controller.snapshot()).toEqual({
    ...DEFAULT_STAGE_LIMITS,
    elapsedMs: expect.any(Number),
    modelTurns: 1,
    toolTurns: 1,
    inputTokens: 25,
    lastInputTokens: 25,
    costUsd: 0.5,
    costInFlight: false,
  });
  expect(() => controller.assertActive()).not.toThrow();
});

test("remaining budget projection is numeric, omits disabled ceilings, and respects tool closeout", () => {
  let now = 0;
  const controller = new StageLimitController(
    {
      maxDurationMs: 100,
      maxModelTurns: 4,
      maxToolTurns: 5,
      maxInputTokens: 20,
      maxCostUsd: 1,
      finalResponseReserveToolTurns: 2,
    },
    () => now,
  );
  controller.admitModelTurn();
  controller.observeUsage(6, 0.25);
  controller.admitToolTurn();
  now = 40;
  expect(projectRemainingStageBudget(controller.snapshot())).toEqual({
    durationMs: 60,
    modelTurns: 3,
    toolTurns: 4,
    inputTokens: 14,
    costUsd: 0.75,
    toolTurnsBeforeCloseout: 2,
  });
});

test("each stage boundary blocks the next admission at equality", () => {
  let now = 10;
  const duration = new StageLimitController({ maxDurationMs: 5 }, () => now);
  now = 15;
  expect(() => duration.assertActive()).toThrow(StageLimitError);

  const model = new StageLimitController({ maxModelTurns: 1 });
  model.admitModelTurn();
  expect(() => model.admitModelTurn()).toThrow(StageLimitError);

  const tool = new StageLimitController({ maxToolTurns: 1 });
  tool.admitToolTurn();
  expect(() => tool.admitToolTurn()).toThrow(StageLimitError);

  const input = new StageLimitController({ maxInputTokens: 10 });
  input.observeUsage(10, 0);
  expectStageLimit(input, "input");

  const cost = new StageLimitController({ maxCostUsd: 0.25 });
  cost.observeUsage(0, 0.25);
  expectStageLimit(cost, "cost");
});

test("closeout reserve rejects tools while preserving final model capacity", () => {
  const controller = new StageLimitController({
    maxModelTurns: 4,
    finalResponseReserveModelTurns: 2,
  });
  controller.admitModelTurn();
  controller.observeUsage(1, 0);
  controller.admitToolTurn();
  controller.admitModelTurn();
  controller.observeUsage(1, 0);
  expect(() => controller.admitToolTurn()).toThrow(
    /stop using tools and return the final response/,
  );
  expect(() => controller.admitModelTurn()).not.toThrow();
});

test("duration closeout reserve rejects tools before the hard deadline", () => {
  let now = 0;
  const controller = new StageLimitController(
    { maxDurationMs: 100, finalResponseReserveDurationMs: 20 },
    () => now,
  );
  now = 79;
  expect(() => controller.admitToolTurn()).not.toThrow();
  now = 80;
  expect(() => controller.admitToolTurn()).toThrow(
    /stop using tools and return the final response/,
  );
  expect(() => controller.admitModelTurn()).not.toThrow();
});

test("tool closeout reserve stops batches before the hard tool limit", () => {
  const controller = new StageLimitController({
    maxToolTurns: 4,
    finalResponseReserveToolTurns: 2,
  });
  controller.admitToolTurn();
  controller.admitToolTurn();
  try {
    controller.admitToolTurn();
    throw new Error("expected closeout reserve");
  } catch (error) {
    expect(error).toBeInstanceOf(StageCloseoutError);
    expect(error).toMatchObject({ code: "stage_closeout", reason: "tool_turns" });
  }
  expect(() => controller.admitModelTurn()).not.toThrow();
});

test("input closeout reserve stops tools while preserving the hard input boundary", () => {
  const controller = new StageLimitController({
    maxInputTokens: 100,
    finalResponseReserveInputTokens: 25,
  });
  controller.observeUsage(74, 0);
  expect(() => controller.admitToolTurn()).not.toThrow();
  controller.observeUsage(1, 0);
  expect(() => controller.admitToolTurn()).toThrow(
    /stop using tools and return the final response/,
  );
  expect(controller.snapshot()).toMatchObject({
    inputTokens: 75,
    finalResponseReserveInputTokens: 25,
  });
  expect(() => controller.admitModelTurn()).not.toThrow();
});

test("an enabled cost budget permits only one unsettled model admission", () => {
  const controller = new StageLimitController({ maxCostUsd: 1 });
  controller.admitModelTurn();
  try {
    controller.admitModelTurn();
    throw new Error("expected stage limit");
  } catch (error) {
    expect(error).toBeInstanceOf(StageLimitError);
    expect((error as StageLimitError).reason).toBe("cost_in_flight");
  }
  expect(controller.snapshot()).toMatchObject({ modelTurns: 1, costInFlight: true });
  controller.observeUsage(4, 0.25);
  expect(() => controller.admitModelTurn()).not.toThrow();
});

function expectStageLimit(controller: StageLimitController, reason: StageLimitError["reason"]) {
  try {
    controller.assertActive();
    throw new Error("expected stage limit");
  } catch (error) {
    expect(error).toBeInstanceOf(StageLimitError);
    expect((error as StageLimitError).reason).toBe(reason);
  }
}

test("stage configuration and observed usage reject unsafe numbers", () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => new StageLimitController({ maxModelTurns: value })).toThrow(TypeError);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => new StageLimitController({ maxCostUsd: value })).toThrow(TypeError);
  const controller = new StageLimitController();
  expect(() => controller.observeUsage(-1, 0)).toThrow(TypeError);
  expect(() => controller.observeUsage(0, Number.NaN)).toThrow(TypeError);
});

test("models wrapper meters every provider turn and blocks before dispatch", async () => {
  let calls = 0;
  const message = fauxAssistantMessage("ok");
  message.usage.input = 7;
  message.usage.cacheRead = 3;
  message.usage.cost.total = 0.2;
  const models = {
    completeSimple: async () => {
      calls += 1;
      return message;
    },
  } as unknown as Models;
  const controller = new StageLimitController({ maxModelTurns: 1 });
  const limited = controller.wrap(models);
  await limited.completeSimple({} as never, {} as never);
  await expect(limited.completeSimple({} as never, {} as never)).rejects.toMatchObject({
    code: "stage_limit",
    reason: "model_turns",
  });
  expect(calls).toBe(1);
  expect(controller.snapshot()).toMatchObject({ inputTokens: 10, costUsd: 0.2 });
});

test("input closeout predicts the next request from prior provider usage", async () => {
  const visibleToolCounts: number[] = [];
  const message = fauxAssistantMessage("ok");
  message.usage.input = 100;
  message.usage.cacheRead = 0;
  const models = {
    completeSimple: async (_model: unknown, context: { tools?: unknown[] }) => {
      visibleToolCounts.push(context.tools?.length ?? 0);
      return message;
    },
  } as unknown as Models;
  const controller = new StageLimitController({
    maxInputTokens: 300,
    finalResponseReserveInputTokens: 100,
  });
  const limited = controller.wrap(models);
  const context = { messages: [], tools: [{}] } as never;

  await limited.completeSimple({} as never, context);
  await limited.completeSimple({} as never, context);

  expect(visibleToolCounts).toEqual([1, 0]);
  expect(controller.snapshot().inputTokens).toBe(200);
});

test("input closeout prediction survives controller reconstruction", async () => {
  const message = fauxAssistantMessage("ok");
  message.usage.input = 100;
  message.usage.cacheRead = 0;
  const firstModels = {
    completeSimple: async () => message,
  } as unknown as Models;
  const limits = { maxInputTokens: 300, finalResponseReserveInputTokens: 100 };
  const first = new StageLimitController(limits);
  await first.wrap(firstModels).completeSimple({} as never, { messages: [], tools: [{}] } as never);

  let resumedTools: number | undefined;
  const resumedModels = {
    completeSimple: async (_model: unknown, context: { tools?: unknown[] }) => {
      resumedTools = context.tools?.length ?? 0;
      return message;
    },
  } as unknown as Models;
  const resumed = new StageLimitController(limits, undefined, first.snapshot());
  await resumed
    .wrap(resumedModels)
    .completeSimple({} as never, { messages: [], tools: [{}] } as never);

  expect(resumedTools).toBe(0);
  expect(resumed.snapshot()).toMatchObject({ inputTokens: 200, lastInputTokens: 100 });
});
