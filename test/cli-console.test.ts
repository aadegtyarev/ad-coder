import { expect, test } from "bun:test";
import type { Stats } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runConsole } from "../src/cli/console";
import { resolveResumeRun, resumeOrchestratorConfig, resumeSeedNote } from "../src/cli/resume";
import { loadTaskFile } from "../src/cli/task-file";
import { ContextCompactionLostError } from "../src/context/compactor";
import {
  CONSOLE_COMMANDS,
  ConsoleControlError,
  type CostAnomalyControl,
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
import { CostAnomalyBlockedError } from "../src/economics/cost-anomaly";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import type { LedgerRecord } from "../src/ledger/types";
import {
  BackgroundRunManager,
  type BackgroundRunNotice,
} from "../src/orchestration/background-runs";
import { ProjectStoreError } from "../src/project-store/types";
import { defineRole, type Role } from "../src/role";
import {
  EmptyTurnError,
  GenerationTruncatedError,
  ProviderQuotaError,
  ProviderRejectionError,
} from "../src/runner/errors";
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

/**
 * Piped stdin is ONE message since the multi-line fix; tests that need
 * per-line dispatch drive the TTY path explicitly (docs/contracts/cli.md,
 * 2026-09-16).
 */
function ttyFrom(chunks: string | Uint8Array | (string | Uint8Array)[]): NodeJS.ReadableStream {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  const input = rawInput();
  for (const chunk of list) input.write(chunk as string);
  input.end();
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
    input: ttyFrom([" first\n\n", "second\r\n/exit\nignored\n"]),
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

test("a piped brief is read whole and dispatched as ONE turn, never as one turn per line", async () => {
  const brief = [
    "Skills must behave identically in every user-facing command.",
    "Read src/skills/role-kit.ts and the contracts first.",
    "Produce the plan and stop before writing code.",
  ].join("\n");
  const session = fakeSession();
  const error = new Capture();
  const result = await runConsole({
    session,
    input: Readable.from(`${brief}\n`),
    output: new Capture(),
    error,
  });

  // The whole brief arrives as one message; interior newlines are preserved.
  expect(session.inputs).toEqual([brief]);
  expect(result).toEqual({ reason: "eof", completedTurns: 1 });
  expect(error.text()).toBe("ad-coder: console turn started (0s)\n");
});

test("console-command-looking lines inside a piped brief or /task file are prompt text, not controls", async () => {
  const session = fakeSession();
  const output = new Capture();
  const result = await runConsole({
    session,
    input: Readable.from("step one\n/help\n/exit\nstep two\n"),
    output,
    error: new Capture(),
  });

  expect(session.inputs).toEqual(["step one\n/help\n/exit\nstep two"]);
  expect(result).toEqual({ reason: "eof", completedTurns: 1 });
});

test("a piped run that is a single control command still executes it", async () => {
  const session = fakeSession();
  const result = await runConsole({
    session,
    input: Readable.from("/exit\n"),
    output: new Capture(),
    error: new Capture(),
  });

  expect(result).toEqual({ reason: "exit", completedTurns: 0 });
  expect(session.closes).toBe(1);
});

test("mid-line CRLF boundaries collapse across chunk edges in a piped brief", async () => {
  const session = fakeSession();
  await runConsole({
    session,
    input: Readable.from([Buffer.from("one\r"), Buffer.from("\ntwo\r\n")]),
    output: new Capture(),
    error: new Capture(),
  });

  expect(session.inputs).toEqual(["one\ntwo"]);
});

test("a piped message over the byte ceiling is rejected whole, before step", async () => {
  const session = fakeSession();
  const error = new Capture();
  const result = await runConsole({
    session,
    input: Readable.from("line one\nline two\n"),
    output: new Capture(),
    error,
    maxInputBytes: 10,
  });

  expect(result).toEqual({ reason: "input_too_large", completedTurns: 0 });
  expect(session.inputs).toEqual([]);
  expect(session.closes).toBe(1);
  expect(error.text()).toContain("input message exceeds the configured byte limit");
});

test("a bracketed paste joins pasted lines into ONE message and does not execute command-looking lines", async () => {
  const session = fakeSession();
  const input = rawInput();
  const output = new Capture();
  const error = new Capture();
  const running = runConsole({ session, input, output, error });

  input.write("\u001b[200~task intro\n/help\nfinish\u001b[201~\r");
  input.end();
  const result = await running;

  expect(session.inputs).toEqual(["task intro\n/help\nfinish"]);
  expect(result).toEqual({ reason: "eof", completedTurns: 1 });
});

test("an unterminated pasted brief still dispatches as ONE message at EOF", async () => {
  const session = fakeSession();
  const input = rawInput();
  const running = runConsole({
    session,
    input,
    output: new Capture(),
    error: new Capture(),
  });

  input.write("\u001b[200~line a\nline b");
  await new Promise((resolve) => setTimeout(resolve, 0));
  input.end();
  await running;
  expect(session.inputs).toEqual(["line a\nline b"]);
});

test("the paste-end frame cannot dispatch or interrupt, and a lone ESC still interrupts", async () => {
  const session = fakeSession();
  const input = rawInput();
  const error = new Capture();
  const running = runConsole({ session, input, output: new Capture(), error });

  input.write("\u001b[201~/help\n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A bare ESC (inside paste framing already closed) interrupts, not inputs.
  input.write("\u001b");
  input.end();
  const result = await running;
  expect(result).toEqual({ reason: "eof", completedTurns: 0 });
});

test("/task <path> dispatches a whole file as ONE turn and never as controls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-task-"));
  const file = path.join(dir, "brief.txt");
  fs.writeFileSync(file, "intro\n/help\n/outro\n");
  const session = fakeSession();
  const output = new Capture();
  const result = await runConsole({
    session,
    input: ttyFrom(`/task ${file}\n/exit\n`),
    output,
    error: new Capture(),
  });

  expect(session.inputs).toEqual(["intro\n/help\n/outro"]);
  expect(result).toEqual({ reason: "exit", completedTurns: 1 });
  expect(output.text()).toContain(`dispatching task read from ${file}`);
});

test("/task names an unreadable path with a typed failure and keeps the console open", async () => {
  const session = fakeSession();
  const error = new Capture();
  const result = await runConsole({
    session,
    input: ttyFrom("/task /nonexistent-brief-file.txt\n/exit\n"),
    output: new Capture(),
    error,
  });

  expect(session.inputs).toEqual([]);
  expect(result).toEqual({ reason: "exit", completedTurns: 0 });
  expect(error.text()).toContain("/task cannot read /nonexistent-brief-file.txt (no such file)");
  expect(error.text()).toContain("check the path and retry with: /task <path>");
});

test("/task names a permissions failure as denied, with advice that does not blame the path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-task-"));
  const file = path.join(dir, "secret.txt");
  fs.writeFileSync(file, "closed brief\n");
  fs.chmodSync(file, 0o000);
  const session = fakeSession();
  const error = new Capture();
  try {
    const result = await runConsole({
      session,
      input: ttyFrom(`/task ${file}\n/exit\n`),
      output: new Capture(),
      error,
      maxInputBytes: 65536,
    });

    expect(session.inputs).toEqual([]);
    expect(result).toEqual({ reason: "exit", completedTurns: 0 });
    expect(error.text()).toContain("/task cannot read");
    expect(error.text()).toContain("(permission denied)");
    // The one action a permission failure deserves: a missing path check
    // cannot fix EACCES (docs/contracts/errors.md).
    expect(error.text()).toContain("check read permissions on");
    expect(error.text()).not.toContain("check the path and retry");
  } finally {
    fs.chmodSync(file, 0o644); // tmpdir cleanup needs the directory empty.
    fs.rmSync(file);
  }
});

test("/task rejects a file larger than the message ceiling before dispatch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-task-"));
  const file = path.join(dir, "big.txt");
  fs.writeFileSync(file, `\n${"x".repeat(300)}`);
  const session = fakeSession();
  const error = new Capture();
  const result = await runConsole({
    session,
    input: ttyFrom(`/task ${file}\n/exit\n`),
    output: new Capture(),
    error,
    maxInputBytes: 256,
  });

  expect(session.inputs).toEqual([]);
  expect(result).toEqual({ reason: "exit", completedTurns: 0 });
  expect(error.text()).toContain("/task file exceeds the configured input byte limit");
});

test("an over-ceiling task file is refused at the boundary without one byte read", () => {
  // The injected stat lies about a big file while the injected read is a
  // tripwire: if the boundary read before the ceiling check, this fails.
  const loaded = loadTaskFile("/briefs/huge.txt", 16, {
    stat: () => ({ size: 4_096 }) as unknown as Stats,
    readFile: () => {
      throw new Error("boundary must not read an over-ceiling file");
    },
  });

  expect(loaded).toEqual({
    ok: false,
    code: "resource_limit",
    message: "/task file exceeds the configured input byte limit",
    action: "send a shorter message, or raise maxInputBytes when embedding runConsole",
    retryable: false,
  });
});

test("task-file failures keep the errno class so the action can follow from it", () => {
  const boom =
    (errno: string): (() => Stats) =>
    () => {
      throw Object.assign(new Error("stat failed"), { code: errno });
    };

  expect(loadTaskFile("/briefs/never-there.txt", 16, { stat: boom("ENOENT") })).toMatchObject({
    code: "task_file_not_found",
    message: "/task cannot read /briefs/never-there.txt (no such file)",
    action: "check the path and retry with: /task <path>",
  });
  expect(loadTaskFile("/briefs/locked.txt", 16, { stat: boom("EACCES") })).toMatchObject({
    code: "task_file_denied",
    message: "/task cannot read /briefs/locked.txt (permission denied)",
  });
  expect(loadTaskFile("/briefs/locked.txt", 16, { stat: boom("EPERM") })).toMatchObject({
    code: "task_file_denied",
  });
  expect(loadTaskFile("/briefs/dir", 16, { stat: boom("EISDIR") })).toMatchObject({
    code: "task_file_is_directory",
    message: "/task cannot read /briefs/dir (it is a directory)",
    action: "name a file, not a directory, with: /task <path>",
  });
  expect(loadTaskFile("/briefs/broken.txt", 16, { stat: boom("EIO") })).toMatchObject({
    code: "task_file_unreadable",
    message: "/task cannot read /briefs/broken.txt (EIO)",
    action: "check the path and retry with: /task <path>",
  });
});

test("counts UTF-8 bytes across chunks and rejects an oversized piped message before step", async () => {
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
  expect(error.text()).toContain("input message exceeds the configured byte limit");
  expect(error.text()).toContain("send a shorter line");
});

test("reports a cooperative interruption separately from a provider failure", async () => {
  const session = fakeSession({ stepError: new Error("transport closed") });
  const error = new Capture();
  const result = await runConsole({
    session,
    input: ttyFrom(["work\n"]),
    output: new Capture(),
    error,
    interrupted: () => true,
  });

  expect(result).toEqual({ reason: "interrupted", completedTurns: 0 });
  expect(error.text()).toContain("console turn interrupted");
  expect(error.text()).not.toContain("console turn failed");
  expect(session.closes).toBe(1);
});

test("a spent compaction stops the console with --resume, never with 'retry'", async () => {
  const error = new Capture();
  // A session whose summarizer failed its bounded attempts: no later turn can
  // compact this context, so the run stops. The rendered advice must be the one
  // action that works -- reopening the session -- and never the generic retry,
  // which cannot succeed and which left the console alive and deaf (#391).
  const lost = new ContextCompactionLostError({
    role: "coder",
    budget: { maxTokens: 4000, reserveTokens: 400, keepRecentTokens: 1000 },
    measuredTokens: 9000,
    contextWindow: 8000,
    failures: [
      {
        attempt: 1,
        errorName: "ProviderBoom",
        status: 529,
        providerCode: "overloaded",
        provider: "summary-provider",
        model: "cheap",
        measuredTokens: 7000,
        thresholdTokens: 3000,
      },
      {
        attempt: 2,
        errorName: "ProviderBoom",
        status: 529,
        providerCode: "overloaded",
        provider: "summary-provider",
        model: "cheap",
        measuredTokens: 9000,
        thresholdTokens: 3000,
      },
    ],
  });
  const result = await runConsole({
    session: fakeSession({ stepError: lost }),
    input: ttyFrom("hello\n"),
    output: new Capture(),
    error,
    authenticationCommand: "ad-coder auth login --provider openrouter --target-dir '/tmp/project'",
  });
  // A stop, not a failed turn: the exit reason is its own, so a supervisor can
  // tell "this session is over" from "that turn went wrong".
  expect(result.reason).toBe("context_compaction_lost");
  expect(error.text()).toContain("context compaction failed 2 times");
  // Attributed by class, provider, model and numbers -- enough to act on.
  expect(error.text()).toContain("ProviderBoom");
  expect(error.text()).toContain("summary-provider/cheap");
  expect(error.text()).toContain("HTTP 529");
  expect(error.text()).toContain("9000 tokens against threshold 3000");
  expect(error.text()).toContain("effective ceiling 8000");
  expect(error.text()).toContain("--resume");
  expect(error.text()).toContain("--summarizer-model");
  // Neither a retry nor a credential command is the way out: the session's own
  // compaction is what ran out.
  expect(error.text()).not.toContain("then retry");
  expect(error.text()).not.toContain("auth login");

  // The machine-readable form carries the code and, crucially, retryable:false
  // -- the one field a supervisor reads before deciding to re-run the turn.
  const jsonError = new Capture();
  await runConsole({
    session: fakeSession({ stepError: lost }),
    input: ttyFrom("hello\n"),
    output: new Capture(),
    error: jsonError,
    mode: "json",
  });
  const record = JSON.parse(jsonError.text().trim().split("\n").pop() as string) as {
    code: string;
    retryable: boolean;
    action: string;
  };
  expect(record.code).toBe("context_compaction_lost");
  expect(record.retryable).toBe(false);
  expect(record.action).toContain("--resume");
});

test("empty provider turns show an actionable authentication command", async () => {
  const error = new Capture();
  await runConsole({
    session: fakeSession({ stepError: new EmptyTurnError("run") }),
    input: ttyFrom("hello\n"),
    output: new Capture(),
    error,
    authenticationCommand: "ad-coder auth login --provider openrouter --target-dir '/tmp/project'",
  });
  expect(error.text()).toContain(
    "run: ad-coder auth login --provider openrouter --target-dir '/tmp/project'",
  );
});

test("a quota refusal advises waiting on the reset window, never authentication", async () => {
  const error = new Capture();
  await runConsole({
    session: fakeSession({
      stepError: new ProviderQuotaError("run", "insufficient_quota", 120_000),
    }),
    input: ttyFrom("hello\n"),
    output: new Capture(),
    error,
    authenticationCommand: "ad-coder auth login --provider openrouter --target-dir '/tmp/project'",
  });
  expect(error.text()).toContain("HTTP 429");
  expect(error.text()).toContain("insufficient_quota");
  expect(error.text()).toContain("reset window");
  // An authentication command is configured and must still NOT be offered, and
  // the request is not the thing to inspect: the credential is valid, only the
  // quota is spent (#356).
  expect(error.text()).not.toContain("auth login");
  expect(error.text()).not.toContain("inspect the request");
});

test("a truncated generation names the output budget and a budget remedy, never authentication", async () => {
  const error = new Capture();
  await runConsole({
    session: fakeSession({
      stepError: new GenerationTruncatedError("run", "length", 16384, 16347),
    }),
    input: ttyFrom("hello\n"),
    output: new Capture(),
    error,
    authenticationCommand: "ad-coder auth login --provider openrouter --target-dir '/tmp/project'",
  });
  expect(error.text()).toContain("no answer and no tool call");
  expect(error.text()).toContain("16384 output tokens");
  expect(error.text()).toContain("16347 on reasoning");
  expect(error.text()).toContain("raise the output budget or bound thinking");
  // A credential command and a request inspection are both wrong here: the
  // generation ran and was cut off by the output budget (#368).
  expect(error.text()).not.toContain("auth login");
  expect(error.text()).not.toContain("inspect the request");
});

test("a provider rejection points at the request, never at authentication", async () => {
  const error = new Capture();
  await runConsole({
    session: fakeSession({ stepError: new ProviderRejectionError("run", 400) }),
    input: ttyFrom("hello\n"),
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
    input: ttyFrom("hello\n"),
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
    input: ttyFrom("hello\n"),
    output,
    error: new Capture(),
  });
  expect(output.text()).toContain("visible");
  expect(output.text()).not.toContain("unfinished secret");
  // The front itself now emits trusted terminal sequences (bracketed-paste
  // framing), so the guarantee tested here is narrower: no ESC reaches the
  // terminal from the session's turn output.
  const visibleLine = output
    .text()
    .split("\n")
    .find((line) => line.includes("visible"));
  expect(visibleLine).not.toContain("\u001b");
});

test("turn and close failures use fixed messages and close once", async () => {
  const secret = "credential=super-secret";
  const session = fakeSession({ stepError: new Error(secret), closeError: new Error(secret) });
  const error = new Capture();
  const result = await runConsole({
    session,
    input: ttyFrom("hello\nnext\n"),
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
    input: ttyFrom("first\nsecond\n"),
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
      input: ttyFrom(""),
      output: new Capture(),
      error: new Capture(),
      maxInputBytes: 0,
    }),
  ).rejects.toThrow("positive integer");
  expect(invalidSession.closes).toBe(0);

  const eofSession = fakeSession();
  const result = await runConsole({
    session: eofSession,
    input: ttyFrom(""),
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
    input: ttyFrom("hello\n/exit\n"),
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
    input: ttyFrom("hello\n/exit\n"),
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
  const input = rawInput();
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
    input: ttyFrom("/exit\n"),
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
    input: ttyFrom("/exit\n"),
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
    input: ttyFrom(
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
  const input = rawInput();
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
    input: ttyFrom("/status\n/list\n/exit\n"),
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
    input: ttyFrom("hello\n/exit\n"),
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
    input: ttyFrom("/help\n/exit\n"),
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
    input: ttyFrom("/help\n/exit\n"),
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
    input: ttyFrom("/help\n/exit\n"),
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
    input: ttyFrom("/status\n/exit\n"),
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
    input: ttyFrom("/list\n/exit\n"),
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
    input: ttyFrom("/nope\n/exit\n"),
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
    input: ttyFrom("/list\n/exit\n"),
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
    input: ttyFrom("/\u001b[31mnope\n/exit\n"),
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
    input: ttyFrom("/status 123e4567-e89b-12d3-a456-426614174000\n/exit\n"),
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
    input: ttyFrom("/result 123e4567-e89b-12d3-a456-426614174000\n/exit\n"),
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
    input: ttyFrom("/\u009b31mnope\n/exit\n"),
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
      input: ttyFrom("hello\n"),
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
      input: ttyFrom(`${command.name}\n`),
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
    input: ttyFrom("/help\n/exit\n"),
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
    input: ttyFrom("/help\n/exit\n"),
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
    input: ttyFrom(
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
    input: ttyFrom("/start add a regression test for the retry path\n/exit\n"),
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
    input: ttyFrom("/start ship it\n/list\n/exit\n"),
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
    input: ttyFrom("/start\n/exit\n"),
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
    input: ttyFrom("/start ship it\n/exit\n"),
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
    input: ttyFrom("/start ship it\n/exit\n"),
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

/**
 * A console-visible cost detector: the two methods a front needs, backed by the
 * real block shape so the rendering under test is the rendering an operator sees.
 */
function fakeCostAnomaly(
  block: {
    chargedUsd: number;
    expectedUsd: number;
    ratio: number;
    confirmingObservations: number;
  } = { chargedUsd: 0.00072597, expectedUsd: 0.00042445, ratio: 1.6185, confirmingObservations: 2 },
): CostAnomalyControl & { released: string[] } {
  const scopes = new Map([
    [
      "openrouter/@preset/deepseekflash",
      { provider: "openrouter", model: "@preset/deepseekflash" },
    ],
  ]);
  return {
    released: [],
    blocked() {
      return [...scopes.values()].map((scope) => ({
        ...scope,
        block: { at: 0, acceptedRatio: 1, ...block },
      }));
    },
    release(provider, model) {
      const key = `${provider}/${model}`;
      if (!scopes.has(key)) return undefined;
      scopes.delete(key);
      this.released.push(key);
      return { at: 0, acceptedRatio: 1, ...block };
    },
  };
}

test("a price-blocked turn names both amounts and the console command that accepts the price", async () => {
  const detector = fakeCostAnomaly();
  const session = fakeSession({
    stepError: new CostAnomalyBlockedError("openrouter", "@preset/deepseekflash", {
      at: 0,
      chargedUsd: 0.00072597,
      expectedUsd: 0.00042445,
      ratio: 1.6185,
      acceptedRatio: 1,
      confirmingObservations: 2,
    }),
  });
  const error = new Capture();
  const result = await runConsole({
    session,
    input: ttyFrom("first\nsecond\n"),
    output: new Capture(),
    error,
    mode: "json",
    costAnomaly: detector,
  });

  // The block is an operator decision, not a dead session: input keeps flowing
  // and EOF is the reason, so `/cost release` is reachable from the next line.
  expect(result).toEqual({ reason: "eof", completedTurns: 0 });
  expect(session.inputs).toEqual(["first", "second"]);
  const records = error
    .text()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.type === "console_error");
  expect(records).toHaveLength(2);
  const record = records[0] as {
    code: string;
    message: string;
    action: string;
    retryable: boolean;
  };
  expect(record.code).toBe("cost_anomaly_blocked");
  expect(record.message).toContain("openrouter/@preset/deepseekflash");
  expect(record.message).toContain("$0.000726");
  expect(record.message).toContain("$0.000424");
  expect(record.message).toContain("+62%");
  expect(record.action).toContain("/cost release openrouter/@preset/deepseekflash");
  // Retrying the same prompt on a blocked model can only fail again.
  expect(record.retryable).toBe(false);
});

test("/cost lists blocked scopes and /cost release accepts one price without leaving the console", async () => {
  const detector = fakeCostAnomaly();
  const session = fakeSession();
  const output = new Capture();
  await runConsole({
    session,
    input: ttyFrom("/cost\n/cost release openrouter/@preset/deepseekflash\n/exit\n"),
    output,
    error: new Capture(),
    mode: "json",
    costAnomaly: detector,
  });

  // Neither control dispatched a model turn.
  expect(session.inputs).toEqual([]);
  const records = output
    .text()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records[0]).toEqual({
    type: "cost_status",
    blocked: [
      {
        provider: "openrouter",
        model: "@preset/deepseekflash",
        block: {
          at: 0,
          acceptedRatio: 1,
          chargedUsd: 0.00072597,
          expectedUsd: 0.00042445,
          ratio: 1.6185,
          confirmingObservations: 2,
        },
      },
    ],
  });
  expect(records[1]).toMatchObject({
    type: "cost_release",
    provider: "openrouter",
    model: "@preset/deepseekflash",
  });
  expect(detector.released).toEqual(["openrouter/@preset/deepseekflash"]);
});

test("a formatted /cost renders the amounts, the overcharge, and the release command", async () => {
  const output = new Capture();
  await runConsole({
    session: fakeSession(),
    input: ttyFrom("/cost\n/exit\n"),
    output,
    error: new Capture(),
    mode: "formatted",
    costAnomaly: fakeCostAnomaly(),
  });

  const text = output.text();
  expect(text).toContain("openrouter/@preset/deepseekflash is blocked");
  expect(text).toContain("declared $0.000424");
  expect(text).toContain("billed $0.000726");
  expect(text).toContain("+62%");
  expect(text).toContain("confirmed by 2 responses");
  expect(text).toContain("/cost release openrouter/@preset/deepseekflash");
});

test("/cost release reports an unblocked scope instead of reading as success", async () => {
  const error = new Capture();
  await runConsole({
    session: fakeSession(),
    input: ttyFrom("/cost release openrouter/other\n/exit\n"),
    output: new Capture(),
    error,
    mode: "json",
    costAnomaly: fakeCostAnomaly(),
  });

  const record = JSON.parse(error.text().trim()) as {
    code: string;
    message: string;
    action: string;
  };
  expect(record.code).toBe("not_found");
  expect(record.message).toContain("openrouter/other");
  expect(record.action).toContain("/cost");
});

test("/cost is unavailable with the action that enables it when the session carries no detector", async () => {
  const output = new Capture();
  const error = new Capture();
  await runConsole({
    session: fakeSession(),
    input: ttyFrom("/help\n/cost\n/exit\n"),
    output,
    error,
    mode: "json",
  });

  const help = JSON.parse(output.text().trim().split("\n")[0] as string) as {
    commands: Array<{ name: string; available: boolean; unavailableAction?: string }>;
  };
  const cost = help.commands.find((command) => command.name === "/cost");
  expect(cost?.available).toBe(false);
  expect(cost?.unavailableAction).toContain("project directory");
  const record = JSON.parse(error.text().trim()) as { code: string; retryable: boolean };
  expect(record.code).toBe("not_available");
  expect(record.retryable).toBe(false);
});

test("a paused pipeline notice carries the pause record and says resumable, not failed (issue #261)", async () => {
  const session = fakeSession();
  session.subscribeBackgroundRuns = (consumer) => {
    consumer({
      type: "background_events",
      runId: "pause-run",
      events: [
        {
          sequence: 1,
          runId: "pause-run",
          lifecycle: "paused",
          stage: "plan",
          timestamp: 1,
          pause: {
            phase: "plan",
            code: "stage_limit",
            action: "increase or disable the duration stage limit, then resume explicitly",
            limitReason: "duration",
            limit: 180000,
          },
          metrics: { steps: 1, totalCost: 0.0064 },
        },
      ],
      nextCursor: 1,
      gap: false,
      droppedEvents: 0,
      pending: false,
    } as unknown as BackgroundRunNotice);
    return () => undefined;
  };
  const error = new Capture();
  await runConsole({
    session,
    input: ttyFrom("/exit\n"),
    output: new Capture(),
    error,
  });
  expect(session.inputs).toEqual([]);
  expect(error.text()).toContain("background pipeline pause-run paused (plan)");
  expect(error.text()).toContain("stage_limit");
  expect(error.text()).toContain("limit duration");
  expect(error.text()).toContain("the run is resumable, not failed");
});

test("a paused notice whose pause payload fails validation still projects the lifecycle, degraded", async () => {
  const session = fakeSession();
  session.subscribeBackgroundRuns = (consumer) => {
    consumer({
      type: "background_events",
      runId: "pause-run",
      events: [
        {
          sequence: 1,
          runId: "pause-run",
          lifecycle: "paused",
          timestamp: 1,
          pause: { phase: "plan", code: 42, action: "increase it" },
        },
      ],
      nextCursor: 1,
      gap: false,
      droppedEvents: 0,
      pending: false,
    } as unknown as BackgroundRunNotice);
    return () => undefined;
  };
  const error = new Capture();
  await runConsole({
    session,
    input: ttyFrom("/exit\n"),
    output: new Capture(),
    error,
  });
  expect(session.inputs).toEqual([]);
  // A payload that cannot be validated never renders one: a pause without its
  // record must not invent confidence about the limit.
  expect(error.text()).toContain("background pipeline pause-run paused");
  expect(error.text()).not.toContain("stage_limit");
  expect(error.text()).not.toContain("increase it");
});

/**
 * A ledger row shaped exactly as the real per-turn Ledger emits it (the same
 * fixture shape test/orchestrator.test.ts pins), parameterized so one helper
 * writes every front's ledger in these tests.
 */
function resumeRow(
  runId: string,
  role: string,
  step: string,
  total = 0.25,
  ts = 1_757_000_000_000,
): LedgerRecord {
  return {
    ts,
    runId,
    lane: "main",
    role,
    step,
    provider: "faux",
    model: "faux-1",
    stopReason: "stop",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    },
  };
}

function writeLedgerFile(targetDir: string, runId: string, rows: readonly LedgerRecord[]): string {
  const ledgerDir = path.join(targetDir, ".ad-coder", "ledger");
  fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(ledgerDir, `${runId}.jsonl`);
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, {
    mode: 0o600,
  });
  return filePath;
}

/** Backdate a ledger so mtime-based discovery has an unambiguous ordering. */
function backdate(filePath: string, seconds: number): void {
  const past = new Date(Date.now() - seconds * 1_000);
  fs.utimesSync(filePath, past, past);
}

test("--resume with an unknown id fails typed and creates nothing", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-resume-")));
  expect(() => resolveResumeRun(target, { bare: false, runId: "never-started" })).toThrowError(
    /no ledger for run never-started under \.ad-coder\/ledger\//,
  );
  // The refusal names the id and the recovery action, and nothing was created.
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);
});

test("--resume validates a traversal-shaped id before any path is built", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-resume-")));
  for (const malformed of ["../escape", "a/b", "", ".hidden", "x".repeat(65)]) {
    try {
      resolveResumeRun(target, { bare: false, runId: malformed });
      throw new Error(`expected ${JSON.stringify(malformed)} to be refused`);
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectStoreError);
      const typed = error as ProjectStoreError;
      expect(typed.code).toBe("invalid_id");
      expect(typed.message).toContain("--resume");
    }
  }
  // A malformed id is refused before any path is built: no directories, no
  // ledger file, nothing to clean up.
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);
});

test("bare --resume picks the latest ORCHESTRATOR ledger and skips a newer drive ledger", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-resume-")));
  // A drive/role ledger: stage-role rows, never a front turn row. Newer on
  // disk, and the discriminator must still skip it.
  const driveRun = writeLedgerFile(target, "drive-newer", [
    resumeRow("drive-newer", "coder", "run"),
    resumeRow("drive-newer", "reviewer", "run"),
  ]);
  backdate(driveRun, 0);
  // The orchestrator front: role "orchestrator" with step "turn:N" -- here
  // AFTER a delegated row, because a front that delegates immediately writes
  // the delegated rows first; the discriminator is ANY front row, not the
  // first record.
  const orchestratorRun = writeLedgerFile(target, "orch-older", [
    resumeRow("orch-older", "coder", "role:coder"),
    resumeRow("orch-older", "orchestrator", "turn:1"),
  ]);
  backdate(orchestratorRun, 60);
  // A durable session for the winner only, as a previous console would leave.
  fs.mkdirSync(
    path.join(
      target,
      ".ad-coder",
      "sessions",
      `--${target.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
    ),
    {
      recursive: true,
      mode: 0o700,
    },
  );
  fs.writeFileSync(
    path.join(
      target,
      ".ad-coder",
      "sessions",
      `--${target.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
      `2026-09-18T10-00-00-000Z_orch-older.jsonl`,
    ),
    "",
    { mode: 0o600 },
  );

  const resumed = resolveResumeRun(target, { bare: true });
  expect(resumed.runId).toBe("orch-older");
  // The winner's rows ride along: this IS the seed the restarted sink replays.
  expect(resumed.seedRecords).toHaveLength(2);
  expect(resumed.skippedRows).toBe(0);
  // The stand-alone role command can run the orchestrator ROLE, so a role
  // ledger could carry role "orchestrator" rows -- with step "run", which the
  // discriminator must reject. Pin that shape as skipped too.
  const roleOrchestrator = writeLedgerFile(target, "role-orch", [
    resumeRow("role-orch", "orchestrator", "run"),
  ]);
  backdate(roleOrchestrator, 0);
  expect(resolveResumeRun(target, { bare: true }).runId).toBe("orch-older");
});

test("bare --resume with no orchestrator ledger fails with the start-fresh action", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-resume-")));
  // Only drive/role ledgers exist: nothing identifies an orchestrator front.
  writeLedgerFile(target, "drive-only", [resumeRow("drive-only", "coder", "run")]);
  expect(() => resolveResumeRun(target, { bare: true })).toThrowError(
    /no previous orchestrator session found; start without --resume/,
  );
  // A target with no ledger directory at all behaves the same way.
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-resume-")));
  expect(() => resolveResumeRun(empty, { bare: true })).toThrowError(
    /no previous orchestrator session found; start without --resume/,
  );
  expect(fs.existsSync(path.join(empty, ".ad-coder"))).toBe(false);
});

test("--resume skips a symlinked ledger and invalid ledger names during discovery", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-resume-")));
  writeLedgerFile(target, "outside", [resumeRow("outside", "coder", "run")]);
  const ledgerDir = path.join(target, ".ad-coder", "ledger");
  // A drive-shaped ledger the symlink points at, plus a symlink named like a
  // ledger: neither is ever a candidate and the symlink is never followed.
  fs.symlinkSync(path.join(ledgerDir, "outside.jsonl"), path.join(ledgerDir, "linked.jsonl"));
  fs.writeFileSync(path.join(ledgerDir, "we..ird.jsonl"), "", { mode: 0o600 });
  expect(() => resolveResumeRun(target, { bare: true })).toThrowError(
    /no previous orchestrator session found/,
  );
  // The pointed-at file is untouched -- discovery never writes.
  expect(fs.readFileSync(path.join(ledgerDir, "outside.jsonl"), "utf8")).toContain("coder");
});

test("--resume refuses a symlinked ledger directory on both forms", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-resume-")));
  const realDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-ledger2-")));
  fs.mkdirSync(path.join(target, ".ad-coder"), { recursive: true, mode: 0o700 });
  fs.symlinkSync(realDir, path.join(target, ".ad-coder", "ledger"));
  // Discovery through a symlinked ledger dir finds nothing (and never
  // follows the link out).
  expect(() => resolveResumeRun(target, { bare: true })).toThrowError(
    /no previous orchestrator session found/,
  );
  // The explicit form names the refusal instead of reading through the link.
  fs.writeFileSync(path.join(realDir, "resumable.jsonl"), "", { mode: 0o600 });
  try {
    resolveResumeRun(target, { bare: false, runId: "resumable" });
    throw new Error("expected the symlinked ledger dir to be refused");
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectStoreError);
    expect((error as ProjectStoreError).code).toBe("unsafe_path");
  }
  // The link still points at an untouched directory: nothing was written.
  expect(fs.readdirSync(realDir)).toEqual(["resumable.jsonl"]);
});

test("an explicit --resume reads the previous rows for the seed and reports skipped ones", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-resume-")));
  const good = resumeRow("resumable", "orchestrator", "turn:1");
  const truncated = `{"ts":100,"runId":"resumca"`;
  const ledgerPath = path.join(target, ".ad-coder", "ledger", "resumable.jsonl");
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(good)}\n\n${truncated}\n`, { mode: 0o600 });
  const sessionsDir = path.join(
    target,
    ".ad-coder",
    "sessions",
    `--${target.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sessionsDir, "2026-09-18T10-00-00-000Z_resumable.jsonl"), "", {
    mode: 0o600,
  });

  const resumed = resolveResumeRun(target, { bare: false, runId: "resumable" });
  expect(resumed.runId).toBe("resumable");
  expect(resumed.seedRecords).toEqual([good]);
  // The truncated tail a live writer left mid-write degrades non-fatally and
  // is reported, never thrown and never silently dropped.
  expect(resumed.skippedRows).toBe(1);
  expect(resumed.ledgerPath).toBe(ledgerPath);
});

test("the resume flag is the only seam that injects a run id into the config", () => {
  // The default flow must stay byte-identical: without --resume the
  // orchestrator config gains NOTHING, so startOrchestrator keeps minting a
  // fresh run id (and a fresh session) on every start.
  expect(resumeOrchestratorConfig(undefined)).toBeUndefined();
  const resumed = {
    runId: "resumable",
    ledgerPath: "/tmp/whatever/.ad-coder/ledger/resumable.jsonl",
    seedRecords: [resumeRow("resumable", "orchestrator", "turn:1")],
    skippedRows: 0,
  };
  expect(resumeOrchestratorConfig(resumed)).toEqual({
    runId: "resumable",
    seedLedgerRecords: resumed.seedRecords,
  });
  // A clean seed is silent; a partial seed is named before the first turn,
  // with a LEDGER_BASE_DIR-relative path only.
  expect(resumeSeedNote(resumed)).toBeUndefined();
  expect(resumeSeedNote({ ...resumed, skippedRows: 2 })).toBe(
    "ad-coder: resumed ledger .ad-coder/ledger/resumable.jsonl skipped 2 unparseable row(s); pre-restart cost is partial\n",
  );
});

test("--resume refuses a run whose durable session is gone, creating nothing", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-resume-")));
  writeLedgerFile(target, "sessionless", [resumeRow("sessionless", "orchestrator", "turn:1")]);
  expect(() => resolveResumeRun(target, { bare: false, runId: "sessionless" })).toThrowError(
    /no durable session for run sessionless under \.ad-coder\/sessions\//,
  );
  // The failed resume created nothing new.
  expect(fs.existsSync(path.join(target, ".ad-coder", "sessions"))).toBe(false);
});

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** Spawn the real CLI front: the resume refusals fire before any model call. */
function runConsoleCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", path.join(REPO_ROOT, "src/cli.ts"), ...args], {
    cwd: REPO_ROOT,
    stdin: "ignore",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

test("the real console front refuses a malformed --resume id typed and creates nothing", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-console-")));
  const failed = runConsoleCli(["console", "--resume", "../escape", "--target-dir", target]);
  expect(failed.code).not.toBe(0);
  // The human line names the pattern and the recovery action; no session and
  // no ledger file were created on the way out.
  expect(failed.stderr).toContain("runId must match");
  expect(failed.stderr).toContain("start without --resume");
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);
});

test("the real console front refuses an unknown --resume id for both forms", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-console-")));
  const human = runConsoleCli(["console", "--resume", "never-started", "--target-dir", target]);
  expect(human.code).not.toBe(0);
  expect(human.stderr).toContain("no ledger for run never-started");
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);

  const machine = runConsoleCli([
    "console",
    "--json",
    "--resume",
    "never-started",
    "--target-dir",
    target,
  ]);
  expect(machine.code).not.toBe(0);
  // The machine record keeps the stable typed shape (errors contract): code
  // plus the id as detail, never file contents.
  const record = JSON.parse(machine.stderr) as { error: { code: string; detail: string } };
  expect(record.error.code).toBe("not_found");
  expect(record.error.detail).toBe("never-started");
});

test("the real console front refuses a bare --resume with nothing to continue", () => {
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-console-")));
  const failed = runConsoleCli(["console", "--resume", "--target-dir", target]);
  expect(failed.code).not.toBe(0);
  expect(failed.stderr).toContain("no previous orchestrator session found");
  expect(failed.stderr).toContain("start without --resume");
  // The bare form's refusal also creates nothing.
  expect(fs.existsSync(path.join(target, ".ad-coder"))).toBe(false);
});

test("console --help renders --resume from the single registry", () => {
  // Help is DERIVED from the registry (cli.md 2026-09-11): declaring the
  // option once must be enough for the usage line to carry it.
  const help = runConsoleCli(["console", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("--resume [<run-id>]");
  expect(help.stdout).toContain("most recent one");
});
