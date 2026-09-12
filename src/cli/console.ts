import type {
  ConversationSession,
  ConversationToolCall,
  ConversationTurnResult,
} from "../conversation/conversation";
import { EmptyTurnError } from "../runner/errors";
import { SessionLimitError } from "../session-limits";

export const DEFAULT_CONSOLE_MAX_INPUT_BYTES = 65_536;

export type ConsoleOutputMode = "formatted" | "json";
export type ConsoleExitReason =
  | "eof"
  | "exit"
  | "input_too_large"
  | "input_failed"
  | "turn_failed"
  | "session_limit"
  | "close_failed";

export interface RunConsoleParams {
  session: ConversationSession;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
  mode?: ConsoleOutputMode;
  maxInputBytes?: number;
  /** Progress interval for an in-flight turn; zero/omitted disables progress. */
  heartbeatMs?: number;
}

export interface ConsoleRunResult {
  reason: ConsoleExitReason;
  completedTurns: number;
}

const INPUT_TOO_LARGE_MESSAGE = "ad-coder: input line exceeds the configured byte limit\n";
const INPUT_FAILED_MESSAGE = "ad-coder: console input failed\n";
const TURN_FAILED_MESSAGE = "ad-coder: console turn failed\n";
const SESSION_LIMIT_MESSAGE = "ad-coder: session resource limit reached\n";
const CLOSE_FAILED_MESSAGE = "ad-coder: console session close failed\n";

function isSuccessfulExit(reason: ConsoleExitReason): boolean {
  return reason === "eof" || reason === "exit";
}

type EscapeState = "text" | "escape" | "escape_intermediate" | "csi" | "string" | "string_escape";

/** Remove terminal control sequences and cursor-affecting control characters from untrusted text. */
function sanitizeTerminalText(value: string): string {
  let state: EscapeState = "text";
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (state === "string") {
      if (code === 0x07 || code === 0x9c) state = "text";
      else if (code === 0x1b) state = "string_escape";
      continue;
    }
    if (state === "string_escape") {
      state = character === "\\" ? "text" : code === 0x1b ? "string_escape" : "string";
      continue;
    }
    if (state === "csi") {
      if (code >= 0x40 && code <= 0x7e) state = "text";
      continue;
    }
    if (state === "escape_intermediate") {
      if (code >= 0x30 && code <= 0x7e) state = "text";
      continue;
    }
    if (state === "escape") {
      if (character === "[" || code === 0x9b) state = "csi";
      else if ("PX^_]".includes(character)) state = "string";
      else if (code >= 0x20 && code <= 0x2f) state = "escape_intermediate";
      else state = "text";
      continue;
    }
    if (code === 0x1b) {
      state = "escape";
    } else if (code === 0x9b) {
      state = "csi";
    } else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      state = "string";
    } else if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) {
      result += character;
    }
  }
  return result;
}

function sanitizeTurn(result: ConversationTurnResult): ConversationTurnResult {
  const toolCalls: ConversationToolCall[] = result.toolCalls.map(({ toolName, toolCallId }) => ({
    toolName: sanitizeTerminalText(toolName),
    toolCallId: sanitizeTerminalText(toolCallId),
  }));
  return {
    runId: sanitizeTerminalText(result.runId),
    step: sanitizeTerminalText(result.step),
    status: sanitizeTerminalText(result.status),
    assistantText: sanitizeTerminalText(result.assistantText),
    toolCalls,
    droppedRecords: result.droppedRecords,
  };
}

function renderFormatted(result: ConversationTurnResult): string {
  const lines = [`[${result.step}] ${result.status} (runId ${result.runId})`];
  if (result.assistantText !== "") lines.push(result.assistantText);
  if (result.toolCalls.length > 0) {
    lines.push(
      `tools: ${result.toolCalls.map(({ toolName, toolCallId }) => `${toolName} (${toolCallId})`).join(", ")}`,
    );
  }
  lines.push(`dropped records: ${result.droppedRecords}`);
  return `${lines.join("\n")}\n`;
}

/** Run the minimal persistent human console over an already assembled conversation session. */
export async function runConsole(params: RunConsoleParams): Promise<ConsoleRunResult> {
  const mode = params.mode ?? "formatted";
  const maxInputBytes = params.maxInputBytes ?? DEFAULT_CONSOLE_MAX_INPUT_BYTES;
  const heartbeatMs = params.heartbeatMs ?? 0;
  if (!Number.isInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new RangeError("maxInputBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0)
    throw new RangeError("heartbeatMs must be a non-negative safe integer");

  let reason: ConsoleExitReason = "eof";
  let completedTurns = 0;
  let lineBytes: number[] = [];
  let stopped = false;
  const handleLine = async (): Promise<void> => {
    let line = Buffer.from(lineBytes).toString("utf8");
    lineBytes = [];
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() === "") {
      if (mode === "formatted") params.output.write("ad-coder> ");
      return;
    }
    if (line.trim() === "/exit") {
      reason = "exit";
      stopped = true;
      return;
    }
    try {
      const started = Date.now();
      const progress = (event: "started" | "heartbeat") => {
        const elapsedSeconds = Math.floor((Date.now() - started) / 1000);
        params.error.write(
          mode === "json"
            ? `${JSON.stringify({ type: "progress", event, stage: "console-turn", elapsedSeconds })}\n`
            : `ad-coder: console turn ${event === "started" ? "started" : "still running"} (${elapsedSeconds}s)\n`,
        );
      };
      progress("started");
      const timer =
        heartbeatMs > 0 ? setInterval(() => progress("heartbeat"), heartbeatMs) : undefined;
      let rawResult: ConversationTurnResult;
      try {
        rawResult = await params.session.step(line);
      } finally {
        if (timer !== undefined) clearInterval(timer);
      }
      const result = sanitizeTurn(rawResult);
      completedTurns++;
      params.output.write(
        mode === "json" ? `${JSON.stringify(result)}\n` : renderFormatted(result),
      );
      if (mode === "formatted") params.output.write("ad-coder> ");
    } catch (error) {
      if (error instanceof SessionLimitError) {
        params.error.write(SESSION_LIMIT_MESSAGE);
        reason = "session_limit";
      } else if (error instanceof EmptyTurnError) {
        params.error.write(
          "ad-coder: provider returned a failed empty turn; verify authentication and retry\n",
        );
        reason = "turn_failed";
      } else {
        params.error.write(TURN_FAILED_MESSAGE);
        reason = "turn_failed";
      }
      stopped = true;
    }
  };

  try {
    if (mode === "formatted") {
      params.output.write("ad-coder console — /exit or EOF to close\nad-coder> ");
    }
    for await (const rawChunk of params.input as AsyncIterable<Buffer | string>) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      for (const byte of chunk) {
        if (byte === 0x0a) {
          await handleLine();
          if (stopped) break;
        } else {
          if (
            lineBytes.length >= maxInputBytes &&
            !(lineBytes.length === maxInputBytes && byte === 0x0d)
          ) {
            params.error.write(INPUT_TOO_LARGE_MESSAGE);
            reason = "input_too_large";
            stopped = true;
            break;
          }
          lineBytes.push(byte);
        }
      }
      if (stopped) break;
    }
    if (!stopped && lineBytes.length > 0) await handleLine();
  } catch {
    params.error.write(INPUT_FAILED_MESSAGE);
    reason = "input_failed";
  } finally {
    try {
      await params.session.close();
    } catch {
      params.error.write(CLOSE_FAILED_MESSAGE);
      if (isSuccessfulExit(reason)) reason = "close_failed";
    }
  }
  return { reason, completedTurns };
}
