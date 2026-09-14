import {
  ConsoleControlError,
  DEFAULT_CONSOLE_CONTROL_PAGE_SIZE,
  executeConsoleControl,
  findConsoleCommand,
} from "../conversation/console-control";
import type {
  ConversationSession,
  ConversationToolCall,
  ConversationTurnResult,
} from "../conversation/conversation";
import { TurnInterruptedError } from "../conversation/conversation";
import type { ToolActivityConfig } from "../observability/tool-activity";
import type { BackgroundRunManager, BackgroundRunNotice } from "../orchestration/background-runs";
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
  | "interrupted"
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
  /** Bounded count for local background list/event output. */
  controlPageSize?: number;
  /**
   * Time to wait for bytes completing an ambiguous lone Escape. Terminal escape
   * sequences are parsed deterministically; raise this for slow remote TTYs.
   */
  escapeSequenceTimeoutMs?: number;
  toolActivity?: Partial<ToolActivityConfig>;
  /** Process-local cooperative shutdown probe supplied by the CLI front. */
  interrupted?: () => boolean;
  /** Exact operator command shown after an empty provider turn. */
  authenticationCommand?: string;
}

export interface ConsoleRunResult {
  reason: ConsoleExitReason;
  completedTurns: number;
}

const INPUT_TOO_LARGE_FAILURE = {
  code: "input_too_large",
  message: "input line exceeds the configured byte limit",
  // The byte ceiling is a programmatic runConsole parameter; the CLI exposes no
  // flag for it, so the action must not name one.
  action: "send a shorter line, or raise maxInputBytes when embedding runConsole",
  // The same oversized line cannot succeed on a retry.
  retryable: false,
} as const;
const INPUT_FAILED_FAILURE = {
  code: "input_failed",
  message: "console input failed",
  action: "restart the console; the input stream is no longer readable",
  retryable: false,
} as const;
const CLOSE_FAILED_FAILURE = {
  code: "close_failed",
  message: "console session close failed",
  action: "check for background runs that outlived the session with: ad-coder background list",
  retryable: false,
} as const;

/**
 * Every console failure — control and turn alike — reaches stderr through this
 * one projection: a stable `code`, safe text naming the failed operation,
 * whether a retry can succeed, and the next action (docs/contracts/errors.md).
 * Untrusted text is sanitized for BOTH projections, because a machine-mode JSON
 * record is still read in a terminal and `JSON.stringify` does not escape C1
 * control characters.
 */
function renderFailure(
  failure: {
    code: string;
    command?: string;
    message: string;
    action: string;
    retryable: boolean;
  },
  mode: ConsoleOutputMode,
): string {
  const message = sanitizeTerminalText(failure.message);
  const action = sanitizeTerminalText(failure.action);
  if (mode === "json")
    return `${JSON.stringify({
      type: "console_error",
      code: failure.code,
      ...(failure.command === undefined ? {} : { command: sanitizeTerminalText(failure.command) }),
      message,
      action,
      retryable: failure.retryable,
    })}\n`;
  return `ad-coder: ${message}; ${action}\n`;
}
export const DEFAULT_CONSOLE_ESCAPE_SEQUENCE_TIMEOUT_MS = 1_000;

interface TtyReadableStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
}

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

function renderControl(
  result: Awaited<ReturnType<typeof executeConsoleControl>>,
  mode: ConsoleOutputMode,
  controlPageSize: number,
): string {
  if (result === undefined) return "";
  const status = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const entry = value as {
      runId?: unknown;
      lifecycle?: unknown;
      metrics?: { steps?: unknown; totalCost?: unknown };
      recovery?: unknown;
      approved?: unknown;
      rounds?: unknown;
      verdict?: unknown;
    };
    if (typeof entry.runId !== "string" || !BACKGROUND_LIFECYCLES.has(entry.lifecycle as string))
      return undefined;
    const metrics = entry.metrics;
    if (
      metrics === undefined ||
      typeof metrics.steps !== "number" ||
      !Number.isSafeInteger(metrics.steps) ||
      metrics.steps < 0 ||
      typeof metrics.totalCost !== "number" ||
      !Number.isFinite(metrics.totalCost) ||
      metrics.totalCost < 0
    )
      return undefined;
    const recovery = safeNoticeEnum(
      entry.recovery,
      new Set(["wait", "inspect_events", "resume_pipeline", "none"]),
    );
    return {
      runId: safeNoticeText(entry.runId),
      lifecycle: entry.lifecycle,
      metrics: { steps: metrics.steps, totalCost: metrics.totalCost },
      ...(recovery === undefined ? {} : { recovery }),
      ...(typeof entry.approved === "boolean" ? { approved: entry.approved } : {}),
      ...(Number.isSafeInteger(entry.rounds) && (entry.rounds as number) >= 0
        ? { rounds: entry.rounds }
        : {}),
      ...(safeNoticeEnum(entry.verdict, new Set(["approved", "changes_requested"])) === undefined
        ? {}
        : { verdict: safeNoticeEnum(entry.verdict, new Set(["approved", "changes_requested"])) }),
    };
  };
  let safe: Record<string, unknown>;
  if (result.type === "console_help")
    safe = {
      type: result.type,
      commands: result.commands.map((command) => ({
        name: command.name,
        usage: command.usage,
        description: command.description,
        args: command.args.map((argument) => ({
          name: argument.name,
          required: argument.required,
          description: argument.description,
        })),
        example: command.example,
        available: command.available,
        ...(command.unavailableAction === undefined
          ? {}
          : { unavailableAction: command.unavailableAction }),
      })),
    };
  else if (result.type === "console_control")
    safe = { type: result.type, command: result.command, status: result.status };
  else if (result.type === "background_list")
    safe = {
      type: result.type,
      runs: result.runs.slice(0, controlPageSize).flatMap((run) => {
        const projected = status(run);
        return projected === undefined ? [] : [projected];
      }),
    };
  else if (result.type === "background_events")
    safe = {
      type: result.type,
      runId: safeNoticeText(result.runId),
      events: result.events.slice(0, controlPageSize).flatMap((event) => {
        const projected = projectBackgroundEvent(event);
        return projected === undefined ? [] : [projected];
      }),
      nextCursor: safeNoticeInteger(result.nextCursor),
      gap: result.gap === true,
    };
  else {
    const projected = status(result.type === "background_result" ? result.result : result.run);
    safe = {
      type: result.type,
      ...(result.type === "background_result" ? { result: projected } : { run: projected }),
    };
  }
  if (mode === "json") return `${JSON.stringify(safe)}\n`;
  if (result.type === "console_help") {
    const width = Math.max(...result.commands.map((command) => command.usage.length));
    return `${result.commands
      .map((command) =>
        [
          `  ${command.usage.padEnd(width)}  ${command.description}${
            command.available ? "" : ` (unavailable: ${command.unavailableAction})`
          }`,
          // Each argument explains itself, so the usage line stays terse.
          ...command.args.map((argument) => `    ${argument.name} ${argument.description}`),
          `    example: ${command.example}`,
        ].join("\n"),
      )
      .join("\n")}\n`;
  }
  if (result.type === "console_control") return `ad-coder: current turn ${result.status}\n`;
  if (result.type === "background_list")
    return `${(safe.runs as Record<string, unknown>[]).map((run) => `ad-coder: background ${run.runId} ${run.lifecycle} steps ${(run.metrics as Record<string, unknown>).steps} cost ${(run.metrics as Record<string, unknown>).totalCost}`).join("\n") || "ad-coder: 0 background runs"}\n`;
  if (result.type === "background_events") {
    const events = safe.events as Array<Record<string, unknown>>;
    const details = events
      .map(
        (event) =>
          `#${event.sequence} ${event.lifecycle}${event.stage === undefined ? "" : ` (${event.stage})`}`,
      )
      .join(", ");
    return `ad-coder: background events ${safeNoticeText(result.runId)} cursor ${safe.nextCursor} gap ${safe.gap}${details === "" ? "" : `: ${details}`}\n`;
  }
  const run = (result.type === "background_result" ? safe.result : safe.run) as
    | Record<string, unknown>
    | undefined;
  if (run === undefined) return "ad-coder: background record unavailable\n";
  const terminal =
    result.type === "background_result"
      ? `${run.approved === undefined ? "" : ` approved ${run.approved}`}${run.rounds === undefined ? "" : ` rounds ${run.rounds}`}${run.verdict === undefined ? "" : ` verdict ${run.verdict}`}`
      : "";
  return `ad-coder: background ${run.runId} ${run.lifecycle} steps ${(run.metrics as Record<string, unknown>).steps} cost ${(run.metrics as Record<string, unknown>).totalCost}${terminal}\n`;
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
  return typeof value === "string" ? sanitizeTerminalText(value).slice(0, 256) : "unknown";
}
function safeNoticeEnum(value: unknown, values: Set<string>): string | undefined {
  return typeof value === "string" && values.has(value) ? value : undefined;
}
function safeNoticeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function projectBackgroundEvent(event: unknown): Record<string, unknown> | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const value = event as {
    lifecycle?: unknown;
    stage?: unknown;
    errorCode?: unknown;
    metrics?: { steps?: unknown; totalCost?: unknown };
    sequence?: unknown;
    runId?: unknown;
    timestamp?: unknown;
  };
  const lifecycle = safeNoticeEnum(value.lifecycle, BACKGROUND_LIFECYCLES);
  if (lifecycle === undefined) return undefined;
  const stage = safeNoticeEnum(value.stage, BACKGROUND_STAGES);
  const errorCode = safeNoticeEnum(
    value.errorCode,
    new Set(["internal_failure", "operator_attention", "deadline_exceeded"]),
  );
  const metrics = value.metrics;
  return {
    sequence: safeNoticeInteger(value.sequence),
    runId: safeNoticeText(value.runId),
    lifecycle,
    timestamp: safeNoticeInteger(value.timestamp),
    ...(stage === undefined ? {} : { stage }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(metrics !== undefined &&
    typeof metrics.steps === "number" &&
    Number.isSafeInteger(metrics.steps) &&
    metrics.steps >= 0 &&
    typeof metrics.totalCost === "number" &&
    Number.isFinite(metrics.totalCost) &&
    metrics.totalCost >= 0
      ? { metrics: { steps: metrics.steps, totalCost: metrics.totalCost } }
      : {}),
  };
}

function renderBackgroundNotice(notice: BackgroundRunNotice, mode: ConsoleOutputMode): string {
  const runId = safeNoticeText(notice.runId);
  const events = Array.isArray(notice.events)
    ? notice.events.flatMap((event) => {
        const projected = projectBackgroundEvent(event);
        return projected === undefined ? [] : [projected];
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
  const controlPageSize = params.controlPageSize ?? DEFAULT_CONSOLE_CONTROL_PAGE_SIZE;
  const escapeSequenceTimeoutMs =
    params.escapeSequenceTimeoutMs ?? DEFAULT_CONSOLE_ESCAPE_SEQUENCE_TIMEOUT_MS;
  if (!Number.isInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new RangeError("maxInputBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0)
    throw new RangeError("heartbeatMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(controlPageSize) || controlPageSize < 1)
    throw new RangeError("controlPageSize must be a positive safe integer");
  if (!Number.isSafeInteger(escapeSequenceTimeoutMs) || escapeSequenceTimeoutMs < 1)
    throw new RangeError("escapeSequenceTimeoutMs must be a positive safe integer");

  let reason: ConsoleExitReason = "eof";
  let completedTurns = 0;
  let lineBytes: number[] = [];
  let stopped = false;
  let lineQueue = Promise.resolve();
  let queuedPromptCount = 0;
  let exitPromptCount: number | undefined;
  const ttyInput = params.input as TtyReadableStream;
  const rawTty = ttyInput.isTTY === true && typeof ttyInput.setRawMode === "function";
  let rawModeEnabled = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let escapeState: "text" | "escape" | "csi" | "ss3" = "text";
  const interruptForeground = (): void => {
    // This calls the session-scoped abort only; detached runs have their own
    // explicit /cancel control and must survive foreground shutdown.
    void (params.session.interrupt?.() ?? Promise.resolve(false)).catch(() => {
      params.error.write("ad-coder: current turn interrupt failed\n");
    });
  };
  const handleLine = async (rawLine: string, promptNumber?: number): Promise<void> => {
    if (
      stopped &&
      (promptNumber === undefined ||
        exitPromptCount === undefined ||
        promptNumber > exitPromptCount)
    )
      return;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") {
      if (mode === "formatted") params.output.write("ad-coder> ");
      return;
    }
    if (findConsoleCommand(line.trim())?.frontAction === "exit") {
      reason = "exit";
      exitPromptCount = queuedPromptCount;
      stopped = true;
      interruptForeground();
      return;
    }
    try {
      const backgroundRuns = (
        params.session as ConversationSession & {
          backgroundRuns?: BackgroundRunManager;
        }
      ).backgroundRuns;
      const managed = executeConsoleControl(line.trim(), {
        ...(backgroundRuns === undefined ? {} : { backgroundRuns }),
        interrupt: params.session.interrupt ?? (async () => false),
        maxPageSize: controlPageSize,
      });
      if (managed !== undefined) {
        params.output.write(renderControl(await managed, mode, controlPageSize));
        if (mode === "formatted") params.output.write("ad-coder> ");
        return;
      }
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
      if (params.interrupted?.()) {
        params.error.write(
          renderFailure(
            {
              code: "interrupted",
              message: "console turn interrupted",
              action: "restart the console to resume the session",
              retryable: true,
            },
            mode,
          ),
        );
        reason = "interrupted";
      } else if (error instanceof ConsoleControlError) {
        // The guidance is derived from the command registry, so it always names
        // the failed command and one next action (docs/contracts/errors.md).
        params.error.write(renderFailure(error.failure, mode));
        if (mode === "formatted") params.output.write("ad-coder> ");
        return;
      } else if (error instanceof TurnInterruptedError) {
        params.error.write(
          renderFailure(
            {
              code: "interrupted",
              message: "current turn interrupted",
              action: "session remains available; enter the next prompt",
              retryable: true,
            },
            mode,
          ),
        );
        if (mode === "formatted") params.output.write("ad-coder> ");
        return;
      } else if (error instanceof SessionLimitError) {
        params.error.write(
          renderFailure(
            {
              code: "session_limit",
              message: "session resource limit reached",
              action: "restart the console to start a session with a fresh budget",
              // The same session cannot grant more budget to a retry.
              retryable: false,
            },
            mode,
          ),
        );
        reason = "session_limit";
      } else if (error instanceof EmptyTurnError) {
        const recovery =
          params.authenticationCommand === undefined
            ? "verify authentication and retry"
            : `run: ${params.authenticationCommand}`;
        params.error.write(
          renderFailure(
            {
              code: "empty_turn",
              message: "provider returned a failed empty turn",
              action: recovery,
              retryable: true,
            },
            mode,
          ),
        );
        reason = "turn_failed";
      } else {
        params.error.write(
          renderFailure(
            {
              code: "turn_failed",
              message: "console turn failed",
              action: "retry the prompt; if it keeps failing, restart the console",
              retryable: true,
            },
            mode,
          ),
        );
        reason = "turn_failed";
      }
      stopped = true;
    }
  };
  const queueLine = (): void => {
    const line = Buffer.from(lineBytes).toString("utf8");
    lineBytes = [];
    // Controls own no model-turn state, so dispatch them outside the serialized
    // prompt lane. This keeps list/status/cancel and exit available while a turn waits.
    if (line.trim().startsWith("/")) {
      void handleLine(line);
      return;
    }
    const promptNumber = ++queuedPromptCount;
    lineQueue = lineQueue.then(() => handleLine(line, promptNumber));
  };
  const requestEscapeInterrupt = (): void => {
    escapeTimer = undefined;
    escapeState = "text";
    interruptForeground();
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
    if (rawTty) {
      ttyInput.setRawMode?.(true);
      rawModeEnabled = true;
    }
    if (mode === "formatted") {
      params.output.write(
        "ad-coder console — Escape interrupts the current turn; /exit or EOF to close\nad-coder> ",
      );
    }
    for await (const rawChunk of params.input as AsyncIterable<Buffer | string>) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      for (const byte of chunk) {
        if (rawTty && (byte === 0x03 || byte === 0x04)) {
          reason = byte === 0x03 ? "exit" : "eof";
          stopped = true;
          interruptForeground();
          break;
        }
        if (rawTty && escapeState !== "text") {
          if (escapeState === "escape") {
            if (byte === 0x1b) {
              // Keep the original deadline: a key-repeat cannot defer a lone Escape forever.
              continue;
            }
            if (byte === 0x5b) {
              if (escapeTimer !== undefined) clearTimeout(escapeTimer);
              escapeTimer = undefined;
              escapeState = "csi";
              continue;
            }
            if (byte === 0x4f) {
              if (escapeTimer !== undefined) clearTimeout(escapeTimer);
              escapeTimer = undefined;
              escapeState = "ss3";
              continue;
            }
            if (escapeTimer !== undefined) clearTimeout(escapeTimer);
            requestEscapeInterrupt();
          } else if (escapeState === "csi") {
            if (byte >= 0x40 && byte <= 0x7e) escapeState = "text";
            continue;
          } else {
            if (byte >= 0x30 && byte <= 0x7e) escapeState = "text";
            continue;
          }
        }
        if (rawTty && byte === 0x1b) {
          escapeState = "escape";
          escapeTimer = setTimeout(requestEscapeInterrupt, escapeSequenceTimeoutMs);
          continue;
        }
        if (byte === 0x0a || (rawTty && byte === 0x0d)) {
          if (rawTty && mode === "formatted") params.output.write("\n");
          queueLine();
          if (stopped) break;
        } else if (rawTty && (byte === 0x08 || byte === 0x7f)) {
          if (lineBytes.length > 0) {
            let removed = lineBytes.pop() as number;
            while (lineBytes.length > 0 && removed >= 0x80 && removed <= 0xbf)
              removed = lineBytes.pop() as number;
            if (mode === "formatted") params.output.write("\b \b");
          }
        } else {
          if (
            lineBytes.length >= maxInputBytes &&
            !(lineBytes.length === maxInputBytes && byte === 0x0d)
          ) {
            params.error.write(renderFailure(INPUT_TOO_LARGE_FAILURE, mode));
            reason = "input_too_large";
            stopped = true;
            break;
          }
          lineBytes.push(byte);
          if (rawTty && mode === "formatted" && (byte === 0x09 || byte >= 0x20))
            params.output.write(Buffer.from([byte]));
        }
      }
      if (stopped) break;
    }
    if (!stopped && lineBytes.length > 0) queueLine();
    await lineQueue;
  } catch {
    params.error.write(renderFailure(INPUT_FAILED_FAILURE, mode));
    reason = "input_failed";
  } finally {
    if (escapeTimer !== undefined) clearTimeout(escapeTimer);
    unsubscribeBackground?.();
    try {
      await params.session.close();
    } catch {
      params.error.write(renderFailure(CLOSE_FAILED_FAILURE, mode));
      if (isSuccessfulExit(reason)) reason = "close_failed";
    } finally {
      if (rawModeEnabled) ttyInput.setRawMode?.(false);
    }
  }
  return { reason, completedTurns };
}
