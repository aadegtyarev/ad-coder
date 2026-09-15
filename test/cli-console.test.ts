import { expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runConsole } from "../src/cli/console";
import {
  CONSOLE_COMMANDS,
  ConsoleControlError,
  consoleCommandNames,
  consoleCommandUsage,
  executeConsoleControl,
  findConsoleCommand,
} from "../src/conversation/console-control";
import {
  type ConversationSession,
  type ConversationTurnResult,
  startConversation,
  TurnInterruptedError,
} from "../src/conversation/conversation";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import {
  BackgroundRunManager,
  type BackgroundRunNotice,
} from "../src/orchestration/background-runs";
import { defineRole, type Role } from "../src/role";
import { EmptyTurnError, ProviderRejectionError } from "../src/runner/errors";
import { SessionLimitError } from "../src/session-limits";

class Capture extends Writable {
  chunks: string[] = [];
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: (error?: Error) => void,
  ): void {
    this.chunks.push(chunk.toString());
    done();
  }
  text(): string {
    return this.chunks.join("");
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function rawInput(): PassThrough & {
  isTTY: boolean;
  isRaw?: boolean;
  setRawMode: (enabled: boolean) => void;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw?: boolean;
    setRawMode: (enabled: boolean) => void;
  };
  input.isTTY = true;
  input.setRawMode = (enabled) => {
    input.isRaw = enabled;
  };
  return input;
}

function fakeSession(
  options: {
    result?: (input: string, turn: number) => ConversationTurnResult;
    stepError?: Error;
    closeError?: Error;
  } = {},
): ConversationSession & { inputs: string[]; closes: number } {
  return {
    runId: "session",
    ledgerPath: undefined,
    inputs: [],
    closes: 0,
    async step(input) {
      this.inputs.push(input);
      if (options.stepError !== undefined) throw options.stepError;
      const turn = this.inputs.length;
      return (
        options.result?.(input, turn) ?? {
          runId: `run-${turn}`,
          step: `turn:${turn}`,
          status: "ok",
          assistantText: `reply ${input}`,
          toolCalls: [],
          droppedRecords: 0,
        }
      );
    },
    async close() {
      this.closes++;
      if (options.closeError !== undefined) throw options.closeError;
    },
  };
}

test("keeps one session across ordered turns, ignores blanks, and closes once on exit", async () => {
  const session = fakeSession();
  const output = new Capture();
  const error = new Capture();
  const result = await runConsole({
    session,
    input: Readable.from([" first\n\n", "second\r\n/exit\nignored\n"]),
    output,
    error,
  });

  expect(session.inputs).toEqual([" first", "second"]);
  expect(session.closes).toBe(1);
  expect(result).toEqual({ reason: "exit", completedTurns: 2 });
  expect(output.text()).toContain("ad-coder console");
  expect(output.text()).toContain("reply  first");
  expect(error.text()).toBe(
    "ad-coder: console turn started (0s)\nad-coder: console turn started (0s)\n",
  );
});

test("counts UTF-8 bytes across chunks and rejects an oversized line before step", async () => {
  const bytes = Buffer.from("éé\nnext\n");
  const session = fakeSession();
  const error = new Capture();
  const result = await runConsole({
    session,
    input: Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3)]),
    output: new Capture(),
    error,
    maxInputBytes: 3,
  });

  expect(result).toEqual({ reason: "input_too_large", completedTurns: 0 });
  expect(session.inputs).toEqual([]);
  expect(session.closes).toBe(1);
  expect(error.text()).toContain("input line exceeds the configured byte limit");
  expect(error.text()).toContain("send a shorter line");
});

test("reports a cooperative interruption separately from a provider failure", async () => {
  const session = fakeSession({ stepError: new Error("transport closed") });
  const error = new Capture();
  const result = await runConsole({
    session,
    input: Readable.from(["work\n"]),
    output: new Capture(),
    error,
    interrupted: () => true,
  });

  expect(result).toEqual({ reason: "interrupted", completedTurns: 0 });
  expect(error.text()).toContain("console turn interrupted");
  expect(error.text()).not.toContain("console turn failed");
  expect(session.closes).toBe(1);
});

test("empty provider turns show an actionable authentication command", async () => {
  const error = new Capture();
  await runConsole({
    session: fakeSession({ stepError: new EmptyTurnError("run") }),
    input: Readable.from("hello\n"),
    output: new Capture(),
    error,
    authenticationCommand: "ad-coder auth login --provider openrouter --target-dir '/tmp/project'",
  });
  expect(error.text()).toContain(
    "run: ad-coder auth login --provider openrouter --target-dir '/tmp/project'",
  );
});

test("a provider rejection points at the request, never at authentication", async () => {
  const error = new Capture();
  await runConsole({
    session: fakeSession({ stepError: new ProviderRejectionError("run", 400) }),
    input: Readable.from("hello\n"),
    output: new Capture(),
    error,
    authenticationCommand: "ad-coder auth login --provider openrouter --target-dir '/tmp/project'",
  });
  expect(error.text()).toContain("provider rejected the request with HTTP 400");
  expect(error.text()).toContain("inspect the request this role sends");
  // An authentication command is configured and must still NOT be offered: the
  // provider answered, so credentials are not the thing to check.
  expect(error.text()).not.toContain("auth login");
});

test("JSON mode emits narrowed parseable sanitized records without prompts", async () => {
  const session = fakeSession({
    result: () => ({
      runId: "run\u001b[31m-red",
      step: "turn\u009b2J:1",
      status: "o\u0007k",
      assistantText:
        "safe\u001b]0;secret\u0007 text\u001bPpayload\u001b\\ c1\u009dtitle\u009c \u0090payload\u009cend\b!",
      toolCalls: [{ toolName: "ba\u001b[1msh", toolCallId: "id\u007f" }],
      droppedRecords: 2,
    }),
  });
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from("hello\n"),
    output,
    error: new Capture(),
    mode: "json",
  });

  expect(output.text()).not.toContain("ad-coder>");
  const lines = output.text().trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  const record = JSON.parse(lines[0] as string) as Record<string, unknown>;
  expect(Object.keys(record)).toEqual([
    "runId",
    "step",
    "status",
    "assistantText",
    "toolCalls",
    "droppedRecords",
  ]);
  expect(record).toEqual({
    runId: "run-red",
    step: "turn:1",
    status: "ok",
    assistantText: "safe text c1 end!",
    toolCalls: [{ toolName: "bash", toolCallId: "id" }],
    droppedRecords: 2,
  });
  expect(
    [...output.text()].some((character) => {
      const code = character.codePointAt(0) as number;
      return code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    }),
  ).toBe(false);
});

test("incomplete terminal sequences are removed from formatted output", async () => {
  const session = fakeSession({
    result: () => ({
      runId: "run",
      step: "turn:1",
      status: "ok",
      assistantText: "visible\u001b]unfinished secret",
      toolCalls: [],
      droppedRecords: 0,
    }),
  });
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from("hello\n"),
    output,
    error: new Capture(),
  });
  expect(output.text()).toContain("visible");
  expect(output.text()).not.toContain("unfinished secret");
  expect(output.text()).not.toContain("\u001b");
});

test("turn and close failures use fixed messages and close once", async () => {
  const secret = "credential=super-secret";
  const session = fakeSession({ stepError: new Error(secret), closeError: new Error(secret) });
  const error = new Capture();
  const result = await runConsole({
    session,
    input: Readable.from("hello\nnext\n"),
    output: new Capture(),
    error,
    mode: "json",
  });
  expect(result).toEqual({ reason: "turn_failed", completedTurns: 0 });
  expect(session.inputs).toEqual(["hello"]);
  expect(session.closes).toBe(1);
  expect(error.text()).toContain('"code":"turn_failed"');
  expect(error.text()).toContain("console session close failed");
  expect(error.text()).not.toContain(secret);
});

test("typed session exhaustion stops input with no fabricated JSON record", async () => {
  const session = fakeSession({ stepError: new SessionLimitError("turns", 1, 1) });
  const output = new Capture();
  const error = new Capture();
  const result = await runConsole({
    session,
    input: Readable.from("first\nsecond\n"),
    output,
    error,
    mode: "json",
  });
  expect(result).toEqual({ reason: "session_limit", completedTurns: 0 });
  expect(session.inputs).toEqual(["first"]);
  expect(session.closes).toBe(1);
  expect(output.text()).toBe("");
  expect(error.text()).toBe(
    '{"type":"progress","event":"started","stage":"console-turn","elapsedSeconds":0}\n' +
      `${JSON.stringify({
        type: "console_error",
        code: "session_limit",
        message: "session resource limit reached",
        action: "restart the console to start a session with a fresh budget",
        retryable: false,
      })}\n`,
  );
});

test("rejects invalid programmatic byte limits and still closes EOF exactly once", async () => {
  const invalidSession = fakeSession();
  await expect(
    runConsole({
      session: invalidSession,
      input: Readable.from(""),
      output: new Capture(),
      error: new Capture(),
      maxInputBytes: 0,
    }),
  ).rejects.toThrow("positive integer");
  expect(invalidSession.closes).toBe(0);

  const eofSession = fakeSession();
  const result = await runConsole({
    session: eofSession,
    input: Readable.from(""),
    output: new Capture(),
    error: new Capture(),
  });
  expect(result.reason).toBe("eof");
  expect(eofSession.closes).toBe(1);
});

test("an in-flight console turn reports structured progress on stderr", async () => {
  const session = fakeSession();
  const originalStep = session.step.bind(session);
  session.step = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 12));
    return originalStep(input);
  };
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("hello\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
    heartbeatMs: 5,
  });
  const progress = error
    .text()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(progress[0]).toEqual({
    type: "progress",
    event: "started",
    stage: "console-turn",
    elapsedSeconds: 0,
  });
  expect(progress.some(({ event }) => event === "heartbeat")).toBe(true);
});

test("semantic activity resets heartbeat inactivity", async () => {
  const session = fakeSession();
  let consumer:
    | Parameters<NonNullable<ConversationSession["subscribeToolActivity"]>>[0]
    | undefined;
  session.subscribeToolActivity = (next) => {
    consumer = next;
    return () => {
      consumer = undefined;
    };
  };
  const originalStep = session.step.bind(session);
  session.step = async (input) => {
    for (let sequence = 1; sequence <= 4; sequence++) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      consumer?.({
        schemaVersion: 1,
        type: "tool_activity",
        sequence,
        timestamp: "2026-01-01T00:00:00.000Z",
        lifecycle: "started",
        activity: "Read",
        role: "coder",
        runId: "run",
        operationId: "op",
        turnId: "turn",
        toolCallId: `call-${sequence}`,
        parentOperation: "step",
        toolName: "read",
        droppedCount: 0,
      });
    }
    return originalStep(input);
  };
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("hello\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
    heartbeatMs: 10,
  });
  const records = error
    .text()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.filter(({ event }) => event === "heartbeat")).toEqual([]);
  expect(records.filter(({ type }) => type === "tool_activity")).toHaveLength(4);
});

test("background notices render on stderr while input queues without starting model turns", async () => {
  const input = new PassThrough();
  const session = fakeSession();
  const originalStep = session.step.bind(session);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  session.step = async (line) => {
    if (session.inputs.length === 0) await firstGate;
    return originalStep(line);
  };
  let backgroundConsumer:
    | Parameters<NonNullable<ConversationSession["subscribeBackgroundRuns"]>>[0]
    | undefined;
  let unsubscribed = 0;
  session.subscribeBackgroundRuns = (consumer) => {
    backgroundConsumer = consumer;
    return () => {
      backgroundConsumer = undefined;
      unsubscribed++;
    };
  };
  const error = new Capture();
  const running = runConsole({
    session,
    input,
    output: new Capture(),
    error,
    mode: "json",
  });

  input.write("first\n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.inputs).toEqual([]);
  const hostileNotice = {
    type: "background_events",
    runId: "pipeline-1",
    events: [
      {
        sequence: 2,
        runId: "pipeline-1",
        lifecycle: "stage_changed",
        stage: "code",
        timestamp: 1,
        metrics: { steps: 1, totalCost: 0 },
        secretEventField: "SECRET EVENT",
      },
      {
        sequence: 3,
        runId: "pipeline-1",
        lifecycle: "completed",
        timestamp: 2,
        metrics: { steps: 1, totalCost: 0 },
      },
    ],
    nextCursor: 3,
    gap: false,
    droppedEvents: 0,
    pending: false,
    secretNoticeField: "SECRET NOTICE",
  } as unknown as BackgroundRunNotice;
  backgroundConsumer?.(hostileNotice);
  input.write("second\n/exit\n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.inputs).toEqual([]);
  const notice = error
    .text()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find(({ type }) => type === "background_events");
  expect(notice.events.map(({ lifecycle }: { lifecycle: string }) => lifecycle)).toEqual([
    "stage_changed",
    "completed",
  ]);
  expect(Object.keys(notice)).toEqual([
    "type",
    "runId",
    "events",
    "nextCursor",
    "gap",
    "droppedEvents",
    "pending",
  ]);
  expect(error.text()).not.toContain("SECRET TASK OR RESULT");
  expect(error.text()).not.toContain("SECRET EVENT");
  expect(error.text()).not.toContain("SECRET NOTICE");

  releaseFirst();
  input.end();
  const result = await running;
  expect(result).toEqual({ reason: "exit", completedTurns: 2 });
  expect(session.inputs).toEqual(["first", "second"]);
  expect(unsubscribed).toBe(1);
});

test("formatted background notices are content-free and do not call step", async () => {
  const session = fakeSession();
  session.subscribeBackgroundRuns = (consumer) => {
    consumer({
      type: "background_events",
      runId: "safe-run",
      events: [
        {
          sequence: 1,
          runId: "safe-run",
          lifecycle: "started",
          timestamp: 1,
        },
      ],
      nextCursor: 1,
      gap: false,
      droppedEvents: 2,
      pending: true,
    });
    return () => undefined;
  };
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/exit\n"),
    output: new Capture(),
    error,
  });
  expect(session.inputs).toEqual([]);
  expect(error.text()).toContain("background pipeline safe-run started");
  expect(error.text()).toContain("dropped 2 events");
  expect(error.text()).toContain("poll pipeline_events");
});

test("formatted background notices enum-project hostile fields and remove terminal escapes", async () => {
  const session = fakeSession();
  session.subscribeBackgroundRuns = (consumer) => {
    consumer({
      type: "background_events",
      runId: "safe\u001b[2J-run",
      events: [
        {
          sequence: 1,
          runId: "event\u001b]0;title\u0007",
          lifecycle: "started",
          stage: "code\u001b[31m",
          timestamp: 1,
        },
        {
          sequence: 2,
          runId: "event",
          lifecycle: "completed\u001b[2J",
          timestamp: 2,
        },
      ],
      nextCursor: 2,
      gap: false,
      droppedEvents: "2\u001b[2J" as unknown as number,
      pending: true,
    } as unknown as BackgroundRunNotice);
    return () => undefined;
  };
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/exit\n"),
    output: new Capture(),
    error,
  });
  expect(error.text()).toContain("background pipeline safe-run started");
  expect(error.text()).not.toContain("code\u001b");
  expect(error.text()).not.toContain("completed");
  expect(error.text()).not.toContain("dropped");
  expect(
    [...error.text()].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
    }),
  ).toBe(false);
});

test("TTY Escape aborts only the in-flight conversation turn and leaves detached work available", async () => {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw?: boolean;
    setRawMode: (enabled: boolean) => void;
  };
  input.isTTY = true;
  const rawModes: boolean[] = [];
  input.setRawMode = (enabled) => {
    rawModes.push(enabled);
    input.isRaw = enabled;
  };
  const detached = new BackgroundRunManager(
    async () => {
      throw new Error("detached worker must not run in the console process");
    },
    {},
    undefined,
    "console-owner",
    () => undefined,
  );
  const run = await detached.startDetached("detached task");
  let rejectFirst: ((error: Error) => void) | undefined;
  let interrupted = 0;
  const session = fakeSession();
  session.step = async (line) => {
    session.inputs.push(line);
    if (line === "first") {
      return new Promise<ConversationTurnResult>((_resolve, reject) => {
        rejectFirst = reject;
      });
    }
    return {
      runId: "session",
      step: "turn:2",
      status: "ok",
      assistantText: "second reply",
      toolCalls: [],
      droppedRecords: 0,
    };
  };
  session.interrupt = async () => {
    interrupted++;
    rejectFirst?.(new TurnInterruptedError());
    return true;
  };
  const output = new Capture();
  const error = new Capture();
  const running = runConsole({
    session,
    input,
    output,
    error,
    escapeSequenceTimeoutMs: 20,
  });

  input.write("first\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  input.write("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 35));
  expect(interrupted).toBe(1);
  input.write("second\r/exit\r");
  input.end();

  expect(await running).toEqual({ reason: "exit", completedTurns: 1 });
  expect(session.inputs).toEqual(["first", "second"]);
  expect(session.closes).toBe(1);
  expect(detached.status(run.runId).lifecycle).toBe("requested");
  expect(rawModes).toEqual([true, false]);
  expect(error.text()).toContain("current turn interrupted");
  await detached.close(true);
});

test("console-local background controls use headless APIs without model turns", async () => {
  const runId = "123e4567-e89b-12d3-a456-426614174000";
  const calls: string[] = [];
  const backgroundRuns = {
    list: () => {
      calls.push("list");
      return [
        { runId, lifecycle: "started", metrics: { steps: 2, totalCost: 1.5 }, recovery: "wait" },
      ];
    },
    events: () => {
      calls.push("events");
      return {
        events: [{ sequence: 1, runId, lifecycle: "stage_changed", timestamp: 1, stage: "code" }],
        nextCursor: 1,
        gap: false,
      };
    },
    status: () => {
      calls.push("status");
      return {
        runId,
        lifecycle: "started",
        metrics: { steps: 2, totalCost: 1.5 },
        recovery: "wait",
      };
    },
    result: () => {
      calls.push("result");
      return {
        runId,
        lifecycle: "completed",
        metrics: { steps: 3, totalCost: 2 },
        recovery: "none",
        approved: true,
      };
    },
    cancel: () => {
      calls.push("cancel");
      return {
        runId,
        lifecycle: "cancelled",
        metrics: { steps: 2, totalCost: 1.5 },
        recovery: "none",
      };
    },
  } as unknown as BackgroundRunManager;
  const session = fakeSession() as ConversationSession & {
    inputs: string[];
    closes: number;
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = backgroundRuns;
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from(
      `/list\n/events ${runId}\n/status ${runId}\n/result ${runId}\n/cancel ${runId}\n/exit\n`,
    ),
    output,
    error: new Capture(),
    mode: "json",
  });

  expect(session.inputs).toEqual([]);
  expect(calls).toEqual(["list", "events", "status", "result", "cancel"]);
  const records = output
    .text()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.map(({ type }) => type)).toEqual([
    "background_list",
    "background_events",
    "background_status",
    "background_result",
    "background_cancel",
  ]);
  expect(records[1].events).toEqual([
    { sequence: 1, runId, lifecycle: "stage_changed", timestamp: 1, stage: "code" },
  ]);
  expect(records[3].result).toMatchObject({ runId, lifecycle: "completed", approved: true });
});

test("local status runs while a foreground turn is pending", async () => {
  const input = new PassThrough();
  const turnStarted = deferred();
  const statusCalled = deferred();
  const session = fakeSession() as ConversationSession & {
    inputs: string[];
    closes: number;
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = {
    status: () => {
      statusCalled.resolve();
      return {
        runId: "123e4567-e89b-12d3-a456-426614174000",
        lifecycle: "started",
        metrics: { steps: 0, totalCost: 0 },
      };
    },
  } as unknown as BackgroundRunManager;
  const interrupted = deferred();
  session.step = async (line) => {
    session.inputs.push(line);
    turnStarted.resolve();
    await interrupted.promise;
    throw new TurnInterruptedError();
  };
  session.interrupt = async () => {
    interrupted.resolve();
    return true;
  };
  const running = runConsole({ session, input, output: new Capture(), error: new Capture() });

  input.write("foreground\n");
  await turnStarted.promise;
  input.write("/status 123e4567-e89b-12d3-a456-426614174000\n");
  await statusCalled.promise;
  expect(session.inputs).toEqual(["foreground"]);

  input.write("/exit\n");
  input.end();
  expect(await running).toEqual({ reason: "exit", completedTurns: 0 });
});

test("exit and raw terminal interrupts settle pending turns without cancelling detached work", async () => {
  for (const [name, control] of [
    ["exit", "/exit\r"],
    ["Ctrl-C", "\u0003"],
    ["Ctrl-D", "\u0004"],
  ] as const) {
    const input = rawInput();
    const started = deferred();
    const interrupted = deferred();
    const detached = new BackgroundRunManager(
      async () => {
        throw new Error("detached worker must not run in the console process");
      },
      {},
      undefined,
      "console-owner",
      async () => undefined,
    );
    const run = await detached.startDetached("must survive foreground interrupt");
    const session = fakeSession();
    session.step = async (line) => {
      session.inputs.push(line);
      started.resolve();
      await interrupted.promise;
      throw new TurnInterruptedError();
    };
    session.interrupt = async () => {
      interrupted.resolve();
      return true;
    };
    const running = runConsole({ session, input, output: new Capture(), error: new Capture() });
    input.write("foreground\r");
    await started.promise;
    input.write(control);
    input.end();

    expect(await running).toMatchObject({ reason: name === "Ctrl-D" ? "eof" : "exit" });
    expect(detached.status(run.runId).lifecycle).toBe("requested");
    await detached.close(true);
  }
});

test("raw CSI and SS3 cursor sequences never become foreground prompt text", async () => {
  const input = rawInput();
  const started = deferred();
  const interrupted = deferred();
  const session = fakeSession();
  session.step = async (line) => {
    session.inputs.push(line);
    started.resolve();
    await interrupted.promise;
    throw new TurnInterruptedError();
  };
  session.interrupt = async () => {
    interrupted.resolve();
    return true;
  };
  const running = runConsole({ session, input, output: new Capture(), error: new Capture() });
  input.write("foreground\r");
  await started.promise;
  input.write("\u001b[A\u001bOA\u0003");
  input.end();

  await running;
  expect(session.inputs).toEqual(["foreground"]);
});

test("raw formatted input echoes text, newline, and destructive backspace", async () => {
  const input = rawInput();
  const output = new Capture();
  const session = fakeSession();
  const running = runConsole({ session, input, output, error: new Capture() });

  input.write("helx\u007flo\r/exit\r");
  input.end();

  expect(await running).toEqual({ reason: "exit", completedTurns: 1 });
  expect(session.inputs).toEqual(["hello"]);
  expect(output.text()).toContain("ad-coder> helx\b \blo\n");
});

test("repeated Escape preserves its first deadline and interrupts once", async () => {
  const input = rawInput();
  const started = deferred();
  const interrupted = deferred();
  let interruptCalls = 0;
  const session = fakeSession();
  session.step = async (line) => {
    session.inputs.push(line);
    started.resolve();
    await interrupted.promise;
    throw new TurnInterruptedError();
  };
  session.interrupt = async () => {
    interruptCalls++;
    interrupted.resolve();
    return true;
  };
  const running = runConsole({
    session,
    input,
    output: new Capture(),
    error: new Capture(),
    escapeSequenceTimeoutMs: 20,
  });
  input.write("foreground\r\u001b");
  await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 10));
  input.write("\u001b");
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(interruptCalls).toBe(1);
  input.end();
  await running;
  expect(interruptCalls).toBe(1);
});

test("a malformed local control reports an error without blocking a later control", async () => {
  const calls: string[] = [];
  const session = fakeSession() as unknown as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = {
    list: () => {
      calls.push("list");
      return [];
    },
  } as unknown as BackgroundRunManager;
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/status\n/list\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });
  expect(error.text()).toContain('"code":"invalid_command"');
  expect(calls).toEqual(["list"]);
});

test("startConversation propagates the provider AbortSignal used by raw Ctrl-C", async () => {
  const faux = fauxProvider({
    provider: "console-abort",
    models: [{ id: "console-abort", contextWindow: 200_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const role: Role = defineRole(
    {
      name: "coder",
      provider: "console-abort",
      modelId: model.id,
      systemPrompt: "test",
      activeToolNames: [],
      cacheRetention: "none",
      contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    },
    model,
  );
  const providerStarted = deferred();
  const providerAborted = deferred();
  faux.setResponses([
    async (_context, options) => {
      const signal = options?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      providerStarted.resolve();
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      providerAborted.resolve();
      return fauxAssistantMessage("unreachable");
    },
  ]);
  const session = await startConversation({
    role,
    targetDir: process.cwd(),
    models,
    model,
    ledgerSink: new MemoryLedgerSink(),
  });
  const input = rawInput();
  const running = runConsole({ session, input, output: new Capture(), error: new Capture() });
  input.write("foreground\r");
  await providerStarted.promise;
  input.write("\u0003");
  input.end();
  await providerAborted.promise;
  expect(await running).toMatchObject({ reason: "exit" });
});

test("raw Ctrl-C settles when the real provider ignores cancellation forever", async () => {
  const faux = fauxProvider({
    provider: "console-never-settles",
    models: [{ id: "console-never-settles", contextWindow: 200_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const role: Role = defineRole(
    {
      name: "coder",
      provider: "console-never-settles",
      modelId: model.id,
      systemPrompt: "test",
      activeToolNames: [],
      cacheRetention: "none",
      contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    },
    model,
  );
  const providerStarted = deferred();
  const providerAborted = deferred();
  faux.setResponses([
    async (_context, options) => {
      providerStarted.resolve();
      options?.signal?.addEventListener("abort", () => providerAborted.resolve(), { once: true });
      await new Promise<never>(() => undefined);
      return fauxAssistantMessage("unreachable");
    },
  ]);
  const session = await startConversation({
    role,
    targetDir: process.cwd(),
    models,
    model,
    ledgerSink: new MemoryLedgerSink(),
  });
  const input = rawInput();
  const running = runConsole({ session, input, output: new Capture(), error: new Capture() });
  input.write("foreground\r");
  await providerStarted.promise;
  input.write("\u0003");
  input.end();
  await providerAborted.promise;

  const outcome = await Promise.race([running, Bun.sleep(1_000).then(() => "timeout" as const)]);
  expect(outcome).not.toBe("timeout");
  expect(outcome).toMatchObject({ reason: "exit", completedTurns: 0 });
});

test("zero heartbeat keeps the immediate stage event and disables only periodic events", async () => {
  const error = new Capture();
  await runConsole({
    session: fakeSession(),
    input: Readable.from("hello\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
    heartbeatMs: 0,
  });
  const progress = error
    .text()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(progress).toEqual([
    { type: "progress", event: "started", stage: "console-turn", elapsedSeconds: 0 },
  ]);
});

test("/help lists every console command with usage and an example from the registry", async () => {
  const session = fakeSession();
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from("/help\n/exit\n"),
    output,
    error: new Capture(),
    mode: "json",
  });

  expect(session.inputs).toEqual([]);
  const record = JSON.parse(output.text().trim()) as {
    type: string;
    commands: Array<{
      name: string;
      usage: string;
      description: string;
      example: string;
      available: boolean;
      unavailableAction?: string;
    }>;
  };
  expect(record.type).toBe("console_help");
  expect(record.commands.map((command) => command.name)).toEqual(
    CONSOLE_COMMANDS.map((command) => command.name),
  );
  for (const command of record.commands) {
    expect(command.usage.startsWith(command.name)).toBe(true);
    expect(command.description.length).toBeGreaterThan(0);
    expect(command.example.startsWith(command.name)).toBe(true);
  }
  // Without a background manager the background commands are reported as
  // unavailable WITH the action that enables them, never silently listed.
  const list = record.commands.find((command) => command.name === "/list");
  expect(list?.available).toBe(false);
  expect(list?.unavailableAction).toContain("--workflows pipeline");
  expect(record.commands.find((command) => command.name === "/exit")?.available).toBe(true);
});

test("/help marks background commands available once the session enables them", async () => {
  const session = fakeSession() as unknown as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = { list: () => [] } as unknown as BackgroundRunManager;
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from("/help\n/exit\n"),
    output,
    error: new Capture(),
    mode: "json",
  });

  const record = JSON.parse(output.text().trim()) as {
    commands: Array<{ name: string; available: boolean; unavailableAction?: string }>;
  };
  const list = record.commands.find((command) => command.name === "/list");
  expect(list?.available).toBe(true);
  expect(list?.unavailableAction).toBeUndefined();
});

test("a formatted /help renders one usage and example line per command", async () => {
  const session = fakeSession();
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from("/help\n/exit\n"),
    output,
    error: new Capture(),
    mode: "formatted",
  });

  const text = output.text();
  for (const command of CONSOLE_COMMANDS) {
    expect(text).toContain(consoleCommandUsage(command));
    expect(text).toContain(`example: ${command.example}`);
  }
});

test("a missing run identifier names the command, the cause, and its usage", async () => {
  const session = fakeSession() as unknown as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = { list: () => [] } as unknown as BackgroundRunManager;
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/status\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });

  const record = JSON.parse(error.text().trim()) as {
    type: string;
    code: string;
    command: string;
    message: string;
    action: string;
    retryable: boolean;
  };
  expect(record.type).toBe("console_error");
  expect(record.code).toBe("invalid_command");
  expect(record.command).toBe("/status");
  expect(record.message).toContain("requires a background run identifier");
  expect(record.action).toContain("/status <run-id>");
  expect(record.action).toContain("example: /status ");
  expect(record.retryable).toBe(true);
});

test("an unavailable background command names the flag that enables it", async () => {
  const session = fakeSession();
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/list\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });

  const record = JSON.parse(error.text().trim()) as {
    code: string;
    command: string;
    action: string;
    retryable: boolean;
  };
  expect(record.code).toBe("not_available");
  expect(record.command).toBe("/list");
  expect(record.action).toContain("--workflows pipeline");
  // Retrying the identical command in this session cannot succeed.
  expect(record.retryable).toBe(false);
});

test("an unknown console command points at /help instead of a hardcoded list", async () => {
  const session = fakeSession();
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/nope\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });

  // An unknown slash command must never be forwarded to the model as a prompt.
  expect(session.inputs).toEqual([]);
  const record = JSON.parse(error.text().trim()) as {
    code: string;
    message: string;
    action: string;
    retryable: boolean;
  };
  expect(record.code).toBe("unknown_command");
  expect(record.message).toContain("/nope");
  expect(record.action).toContain("/help");
  expect(record.retryable).toBe(true);
});

test("a formatted console failure states the cause and the next action", async () => {
  const session = fakeSession();
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/list\n/exit\n"),
    output: new Capture(),
    error,
    mode: "formatted",
  });

  const text = error.text();
  expect(text).toContain("/list needs background runs");
  expect(text).toContain("--workflows pipeline");
  // The retired hand-maintained command list must not reappear.
  expect(text).not.toContain("use /list, /events, /status, /result, /cancel, or /interrupt");
});

test("a terminal control sequence in an unknown command cannot reach the terminal", async () => {
  const session = fakeSession();
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/\u001b[31mnope\n/exit\n"),
    output: new Capture(),
    error,
    mode: "formatted",
  });

  expect(error.text()).not.toContain("\u001b");
});

test("a run the manager does not know reports not_found with a recovery action", async () => {
  const session = fakeSession() as unknown as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = {
    status: () => {
      throw new Error("not_found");
    },
  } as unknown as BackgroundRunManager;
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/status 123e4567-e89b-12d3-a456-426614174000\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });

  const record = JSON.parse(error.text().trim()) as {
    code: string;
    command: string;
    action: string;
    retryable: boolean;
  };
  expect(record.code).toBe("not_found");
  expect(record.command).toBe("/status");
  expect(record.action).toContain("/list");
  expect(record.retryable).toBe(false);
});

test("a result requested before termination stays retryable with a wait action", async () => {
  const session = fakeSession() as unknown as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = {
    result: () => {
      throw new Error("not_terminal");
    },
  } as unknown as BackgroundRunManager;
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/result 123e4567-e89b-12d3-a456-426614174000\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });

  const record = JSON.parse(error.text().trim()) as {
    code: string;
    action: string;
    retryable: boolean;
  };
  expect(record.code).toBe("not_terminal");
  expect(record.action).toContain("/status");
  expect(record.retryable).toBe(true);
});

test("every registered console command declares usage, a description, and an example", () => {
  for (const command of CONSOLE_COMMANDS) {
    expect(command.name.startsWith("/")).toBe(true);
    expect(command.description.length).toBeGreaterThan(0);
    expect(command.example.startsWith(command.name)).toBe(true);
    expect(consoleCommandUsage(command).startsWith(command.name)).toBe(true);
    // A required argument must precede every optional one in the usage line.
    const required = command.args.map((argument) => argument.required);
    expect([...required].sort((a, b) => Number(b) - Number(a))).toEqual(required);
  }
  expect(consoleCommandNames()).toContain("/help");
  expect(consoleCommandNames()).toContain("/exit");
});

test("a C1 control sequence cannot reach a terminal through the JSON failure record", async () => {
  const session = fakeSession();
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/\u009b31mnope\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });

  // JSON.stringify does not escape C1 controls, so the record is sanitized too.
  expect(error.text()).not.toContain("\u009b");
  expect(error.text()).not.toContain("\u001b");
  const record = JSON.parse(error.text().trim()) as { code: string; message: string };
  expect(record.code).toBe("unknown_command");
  expect(record.message).not.toContain("\u009b");
});

test("every console failure projection carries a code, action, and retryability", async () => {
  const cases: Array<{
    session: ReturnType<typeof fakeSession>;
    code: string;
    retryable: boolean;
  }> = [
    {
      session: fakeSession({ stepError: new Error("boom") }),
      code: "turn_failed",
      retryable: true,
    },
    {
      session: fakeSession({ stepError: new SessionLimitError("turns", 1, 1) }),
      code: "session_limit",
      retryable: false,
    },
  ];
  for (const { session, code, retryable } of cases) {
    const error = new Capture();
    await runConsole({
      session,
      input: Readable.from("hello\n"),
      output: new Capture(),
      error,
      mode: "json",
    });
    const line = error
      .text()
      .trim()
      .split("\n")
      .find((entry) => entry.includes('"console_error"')) as string;
    const record = JSON.parse(line) as {
      type: string;
      code: string;
      message: string;
      action: string;
      retryable: boolean;
    };
    expect(record.type).toBe("console_error");
    expect(record.code).toBe(code);
    expect(record.message.length).toBeGreaterThan(0);
    expect(record.action.length).toBeGreaterThan(0);
    expect(record.retryable).toBe(retryable);
  }
});

test("the console front dispatches every registered exit command, not one literal", async () => {
  const exits = CONSOLE_COMMANDS.filter((command) => command.frontAction === "exit");
  expect(exits.length).toBeGreaterThan(0);
  // Driving the registry rather than the literal "/exit" means a command added
  // to the registry cannot be silently unreachable from the front.
  for (const command of exits) {
    const session = fakeSession();
    const result = await runConsole({
      session,
      input: Readable.from(`${command.name}\n`),
      output: new Capture(),
      error: new Capture(),
      mode: "json",
    });
    expect(result.reason).toBe("exit");
    expect(session.inputs).toEqual([]);
  }
  expect(findConsoleCommand("/exit")?.frontAction).toBe("exit");
});

test("a manager failure keeps its cause for programmatic callers only", () => {
  const cause = new Error("not_found");
  const manager = {
    status: () => {
      throw cause;
    },
  } as unknown as BackgroundRunManager;
  let caught: unknown;
  try {
    executeConsoleControl("/status 123e4567-e89b-12d3-a456-426614174000", {
      backgroundRuns: manager,
      interrupt: async () => false,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConsoleControlError);
  const failure = caught as ConsoleControlError;
  expect(failure.cause).toBe(cause);
  // The public projection never repeats the raw manager text.
  expect(failure.failure.message).not.toContain("not_found");
  expect(failure.failure.code).toBe("not_found");
  expect(failure.failure.action).toContain("/list");
});

test("every declared registry field reaches an operator, so none can quietly rot", async () => {
  const session = fakeSession();
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from("/help\n/exit\n"),
    output,
    error: new Capture(),
    mode: "json",
  });

  const record = JSON.parse(output.text().trim()) as {
    commands: Array<{
      name: string;
      args: Array<{ name: string; required: boolean; description: string }>;
    }>;
  };
  for (const command of CONSOLE_COMMANDS) {
    const rendered = record.commands.find((entry) => entry.name === command.name);
    expect(rendered?.args.map((argument) => argument.name)).toEqual(
      command.args.map((argument) => argument.name),
    );
    // A per-argument description is declared for every argument AND rendered.
    for (const argument of command.args) {
      const shown = rendered?.args.find((entry) => entry.name === argument.name);
      expect(shown?.description).toBe(argument.description);
      expect(argument.description.length).toBeGreaterThan(0);
    }
  }
});

test("a formatted /help explains each argument, not just the usage line", async () => {
  const session = fakeSession();
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from("/help\n/exit\n"),
    output,
    error: new Capture(),
    mode: "formatted",
  });

  const text = output.text();
  for (const command of CONSOLE_COMMANDS)
    for (const argument of command.args) expect(text).toContain(argument.description);
});

test("an over-arity failure counts arguments grammatically", async () => {
  const session = fakeSession() as unknown as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = { list: () => [] } as unknown as BackgroundRunManager;
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from(
      "/status 123e4567-e89b-12d3-a456-426614174000 123e4567-e89b-12d3-a456-426614174000\n/exit\n",
    ),
    output: new Capture(),
    error,
    mode: "json",
  });

  const record = JSON.parse(error.text().trim()) as { code: string; message: string };
  expect(record.code).toBe("invalid_command");
  expect(record.message).toContain("takes at most 1 argument");
  expect(record.message).not.toContain("1 arguments");
});

test("a front command reaching control dispatch fails with an action the caller can take", () => {
  const front = CONSOLE_COMMANDS.filter((command) => command.frontAction !== undefined);
  expect(front.length).toBeGreaterThan(0);
  for (const command of front) {
    let caught: unknown;
    try {
      executeConsoleControl(command.name, { interrupt: async () => false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConsoleControlError);
    const failure = (caught as ConsoleControlError).failure;
    // The action must not tell the caller to retype the command that just failed.
    expect(failure.action).toContain("frontAction");
    expect(failure.retryable).toBe(false);
  }
});

test("/start admits a detached run and passes the whole line as one task", async () => {
  const runId = "123e4567-e89b-12d3-a456-426614174000";
  const tasks: string[] = [];
  const session = fakeSession() as unknown as ConversationSession & {
    inputs: string[];
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = {
    startDetached: async (task: string) => {
      tasks.push(task);
      return { runId, lifecycle: "requested" as const };
    },
  } as unknown as BackgroundRunManager;
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from("/start add a regression test for the retry path\n/exit\n"),
    output,
    error: new Capture(),
    mode: "json",
  });

  // A task is a sentence: splitting on whitespace would truncate it to "add".
  expect(tasks).toEqual(["add a regression test for the retry path"]);
  // Starting a run is console-local; it must not consume a model turn.
  expect(session.inputs).toEqual([]);
  const record = JSON.parse(output.text().trim()) as {
    type: string;
    run: { runId: string; lifecycle: string };
  };
  expect(record).toEqual({ type: "background_start", run: { runId, lifecycle: "requested" } });
});

test("shutdown stays finite when a control never settles", async () => {
  // docs/contracts/ui-responsiveness.md: shutdown is finite and terminal modes
  // are restored on EVERY exit path. A host launcher that never spawns must not
  // be able to hold the console open.
  const session = fakeSession() as unknown as ConversationSession & {
    closes: number;
    backgroundRuns: BackgroundRunManager;
  };
  const launching = deferred();
  session.backgroundRuns = {
    startDetached: () => {
      launching.resolve();
      return new Promise<never>(() => undefined);
    },
  } as unknown as BackgroundRunManager;
  const input = rawInput();
  const error = new Capture();
  const running = runConsole({
    session,
    input,
    output: new Capture(),
    error,
    mode: "json",
    controlDrainMs: 20,
  });
  input.write("/start this never launches\r");
  // Shut down only once the launch is genuinely in flight. A control still
  // queued when shutdown begins is dropped rather than drained, which would
  // make this assert nothing.
  await launching.promise;
  // Ctrl-C, not /exit: the stuck control must not block the harshest exit path.
  input.write("\u0003");
  input.end();

  const result = await Promise.race([
    running,
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
  ]);
  expect(result).not.toBe("hung");
  expect(result).toMatchObject({ reason: "exit" });
  // The abandoned control is reported, not swallowed into a clean exit.
  const record = JSON.parse(error.text().trim()) as { code: string; retryable: boolean };
  expect(record.code).toBe("deadline_exceeded");
  expect(record.retryable).toBe(false);
  // The session still closes and the terminal still leaves raw mode.
  expect(session.closes).toBe(1);
  expect(input.isRaw).toBe(false);
});

test("controls render in the order they were typed even when one of them awaits", async () => {
  const runId = "123e4567-e89b-12d3-a456-426614174000";
  const started: { runId: string; lifecycle: "requested" }[] = [];
  const session = fakeSession() as unknown as ConversationSession & {
    inputs: string[];
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = {
    startDetached: async () => {
      // A real launcher spawns a host process; the console must not render a
      // later control before this settles.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const run = { runId, lifecycle: "requested" as const };
      started.push(run);
      return run;
    },
    list: () =>
      started.map(({ runId: id, lifecycle }) => ({
        runId: id,
        lifecycle,
        metrics: { steps: 0, totalCost: 0 },
      })),
  } as unknown as BackgroundRunManager;
  const output = new Capture();
  await runConsole({
    session,
    input: Readable.from("/start ship it\n/list\n/exit\n"),
    output,
    error: new Capture(),
    mode: "json",
  });

  const records = output
    .text()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; runs?: unknown[] });
  expect(records.map(({ type }) => type)).toEqual(["background_start", "background_list"]);
  // The list is taken after the start, so it sees the run the operator just asked for.
  expect(records[1]?.runs).toMatchObject([{ runId, lifecycle: "requested" }]);
});

test("/start without a task names the missing argument instead of starting a run", async () => {
  let started = 0;
  const session = fakeSession() as unknown as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = {
    startDetached: async () => {
      started += 1;
      return { runId: "123e4567-e89b-12d3-a456-426614174000", lifecycle: "requested" as const };
    },
  } as unknown as BackgroundRunManager;
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/start\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });

  expect(started).toBe(0);
  const record = JSON.parse(error.text().trim()) as {
    code: string;
    command: string;
    action: string;
    retryable: boolean;
  };
  expect(record.code).toBe("invalid_command");
  expect(record.command).toBe("/start");
  expect(record.action).toContain("/start <task>");
  expect(record.retryable).toBe(true);
});

test("a failed detached launch is retryable and points at the failed record", async () => {
  const session = fakeSession() as unknown as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = {
    startDetached: async () => {
      throw new Error("launch_failed");
    },
  } as unknown as BackgroundRunManager;
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/start ship it\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });

  const record = JSON.parse(error.text().trim()) as {
    code: string;
    command: string;
    action: string;
    retryable: boolean;
  };
  expect(record.code).toBe("launch_failed");
  expect(record.command).toBe("/start");
  expect(record.action).toContain("/list");
  expect(record.retryable).toBe(true);
});

test("a refused admission reports the limit rather than an opaque rejection", async () => {
  const session = fakeSession() as unknown as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
  };
  session.backgroundRuns = {
    startDetached: async () => {
      throw new Error("resource_limit");
    },
  } as unknown as BackgroundRunManager;
  const error = new Capture();
  await runConsole({
    session,
    input: Readable.from("/start ship it\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
  });

  const record = JSON.parse(error.text().trim()) as {
    code: string;
    action: string;
    retryable: boolean;
  };
  expect(record.code).toBe("resource_limit");
  expect(record.action).toContain("/cancel");
  expect(record.retryable).toBe(true);
});
