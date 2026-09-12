import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { runConsole } from "../src/cli/console";
import type { ConversationSession, ConversationTurnResult } from "../src/conversation/conversation";
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
  expect(error.text()).toBe("ad-coder: input line exceeds the configured byte limit\n");
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
      '{"type":"console_error","code":"session_limit"}\n',
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
