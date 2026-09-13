import type {
  ConversationSession,
  ConversationToolCall,
  ConversationTurnResult,
} from "../conversation/conversation";
import type { ToolActivityConfig } from "../observability/tool-activity";
import type { BackgroundRunNotice } from "../orchestration/background-runs";
import { EmptyTurnError } from "../runner/errors";
import { SessionLimitError } from "../session-limits";
import { ToolActivityRenderer } from "./tool-activity";

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
  toolActivity?: Partial<ToolActivityConfig>;
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
    ...(result.droppedActivityEvents !== undefined && {
      droppedActivityEvents: result.droppedActivityEvents,
    }),
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

const BACKGROUND_LIFECYCLES = new Set([
  "requested",
  "started",
  "stage_changed",
  "operator_attention",
  "failed",
  "cancelled",
  "timed_out",
  "completed",
]);
const BACKGROUND_STAGES = new Set(["plan", "research", "security", "code", "review", "done"]);

function safeNoticeText(value: unknown): string {
  return typeof value === "string" ? sanitizeTerminalText(value) : "unknown";
}
function safeNoticeEnum(value: unknown, values: Set<string>): string | undefined {
  return typeof value === "string" && values.has(value) ? value : undefined;
}
function safeNoticeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function renderBackgroundNotice(notice: BackgroundRunNotice, mode: ConsoleOutputMode): string {
  const runId = safeNoticeText(notice.runId);
  const events = Array.isArray(notice.events)
    ? notice.events.flatMap((event) => {
        const lifecycle = safeNoticeEnum(event.lifecycle, BACKGROUND_LIFECYCLES);
        if (lifecycle === undefined) return [];
        const stage = safeNoticeEnum(event.stage, BACKGROUND_STAGES);
        const errorCode = safeNoticeEnum(
          event.errorCode,
          new Set(["internal_failure", "operator_attention", "deadline_exceeded"]),
        );
        const metrics = event.metrics;
        return [
          {
            sequence: safeNoticeInteger(event.sequence),
            runId: safeNoticeText(event.runId),
            lifecycle,
            timestamp: safeNoticeInteger(event.timestamp),
            ...(stage === undefined ? {} : { stage }),
            ...(errorCode === undefined ? {} : { errorCode }),
            ...(metrics !== undefined &&
            Number.isSafeInteger(metrics.steps) &&
            metrics.steps >= 0 &&
            typeof metrics.totalCost === "number" &&
            Number.isFinite(metrics.totalCost) &&
            metrics.totalCost >= 0
              ? { metrics: { steps: metrics.steps, totalCost: metrics.totalCost } }
              : {}),
          },
        ];
      })
    : [];
  const droppedEvents = safeNoticeInteger(notice.droppedEvents);
  const pending = notice.pending === true;
  if (mode === "json") {
    return `${JSON.stringify({
      type: "background_events",
      runId,
      events,
      nextCursor: safeNoticeInteger(notice.nextCursor),
      gap: notice.gap === true,
      droppedEvents,
      pending,
    })}\n`;
  }
  const lines = events.map(({ lifecycle, stage }) => {
    const renderedStage = stage === undefined ? "" : ` (${stage})`;
    return `ad-coder: background pipeline ${runId} ${lifecycle}${renderedStage}`;
  });
  if (droppedEvents > 0)
    lines.push(`ad-coder: background pipeline ${runId} dropped ${droppedEvents} events`);
  if (pending)
    lines.push(`ad-coder: background pipeline ${runId} has more events; poll pipeline_events`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
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
  let lineQueue = Promise.resolve();
  const handleLine = async (rawLine: string): Promise<void> => {
    if (stopped) return;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
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
      let lastActivity = started;
      const progress = (event: "started" | "heartbeat") => {
        const elapsedSeconds = Math.floor((Date.now() - started) / 1000);
        params.error.write(
          mode === "json"
            ? `${JSON.stringify({ type: "progress", event, stage: "console-turn", elapsedSeconds })}\n`
            : `ad-coder: console turn ${event === "started" ? "started" : "still running"} (${elapsedSeconds}s)\n`,
        );
      };
      const renderer = new ToolActivityRenderer(
        params.error,
        mode === "json" ? "json" : "human",
        params.toolActivity,
      );
      const unsubscribe = params.session.subscribeToolActivity?.((event) => {
        lastActivity = Date.now();
        renderer.consume(event);
      });
      progress("started");
      const timer =
        heartbeatMs > 0
          ? setInterval(() => {
              const now = Date.now();
              if (now - lastActivity >= heartbeatMs) {
                progress("heartbeat");
                lastActivity = now;
              }
            }, heartbeatMs)
          : undefined;
      let rawResult: ConversationTurnResult;
      try {
        rawResult = await params.session.step(line);
      } finally {
        if (timer !== undefined) clearInterval(timer);
        unsubscribe?.();
        renderer.close();
      }
      const result = sanitizeTurn(rawResult);
      completedTurns++;
      params.output.write(
        mode === "json" ? `${JSON.stringify(result)}\n` : renderFormatted(result),
      );
      if (mode === "formatted") params.output.write("ad-coder> ");
    } catch (error) {
      if (error instanceof SessionLimitError) {
        params.error.write(
          mode === "json"
            ? `${JSON.stringify({ type: "console_error", code: "session_limit" })}\n`
            : SESSION_LIMIT_MESSAGE,
        );
        reason = "session_limit";
      } else if (error instanceof EmptyTurnError) {
        params.error.write(
          mode === "json"
            ? `${JSON.stringify({ type: "console_error", code: "empty_turn" })}\n`
            : "ad-coder: provider returned a failed empty turn; verify authentication and retry\n",
        );
        reason = "turn_failed";
      } else {
        params.error.write(
          mode === "json"
            ? `${JSON.stringify({ type: "console_error", code: "turn_failed" })}\n`
            : TURN_FAILED_MESSAGE,
        );
        reason = "turn_failed";
      }
      stopped = true;
    }
  };
  const queueLine = (): void => {
    const line = Buffer.from(lineBytes).toString("utf8");
    lineBytes = [];
    lineQueue = lineQueue.then(() => handleLine(line));
  };

  let unsubscribeBackground: (() => void) | undefined;
  try {
    unsubscribeBackground = params.session.subscribeBackgroundRuns?.((notice) => {
      params.error.write(renderBackgroundNotice(notice, mode));
    });
  } catch {
    params.error.write(
      mode === "json"
        ? '{"type":"background_notice_error","code":"subscription_failed","recovery":"poll"}\n'
        : "ad-coder: background notices unavailable; use pipeline polling tools\n",
    );
  }

  try {
    if (mode === "formatted") {
      params.output.write("ad-coder console — /exit or EOF to close\nad-coder> ");
    }
    for await (const rawChunk of params.input as AsyncIterable<Buffer | string>) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      for (const byte of chunk) {
        if (byte === 0x0a) {
          queueLine();
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
    if (!stopped && lineBytes.length > 0) queueLine();
    await lineQueue;
  } catch {
    params.error.write(INPUT_FAILED_MESSAGE);
    reason = "input_failed";
  } finally {
    unsubscribeBackground?.();
    try {
      await params.session.close();
    } catch {
      params.error.write(CLOSE_FAILED_MESSAGE);
      if (isSuccessfulExit(reason)) reason = "close_failed";
    }
  }
  return { reason, completedTurns };
}
