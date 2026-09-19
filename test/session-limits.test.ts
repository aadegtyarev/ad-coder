import { expect, test } from "bun:test";
import type { AssistantMessage, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionLimitController, SessionLimitError } from "../src/session-limits";

function message(cost: number): AssistantMessage {
  const result = fauxAssistantMessage("ok");
  // `fauxAssistantMessage` shares ONE module-global usage object across the
  // process; split it before mutating so this file cannot rewire the default
  // usage other files' faux messages see.
  result.usage = { ...result.usage, cost: { ...result.usage.cost, total: cost } };
  return result;
}

function settledMessage(cost: number, stopReason: "error" | "aborted"): AssistantMessage {
  const result = message(cost);
  result.stopReason = stopReason;
  result.errorMessage = `provider ${stopReason}`;
  return result;
}

function fakeModels(calls: string[], cost = 0.25): Models {
  const stream = (name: string) => {
    calls.push(name);
    const events = createAssistantMessageEventStream();
    events.end(message(cost));
    return events;
  };
  const complete = async (name: string) => {
    calls.push(name);
    return message(cost);
  };
  return {
    stream: () => stream("stream"),
    complete: () => complete("complete"),
    streamSimple: () => stream("streamSimple"),
    completeSimple: () => complete("completeSimple"),
    streamDeferred: () => stream("streamDeferred"),
    fetchDeferred: () => complete("fetchDeferred"),
    cancelDeferred: async () => {
      calls.push("cancelDeferred");
    },
    getProviders: () => [],
    getProvider: () => undefined,
    getModels: () => [],
    getModel: () => undefined,
    refresh: async () => ({ refreshed: [], skipped: [], failed: [] }),
    checkAuth: async () => undefined,
    getAvailable: async () => [],
    getAuth: async () => undefined,
    login: async () => {
      throw new Error("not used");
    },
    logout: async () => {},
  } as unknown as Models;
}

test("zero and omitted session limits admit all six generation methods without counting cancel", async () => {
  for (const limits of [undefined, { maxTurns: 0, maxCostUsd: 0 }]) {
    const calls: string[] = [];
    const controller = new SessionLimitController(limits);
    const models = controller.wrap(fakeModels(calls));
    await models.stream({} as never, {} as never).result();
    await models.complete({} as never, {} as never);
    await models.streamSimple({} as never, {} as never).result();
    await models.completeSimple({} as never, {} as never);
    await models.streamDeferred({} as never, {} as never).result();
    await models.fetchDeferred({} as never, {} as never);
    await models.cancelDeferred({} as never, {} as never);
    expect(controller.snapshot().admittedTurns).toBe(6);
    expect(calls).toEqual([
      "stream",
      "complete",
      "streamSimple",
      "completeSimple",
      "streamDeferred",
      "fetchDeferred",
      "cancelDeferred",
    ]);
  }
});

test("turn and cost equality block before provider dispatch", async () => {
  const calls: string[] = [];
  const turns = new SessionLimitController({ maxTurns: 1 }).wrap(fakeModels(calls));
  await turns.completeSimple({} as never, {} as never);
  await expect(turns.completeSimple({} as never, {} as never)).rejects.toBeInstanceOf(
    SessionLimitError,
  );
  expect(calls).toHaveLength(1);

  const costController = new SessionLimitController({ maxCostUsd: 0.25 });
  const cost = costController.wrap(fakeModels(calls));
  await cost.completeSimple({} as never, {} as never);
  await expect(cost.completeSimple({} as never, {} as never)).rejects.toBeInstanceOf(
    SessionLimitError,
  );
  expect(costController.snapshot().observedCostUsd).toBe(0.25);
});

test("invalid limits fail loudly", () => {
  for (const maxTurns of [-1, 1.5, Number.NaN]) {
    expect(() => new SessionLimitController({ maxTurns })).toThrow(TypeError);
  }
  for (const maxCostUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => new SessionLimitController({ maxCostUsd })).toThrow(TypeError);
  }
});

test("cost-unknown concurrency and rejected settlement fail closed", async () => {
  let resolveFirst: ((message: AssistantMessage) => void) | undefined;
  let calls = 0;
  const pending = new Promise<AssistantMessage>((resolve) => {
    resolveFirst = resolve;
  });
  const models = {
    completeSimple: () => {
      calls += 1;
      return pending;
    },
  } as unknown as Models;
  const controller = new SessionLimitController({ maxCostUsd: 1 });
  const limited = controller.wrap(models);
  const first = limited.completeSimple({} as never, {} as never);
  await expect(limited.completeSimple({} as never, {} as never)).rejects.toBeInstanceOf(
    SessionLimitError,
  );
  expect(calls).toBe(1);
  resolveFirst?.(message(2));
  await first;
  expect(controller.snapshot().observedCostUsd).toBe(2);
  await expect(limited.completeSimple({} as never, {} as never)).rejects.toBeInstanceOf(
    SessionLimitError,
  );

  const rejecting = {
    completeSimple: async () => {
      throw new Error("transport");
    },
  } as unknown as Models;
  const failed = new SessionLimitController({ maxCostUsd: 5 });
  await expect(failed.wrap(rejecting).completeSimple({} as never, {} as never)).rejects.toThrow(
    "transport",
  );
  expect(failed.snapshot().terminalReason).toBe("cost_unknown");
  expect(() => failed.assertActive()).toThrow(SessionLimitError);
});

test("stream rejection without usage poisons enabled cost accounting", async () => {
  const rejecting = {
    streamSimple: () => ({ result: async () => Promise.reject(new Error("stream")) }),
  } as unknown as Models;
  const controller = new SessionLimitController({ maxCostUsd: 5 });
  const stream = controller.wrap(rejecting).streamSimple({} as never, {} as never);
  await expect(stream.result()).rejects.toThrow("stream");
  await Promise.resolve();
  expect(controller.snapshot().terminalReason).toBe("cost_unknown");
});

test("resolved error and aborted messages retain their trustworthy usage", async () => {
  for (const [method, stopReason] of [
    ["completeSimple", "error"],
    ["streamDeferred", "aborted"],
  ] as const) {
    const settled = settledMessage(0.375, stopReason);
    const models =
      method === "completeSimple"
        ? ({ completeSimple: async () => settled } as unknown as Models)
        : ({
            streamDeferred: () => {
              const stream = createAssistantMessageEventStream();
              stream.end(settled);
              return stream;
            },
          } as unknown as Models);
    const controller = new SessionLimitController({ maxCostUsd: 1 });
    const limited = controller.wrap(models);
    if (method === "completeSimple") {
      await limited.completeSimple({} as never, {} as never);
    } else {
      await limited.streamDeferred({} as never, {} as never).result();
      await Promise.resolve();
    }
    expect(controller.snapshot().observedCostUsd).toBe(0.375);
    expect(controller.snapshot().terminalReason).toBeUndefined();
  }
});

test("invalid settled usage poisons an enabled cost controller", async () => {
  for (const invalidCost of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const invalid = message(0);
    invalid.usage.cost.total = invalidCost;
    let calls = 0;
    const models = {
      completeSimple: async () => {
        calls += 1;
        return invalid;
      },
    } as unknown as Models;
    const controller = new SessionLimitController({ maxCostUsd: 1 });
    const limited = controller.wrap(models);
    await limited.completeSimple({} as never, {} as never);
    expect(controller.snapshot().terminalReason).toBe("cost_unknown");
    await expect(limited.completeSimple({} as never, {} as never)).rejects.toBeInstanceOf(
      SessionLimitError,
    );
    expect(calls).toBe(1);
  }
});
