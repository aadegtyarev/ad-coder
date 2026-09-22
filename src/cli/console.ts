import { ContextCompactionLostError, describeCompactionFailure } from "../context/compactor";
import {
  ConsoleControlError,
  type ConsoleControlFailure,
  type CostAnomalyControl,
  DEFAULT_CONSOLE_CONTROL_PAGE_SIZE,
  executeConsoleControl,
  findConsoleCommand,
} from "../conversation/console-control";
import type {
  ConversationSession,
  ConversationToolCall,
  ConversationTurnResult,
} from "../conversation/conversation";
import {
  CONVERSATION_REFUSAL_TEXT,
  type ConversationRefusalReason,
  ConversationRefusedError,
  TurnInterruptedError,
} from "../conversation/conversation";
import { CostAnomalyBlockedError } from "../economics/cost-anomaly";
import type { ToolActivityConfig } from "../observability/tool-activity";
import type { BackgroundRunManager, BackgroundRunNotice } from "../orchestration/background-runs";
import {
  EmptyTurnError,
  GenerationTruncatedError,
  ProviderQuotaError,
  ProviderRejectionError,
} from "../runner/errors";
import { SessionLimitError } from "../session-limits";
import { announcePauseOnce, pauseAnnouncementKey } from "./pause-notice";
import { loadTaskFile } from "./task-file";
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
  | "context_compaction_lost"
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
  /**
   * Time shutdown gives an in-flight console control to finish. A control calls
   * out to a manager that can stall -- a host launcher that never spawns, a
   * provider that ignores cancellation -- and shutdown must stay finite anyway,
   * so the wait is bounded rather than unconditional. Zero abandons in-flight
   * controls immediately.
   */
  controlDrainMs?: number;
  /**
   * Total time a transient-refusal retry loop may wait for the active step to
   * settle (issue #452). The budget covers all attempts together; each
   * whenSettled() is awaited only up to the remaining budget. Zero means do
   * not wait: refuse immediately with the typed not-accepted failure.
   */
  settleWaitMs?: number;
  toolActivity?: Partial<ToolActivityConfig>;
  /** Process-local cooperative shutdown probe supplied by the CLI front. */
  interrupted?: () => boolean;
  /** Exact operator command shown after an empty provider turn. */
  authenticationCommand?: string;
  /** Maximum in-turn recovery calls after Escape; default is the contract's 3. */
  maxContinuations?: number;
  /**
   * The project's cost-anomaly detector. The SAME object the run uses, so a
   * block raised mid-turn is liftable by `/cost release` without leaving the
   * console -- rendering differs between fronts, the decision does not
   * (`docs/contracts/cli.md`).
   */
  costAnomaly?: CostAnomalyControl;
}

export interface ConsoleRunResult {
  reason: ConsoleExitReason;
  completedTurns: number;
}

const INPUT_TOO_LARGE_FAILURE = {
  code: "input_too_large",
  message: "input message exceeds the configured byte limit",
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
const CONTROL_DRAIN_TIMEOUT_FAILURE = {
  code: "deadline_exceeded",
  message: "a console control was still running when the console shut down",
  // Shutdown is finite by contract, so the control is abandoned rather than
  // waited on. Whatever it asked the manager to do may or may not have landed,
  // and only the durable record can answer that.
  action: "check for runs the abandoned control may have started with: ad-coder background list",
  retryable: false,
} as const;
const CLOSE_FAILED_FAILURE = {
  code: "close_failed",
  message: "console session close failed",
  action: "check for background runs that outlived the session with: ad-coder background list",
  retryable: false,
} as const;

/**
 * A class name usable inside a single-line record: a plain identifier, bounded.
 * Anything else (empty, non-string, whitespace, punctuation, control characters,
 * a message smuggled into a name) is not a class name and never renders.
 */
const ERROR_CLASS_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * `value instanceof ctor`, total. `instanceof` is not a safe operation on an
 * untrusted value: it walks the prototype chain, so a Proxy (or an accessor on
 * the chain) can THROW instead of answering -- and every `instanceof` in the
 * failure-classification chain below would then throw in turn, replacing the
 * turn's own failure with a bogus one (measured: the escape surfaced as
 * `input_failed`, whose advice is to restart the console because the input
 * stream is gone). A value that refuses the question is not an instance of
 * anything this front knows, which lands it on the untyped fallback -- where it
 * is described safely. Narrowing is preserved, so callers read the typed fields
 * exactly as before.
 */
function probeInstanceOf<T>(
  value: unknown,
  ctor: abstract new (...args: never[]) => T,
): boolean | undefined {
  try {
    return value instanceof ctor;
  } catch {
    // `undefined`, not `false`: "this is not an X" and "this will not say" are
    // different answers, and only the second one needs its own label.
    return undefined;
  }
}

/** Boolean form for the classification chain: a value that will not answer is no match. */
function isInstanceOf<T>(value: unknown, ctor: abstract new (...args: never[]) => T): value is T {
  return probeInstanceOf(value, ctor) === true;
}

/**
 * The failing error's class name as ONE bounded token, for the untyped-failure
 * fallback -- or a fixed label when there is no class to name.
 *
 * No OWN property of the thrown value is consulted, because the name is the only
 * attribution an untyped failure can offer and it must not become a channel for
 * the message the projection deliberately withholds: `constructor` and `name`
 * are ordinary, writable properties, so a crafted error can set either to
 * arbitrary text (and an own `name` is exactly how one would forge another
 * class). The name is therefore read from the PROTOTYPE's constructor, which no
 * own property can spoof, and accepted only as a bounded identifier. An
 * anonymous subclass has an empty `constructor.name` and still IS an Error, so
 * it renders the base label; a thrown value that is not an Error is labelled by
 * `typeof` (`null` named explicitly, since `typeof null` is "object").
 *
 * Every read here can THROW rather than answer -- `instanceof`, the prototype
 * lookup, and the `constructor` access all run through a Proxy trap if the
 * thrown value is one -- and a diagnostic that fails while describing a failure
 * would replace the turn's own failure with its own, so every refusal renders
 * the fixed label `unclassified` instead of propagating. Total by construction:
 * every input yields one token from a closed set (docs/contracts/errors.md).
 */
function describeErrorClass(error: unknown): string {
  const isError = probeInstanceOf(error, Error);
  if (isError === undefined) return "unclassified";
  if (!isError) return `non-error ${error === null ? "null" : typeof error}`;
  try {
    const prototypeName: unknown = Object.getPrototypeOf(error)?.constructor?.name;
    if (typeof prototypeName === "string" && ERROR_CLASS_TOKEN.test(prototypeName))
      return prototypeName;
    return "Error";
  } catch {
    return "unclassified";
  }
}

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
export const DEFAULT_CONSOLE_CONTROL_DRAIN_MS = 2_000;
/**
 * Total wait budget for a transient-refusal retry loop (issue #452).
 * A real wake or pipeline turn runs for minutes; the reported incident's
 * brief sat for ~10 minutes. Fifteen minutes keeps the dispatch patient
 * without threatening the shutdown-finite contract (ui-responsiveness.md:20).
 * Zero means do not wait: refuse immediately with the typed not-accepted
 * failure so a fifo dispatcher retries.
 */
export const DEFAULT_CONSOLE_SETTLE_WAIT_MS = 15 * 60_000;
/** Max attempts in the transient-refusal retry loop, before the settle budget runs out. */
export const DEFAULT_CONSOLE_MAX_RETRY_ATTEMPTS = 10;

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
  else if (result.type === "background_start")
    safe = {
      type: result.type,
      run: { runId: safeNoticeText(result.run.runId), lifecycle: result.run.lifecycle },
    };
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
  else if (result.type === "cost_status")
    safe = {
      type: result.type,
      // Numbers and scope names only -- exactly what the durable block holds.
      blocked: result.blocked.map((scope) => ({
        provider: sanitizeTerminalText(scope.provider),
        model: sanitizeTerminalText(scope.model),
        block: { ...scope.block },
      })),
    };
  else if (result.type === "cost_release")
    safe = {
      type: result.type,
      provider: sanitizeTerminalText(result.provider),
      model: sanitizeTerminalText(result.model),
      released: { ...result.released },
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
  if (result.type === "cost_status")
    return `${
      result.blocked
        .map((scope) => renderCostBlock(scope.provider, scope.model, scope.block))
        .join("\n") || "ad-coder: no model is blocked for billing above its declared price"
    }\n`;
  if (result.type === "cost_release")
    return `ad-coder: accepted ${formatCostRatio(result.released.ratio)} as the price of ${result.provider}/${result.model}; this model runs again\n`;
  if (result.type === "background_start") {
    const run = safe.run as Record<string, unknown>;
    return `ad-coder: background ${run.runId} ${run.lifecycle}\n`;
  }
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

/**
 * A price block as an operator reads it: the two amounts, the overcharge as a
 * percentage, how many responses confirmed it, and the exact console command
 * that accepts the new price. Every number comes from the durable block --
 * scope names and amounts only, never a prompt or a provider body
 * (`docs/contracts/errors.md`).
 */
function renderCostBlock(
  provider: string,
  model: string,
  block: { chargedUsd: number; expectedUsd: number; ratio: number; confirmingObservations: number },
): string {
  const scope = `${sanitizeTerminalText(provider)}/${sanitizeTerminalText(model)}`;
  return (
    `ad-coder: ${scope} is blocked — declared ${formatCostUsd(block.expectedUsd)}, ` +
    `billed ${formatCostUsd(block.chargedUsd)} (${formatCostRatio(block.ratio)}), ` +
    `confirmed by ${block.confirmingObservations} responses; ` +
    `accept the new price with: /cost release ${scope}`
  );
}

/** A single response costs fractions of a cent, so a two-decimal dollar amount reads as "$0.00". */
function formatCostUsd(amount: number): string {
  return `$${amount.toPrecision(3)}`;
}

/** The ratio as the overcharge an operator compares against an invoice: 1.62 reads as "+62%". */
function formatCostRatio(ratio: number): string {
  const percent = (ratio - 1) * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(0)}%`;
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
  "paused",
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

/** A validated background event projected at the console boundary. */
interface ProjectedBackgroundEvent {
  sequence: number;
  runId: string;
  lifecycle: string;
  timestamp: number;
  stage?: string;
  pause?: {
    phase: string;
    code: string;
    action: string;
    limitReason?: string;
    limit?: number;
  };
  errorCode?: string;
  metrics?: { steps: number; totalCost: number };
}

function projectBackgroundEvent(event: unknown): ProjectedBackgroundEvent | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const value = event as {
    lifecycle?: unknown;
    stage?: unknown;
    errorCode?: unknown;
    metrics?: { steps?: unknown; totalCost?: unknown };
    pause?: unknown;
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
  // Pause payloads are the coordinator's own record (issue #261): fixed safe
  // phrases and numbers only, re-validated field by field like every other
  // projected event field -- never trusted sight unseen across the boundary.
  const rawPause = value.pause as
    | {
        phase?: unknown;
        code?: unknown;
        action?: unknown;
        limitReason?: unknown;
        limit?: unknown;
      }
    | undefined;
  const pauseCode = rawPause === undefined ? undefined : safeNoticeText(rawPause.code);
  const pauseAction = rawPause === undefined ? undefined : safeNoticeText(rawPause.action);
  const pause =
    rawPause === undefined || typeof rawPause !== "object" || pauseCode === undefined
      ? undefined
      : {
          phase: safeNoticeText(rawPause.phase),
          code: pauseCode,
          action: pauseAction ?? "unknown",
          ...(typeof rawPause.limitReason === "string"
            ? { limitReason: safeNoticeText(rawPause.limitReason) }
            : {}),
          ...(typeof rawPause.limit === "number" && Number.isFinite(rawPause.limit)
            ? { limit: rawPause.limit }
            : {}),
        };
  return {
    sequence: safeNoticeInteger(value.sequence),
    runId: safeNoticeText(value.runId),
    lifecycle,
    timestamp: safeNoticeInteger(value.timestamp),
    ...(stage === undefined ? {} : { stage }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(pause !== undefined ? { pause } : {}),
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
  const lines = events.flatMap(({ lifecycle, stage, pause }) => {
    if (lifecycle === "paused" && pause !== undefined) {
      const limit =
        pause.limitReason !== undefined
          ? `, limit ${pause.limitReason}${pause.limit === undefined ? "" : ` (${pause.limit})`}`
          : pause.limit === undefined
            ? ""
            : `, limit (${pause.limit})`;
      // The pause line says the phase even when the event carries no stage: the
      // phase is the pause's own identifier, and "what paused" is the first
      // question the operator asks (issue #501).
      const renderedStage = ` (${stage ?? pause.phase})`;
      // ONE announcement per pause occurrence (issue #501): a re-delivered
      // event (gap recovery) and the result path must not print the same pause
      // twice -- a repeated pause reads as a new decision where the operator
      // already made one. The key is composed from the pause's own identifiers,
      // never from its action text, so a re-render never rekeys.
      if (!announcePauseOnce(pauseAnnouncementKey(runId, pause.phase, pause.code))) return [];
      return [
        `ad-coder: background pipeline ${runId} paused${renderedStage}: ${pause.code}${limit} -- ` +
          `${pause.action} -- the run is resumable, not failed`,
      ];
    }
    const renderedStage = stage === undefined ? "" : ` (${stage})`;
    return [`ad-coder: background pipeline ${runId} ${lifecycle}${renderedStage}`];
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
  const controlDrainMs = params.controlDrainMs ?? DEFAULT_CONSOLE_CONTROL_DRAIN_MS;
  const settleWaitMs = params.settleWaitMs ?? DEFAULT_CONSOLE_SETTLE_WAIT_MS;
  const maxContinuations = params.maxContinuations ?? 3;
  if (!Number.isInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new RangeError("maxInputBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0)
    throw new RangeError("heartbeatMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(controlPageSize) || controlPageSize < 1)
    throw new RangeError("controlPageSize must be a positive safe integer");
  if (!Number.isSafeInteger(escapeSequenceTimeoutMs) || escapeSequenceTimeoutMs < 1)
    throw new RangeError("escapeSequenceTimeoutMs must be a positive safe integer");
  if (!Number.isSafeInteger(controlDrainMs) || controlDrainMs < 0)
    throw new RangeError("controlDrainMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(settleWaitMs) || settleWaitMs < 0)
    throw new RangeError("settleWaitMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(maxContinuations) || maxContinuations < 0)
    throw new RangeError("maxContinuations must be a non-negative safe integer");

  let reason: ConsoleExitReason = "eof";
  let completedTurns = 0;
  let lineBytes: number[] = [];
  let stopped = false;
  let lineQueue = Promise.resolve();
  // Controls run outside the prompt lane but stay ordered among themselves:
  // `/start` awaits a host launcher, so an unserialized lane would render a
  // later `/list` before the `/start` that admitted the run it lists.
  let controlQueue = Promise.resolve();
  let queuedPromptCount = 0;
  let exitPromptCount: number | undefined;
  let queuedControlCount = 0;
  let exitControlCount: number | undefined;
  const ttyInput = params.input as TtyReadableStream;
  const rawTty = ttyInput.isTTY === true && typeof ttyInput.setRawMode === "function";
  let rawModeEnabled = false;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let escapeState: "text" | "escape" | "csi" | "ss3" = "text";
  // Bracketed paste (requested with ESC[?2004h) frames a pasted brief, so the
  // newlines the terminal replays inside it join the current message instead
  // of dispatching one turn per pasted line (docs/contracts/cli.md).
  let pasteMode = false;
  let csiParams = "";
  let pendingCr = false;
  const interruptForeground = (): void => {
    // This calls the session-scoped abort only; detached runs have their own
    // explicit /cancel control and must survive foreground shutdown.
    void (params.session.interrupt?.() ?? Promise.resolve(false)).catch(() => {
      params.error.write("ad-coder: current turn interrupt failed\n");
    });
  };
  /**
   * The untyped turn failure: this console's LAST resort, and total by
   * construction -- it reads nothing off the caught value except through
   * `describeErrorClass`, which cannot throw. It is therefore also what answers
   * when the typed branches above are themselves defeated: each of them reads
   * fields off the caught value (`status`, `failure`, `attempts`, `provider`,
   * `block`, `retryAfterMs`), and a value that passes `instanceof` and THEN
   * refuses those reads -- a Proxy whose traps throw -- used to take the failure
   * out of the catch entirely, re-reporting a failed turn as `input_failed` on a
   * console whose input stream was fine.
   */
  const writeUntypedTurnFailure = (error: unknown): void => {
    const cause = describeErrorClass(error);
    params.error.write(
      renderFailure(
        {
          code: "turn_failed",
          message: `console turn failed (${cause})`,
          action: "retry the prompt; if it keeps failing, restart the console",
          retryable: true,
        },
        mode,
      ),
    );
    reason = "turn_failed";
  };
  // Wake callbacks arrive outside the input lane. Serialize their projection
  // with foreground output so a settled wake cannot split a busy line or notice.
  let wakeRenderQueue = Promise.resolve();
  const queueWakeRender = (
    event:
      | { phase: "started"; step: string }
      | { phase: "settled"; result: ConversationTurnResult },
  ): void => {
    if (mode !== "formatted") return;
    wakeRenderQueue = wakeRenderQueue
      .then(() => {
        if (event.phase === "started") {
          params.error.write(`ad-coder: wake turn started (${event.step})\n`);
        } else {
          const result = sanitizeTurn(event.result);
          completedTurns++;
          params.output.write(renderFormatted(result));
          params.output.write("ad-coder> ");
        }
      })
      .catch(() => {
        params.error.write("ad-coder: wake result projection failed\n");
      });
  };
  const handleLine = async (
    rawLine: string,
    lane: { prompt?: number; control?: number; source?: string } = {},
    // An untrusted multi-line message (piped brief, pasted brief, /task file)
    // is PROMPT text: console-command-looking lines inside it must never
    // execute as controls (docs/contracts/cli.md, 2026-09-16).
    forcePrompt = false,
  ): Promise<void> => {
    // A line queued before `/exit` still runs; one queued after it does not.
    // Prompts and controls are counted separately because they drain in two
    // independent lanes.
    if (stopped) {
      const admitted =
        (lane.prompt !== undefined &&
          exitPromptCount !== undefined &&
          lane.prompt <= exitPromptCount) ||
        (lane.control !== undefined &&
          exitControlCount !== undefined &&
          lane.control <= exitControlCount);
      if (!admitted) return;
    }
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") {
      if (mode === "formatted") params.output.write("ad-coder> ");
      return;
    }
    // Declared here so the catch block can access them for retry (issue #452).
    const started = Date.now();
    let lastActivity = started;
    // The renderer that owns this turn's single in-place slot on stderr; the
    // busy heartbeat line draws through it (issue #501) instead of stacking a
    // fresh "still running" line per heartbeat.
    let busyRenderer: ToolActivityRenderer | undefined;
    const progress = (event: "started" | "heartbeat") => {
      const elapsedSeconds = Math.floor((Date.now() - started) / 1000);
      if (mode === "json") {
        params.error.write(
          `${JSON.stringify({ type: "progress", event, stage: "console-turn", elapsedSeconds })}\n`,
        );
        return;
      }
      const prefix = `ad-coder: console turn ${
        event === "started" ? "started" : "still running"
      } (${elapsedSeconds}s)`;
      // The start is a milestone (one per turn); the busy line after it is the
      // stall signal, updated in place by the renderer: same slot as the
      // activity line, subject and spend carried, never a line per heartbeat.
      if (event === "started" || busyRenderer === undefined) params.error.write(`${prefix}\n`);
      else busyRenderer.renderBusyLine(prefix);
    };
    /**
     * Call step(line) with fresh activity monitoring and progress machinery,
     * and clean up regardless of outcome. Returns the raw turn result.
     */
    const runMonitoredStep = async (inputLine: string): Promise<ConversationTurnResult> => {
      const renderer = new ToolActivityRenderer(
        params.error,
        mode === "json" ? "json" : "human",
        params.toolActivity,
      );
      busyRenderer = renderer;
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
      try {
        return await params.session.step(inputLine);
      } finally {
        if (timer !== undefined) clearInterval(timer);
        unsubscribe?.();
        busyRenderer = undefined;
        renderer.close();
      }
    };
    /** Render a successful step's result and increment completedTurns. */
    const renderStepSuccess = (rawResult: ConversationTurnResult): void => {
      const result = sanitizeTurn(rawResult);
      completedTurns++;
      params.output.write(
        mode === "json" ? `${JSON.stringify(result)}\n` : renderFormatted(result),
      );
      if (mode === "formatted") params.output.write("ad-coder> ");
    };
    let rawResult: ConversationTurnResult;
    try {
      const backgroundRuns = (
        params.session as ConversationSession & {
          backgroundRuns?: BackgroundRunManager;
        }
      ).backgroundRuns;
      const managed = forcePrompt
        ? undefined
        : executeConsoleControl(line.trim(), {
            ...(backgroundRuns === undefined ? {} : { backgroundRuns }),
            ...(params.costAnomaly === undefined ? {} : { costAnomaly: params.costAnomaly }),
            interrupt: params.session.interrupt ?? (async () => false),
            maxPageSize: controlPageSize,
          });
      if (managed !== undefined) {
        params.output.write(renderControl(await managed, mode, controlPageSize));
        if (mode === "formatted") params.output.write("ad-coder> ");
        return;
      }
      rawResult = await runMonitoredStep(line);
      renderStepSuccess(rawResult);
    } catch (error) {
      // The typed branches below READ fields off the caught value (`status`,
      // `failure`, `attempts`, `provider`, `block`, `retryAfterMs`), and
      // `instanceof` passing does not make those reads safe: a Proxy around a
      // typed error answers the tag check and then throws on the first field
      // read. Without this guard that throw left the turn's own catch and was
      // reported as `input_failed` -- advice to restart a console whose input
      // stream was fine, on a turn whose real failure was already known.
      try {
        if (params.interrupted?.()) {
          params.error.write(
            renderFailure(
              {
                code: "interrupted",
                message:
                  "console turn interrupted: foreground console turn stopped; bounded continuation checkpoint preserved",
                action:
                  "send the next prompt to resume the preserved work (or give a new direction)",
                retryable: true,
              },
              mode,
            ),
          );
          reason = "interrupted";
        } else if (isInstanceOf(error, ConsoleControlError)) {
          // The guidance is derived from the command registry, so it always names
          // the failed command and one next action (docs/contracts/errors.md).
          params.error.write(renderFailure(error.failure, mode));
          if (mode === "formatted") params.output.write("ad-coder> ");
          return;
        } else if (isInstanceOf(error, TurnInterruptedError)) {
          const checkpoint = error.checkpoint;
          const next = checkpoint?.next ?? "send the next prompt to resume the preserved work";
          const preserved =
            checkpoint === undefined
              ? "a durable continuation checkpoint (state WIP; artifact identity: console_continuation_checkpoint)"
              : `state WIP; artifact ${checkpoint.artifact.type}/${checkpoint.artifact.id}; preserved work: ${checkpoint.work}; next: ${next}`;
          params.error.write(
            renderFailure(
              {
                code: "interrupted",
                message: `current turn interrupted: foreground console turn stopped; ${preserved}`,
                action:
                  checkpoint !== undefined && maxContinuations > 0
                    ? "automatic bounded continuation is starting; if it cannot proceed, send the next prompt to resume the preserved work"
                    : next,
                retryable: true,
              },
              mode,
            ),
          );
          if (checkpoint !== undefined && maxContinuations > 0) {
            // The provider call is allowed to settle before the wake call. This
            // reuses the conversation's durable checkpoint hook and lane-busy
            // guard instead of creating a second scheduler.
            await params.session.whenSettled();
            try {
              rawResult = await runMonitoredStep(
                "Continue the preserved work from the durable checkpoint.",
              );
              renderStepSuccess(rawResult);
            } catch (continuationError) {
              const evidence = `automatic continuation failed after exhaustion/no motion: ${describeErrorClass(continuationError)}`;
              const question =
                "Should the operator retry the preserved work or provide a new direction?";
              const action = "answer this question, then send the next prompt";
              let blocked: Awaited<
                ReturnType<NonNullable<ConversationSession["blockContinuation"]>>
              >;
              try {
                if (params.session.blockContinuation === undefined) {
                  throw new Error("session cannot persist blocked continuation recovery");
                }
                blocked = await params.session.blockContinuation(
                  checkpoint,
                  evidence,
                  question,
                  action,
                );
              } catch (persistenceError) {
                params.error.write(
                  renderFailure(
                    {
                      code: "interrupted",
                      message: `bounded continuation failed and blocked recovery could not be persisted: ${describeErrorClass(persistenceError)}`,
                      action:
                        "preserve the checkpoint and retry the console; operator decision is required",
                      retryable: true,
                    },
                    mode,
                  ),
                );
                if (mode === "json")
                  params.error.write(
                    `${JSON.stringify({ type: "continuation_block_persistence_failed", evidence })}\n`,
                  );
                return;
              }
              params.error.write(
                renderFailure(
                  {
                    code: "interrupted",
                    message: `bounded continuation exhausted; task is blocked (artifact ${blocked.artifact.type}/${blocked.artifact.id}). Decision: ${blocked.decision.question}`,
                    action: blocked.decision.action,
                    retryable: true,
                  },
                  mode,
                ),
              );
              if (mode === "json") {
                params.error.write(
                  `${JSON.stringify({
                    type: "continuation_blocked",
                    state: blocked.state,
                    artifact: blocked.artifact,
                    evidence: blocked.evidence,
                    decision: blocked.decision,
                  })}\n`,
                );
              }
            }
          } else if (mode === "formatted") params.output.write("ad-coder> ");
          return;
        } else if (isInstanceOf(error, SessionLimitError)) {
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
        } else if (isInstanceOf(error, ContextCompactionLostError)) {
          // The session's context can no longer be compacted, so every later turn
          // would fail the same way. That makes this a STOP, and the stop has to
          // name a way out that actually exists: `--resume` reopens this very
          // session from its durable store, and `--summarizer-model` picks a
          // summarizer other than the one that failed. "Retry the prompt" -- what
          // the generic branch used to say -- can never work here, and the session
          // stayed alive and deaf behind it (issue #391).
          params.error.write(
            renderFailure(
              {
                code: "context_compaction_lost",
                message:
                  `context compaction failed ${error.attempts} times; last: ` +
                  `${describeCompactionFailure(error.lastFailure)}` +
                  (error.lastFailure !== undefined
                    ? ` (measured ${error.lastFailure.measuredTokens} tokens against threshold ` +
                      `${error.lastFailure.thresholdTokens}, effective ceiling ${error.effectiveCeiling})`
                    : ` (effective ceiling ${error.effectiveCeiling})`),
                action:
                  "restart the console with --resume to reopen this session, adding " +
                  "--summarizer-model <id> when the summarizer itself is what failed",
                // The same process cannot summarize this context again, and the
                // session's own compaction is what ran out.
                retryable: false,
              },
              mode,
            ),
          );
          reason = "context_compaction_lost";
        } else if (isInstanceOf(error, CostAnomalyBlockedError)) {
          // The operator decides, in this session: the block names both amounts,
          // the overcharge, and the `/cost release` that accepts the new price,
          // and input stays open so they can type it. Collapsing this into the
          // generic turn failure left the console advising a retry that could
          // only fail again (`docs/contracts/errors.md`).
          const scope = `${error.provider}/${error.model}`;
          params.error.write(
            renderFailure(
              {
                code: error.code,
                message:
                  `${scope} billed ${formatCostUsd(error.block.chargedUsd)} against ` +
                  `${formatCostUsd(error.block.expectedUsd)} declared ` +
                  `(${formatCostRatio(error.block.ratio)}, confirmed by ` +
                  `${error.block.confirmingObservations} responses); this model is blocked`,
                action: `accept the new price with: /cost release ${scope} — or route this role to another model`,
                // Retrying the same prompt on a blocked model cannot succeed;
                // the operator has to decide first.
                retryable: false,
              },
              mode,
            ),
          );
          // The session is intact and the block is liftable from this prompt, so
          // the console keeps reading input rather than tearing down.
          if (mode === "formatted") params.output.write("ad-coder> ");
          return;
        } else if (isInstanceOf(error, ProviderQuotaError)) {
          // Quota/rate-limit is retryable but NOT now, and never: the credential
          // is valid, the request shape is fine, only the account is out of
          // quota (#356). The advice names the reset window and points at the
          // plan, never at authentication or the request.
          const reset =
            error.retryAfterMs === undefined
              ? "wait for the provider's reset window"
              : `wait for the reset window (~${Math.ceil(error.retryAfterMs / 1_000)}s)`;
          params.error.write(
            renderFailure(
              {
                code: "provider_quota",
                message:
                  `provider refused the request with HTTP 429 (quota/rate limit exhausted)` +
                  (error.providerCode !== undefined
                    ? ` (provider code ${error.providerCode})`
                    : ""),
                action: `${reset}, or check the plan and usage, then retry`,
                retryable: true,
              },
              mode,
            ),
          );
          reason = "turn_failed";
        } else if (isInstanceOf(error, GenerationTruncatedError)) {
          // A truncated generation is retryable, but NOT with the same budget: the
          // same output cap truncates the same reasoning-heavy turn again (#368).
          // The advice names the budget change; never a blind retry, never a
          // credential, never the request.
          params.error.write(
            renderFailure(
              {
                code: "generation_truncated",
                message:
                  `the generation ended with no answer and no tool call` +
                  (error.stopReason !== undefined ? ` (stopReason ${error.stopReason})` : "") +
                  (error.outputTokens !== undefined
                    ? ` after ${error.outputTokens} output tokens` +
                      (error.reasoningTokens !== undefined
                        ? ` (${error.reasoningTokens} on reasoning)`
                        : "")
                    : ""),
                action: "raise the output budget or bound thinking, then retry",
                retryable: true,
              },
              mode,
            ),
          );
          reason = "turn_failed";
        } else if (isInstanceOf(error, ProviderRejectionError)) {
          // Never offer the authentication command here: the provider answered.
          params.error.write(
            renderFailure(
              {
                code: "provider_rejected",
                message: `provider rejected the request with HTTP ${error.status}`,
                action: "inspect the request this role sends (model id, tool schemas, parameters)",
                retryable: false,
              },
              mode,
            ),
          );
          reason = "turn_failed";
        } else if (isInstanceOf(error, EmptyTurnError)) {
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
        } else if (isInstanceOf(error, ConversationRefusedError)) {
          // A refusal the conversation raised BEFORE any provider call (issue
          // #422). The branch reads only the discriminator, and the rendered
          // text comes from the FIXED map, never from the caught value's own
          // `message` -- `instanceof` passing does not make that read safe
          // (#412), and a forged message must not reach the terminal or the
          // ledger. The read itself sits inside the guard-try like every other
          // typed branch: a value that answers the tag and then throws on the
          // field read defeats this branch into the fallback below, which
          // renders the untyped line and nothing else.
          const refusalReason: ConversationRefusalReason | undefined =
            error.reason === "closed" ||
            error.reason === "step_active" ||
            error.reason === "lane_stopping"
              ? error.reason
              : undefined;
          if (refusalReason === undefined) {
            // Outside the closed set: not falsifiable, not ours to render.
            writeUntypedTurnFailure(error);
          } else if (refusalReason === "step_active" || refusalReason === "lane_stopping") {
            // Transient refusal: the dispatch keeps its place and runs once the
            // active step settles (issue #452). Never hot-loop, never drop.
            // The payload's position in the queue is preserved because
            // `handleLine` is awaited inside `lineQueue.then()` — the next
            // queued prompt cannot start until this one delivers or fails.
            const MAX_RETRY_ATTEMPTS = DEFAULT_CONSOLE_MAX_RETRY_ATTEMPTS;
            // Each whenSettled() is bounded by the remaining settle budget;
            // the budget covers all attempts together so the loop can never
            // outlive it (ui-responsiveness.md:20). Zero means refuse
            // immediately: the typed not-accepted failure names the source.
            const settleDeadline = Date.now() + settleWaitMs;
            for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
              if (settleWaitMs === 0) break;
              const remaining = settleDeadline - Date.now();
              if (remaining <= 0) break;
              // Clear the budget timer as soon as the race settles (the shape
              // drainControls uses): a pending timer would hold the process open.
              let budgetTimer: ReturnType<typeof setTimeout> | undefined;
              await Promise.race([
                params.session.whenSettled(),
                new Promise<void>((r) => {
                  budgetTimer = setTimeout(r, remaining);
                }),
              ]).finally(() => {
                if (budgetTimer !== undefined) clearTimeout(budgetTimer);
              });
              try {
                rawResult = await runMonitoredStep(line);
                renderStepSuccess(rawResult);
                return;
              } catch (retryError) {
                if (isInstanceOf(retryError, ConversationRefusedError)) {
                  if (retryError.reason === "closed") {
                    // The session closed while we were waiting.
                    params.error.write(
                      renderFailure(
                        {
                          code: "turn_refused",
                          message: CONVERSATION_REFUSAL_TEXT.closed,
                          action: "restart the console",
                          retryable: false,
                        },
                        mode,
                      ),
                    );
                    reason = "turn_failed";
                    return;
                  }
                  // Still transient: continue the retry loop.
                  continue;
                }
                // Any other error from the retry re-throws to the outer catch,
                // where the typed branches handle it normally.
                throw retryError;
              }
            }
            // Exhausted retries: the payload could not be delivered. A typed
            // failure names the source so a fifo dispatcher can retry it.
            const sourceLabel =
              lane.source !== undefined ? `task from ${lane.source}` : "the queued line";
            params.error.write(
              renderFailure(
                {
                  code: "turn_refused",
                  message: `${sourceLabel} was not accepted`,
                  action:
                    lane.source !== undefined
                      ? "the conversation did not settle in time; the task was not delivered — retry from the source"
                      : "the conversation did not settle in time; retry the prompt",
                  retryable: true,
                },
                mode,
              ),
            );
            if (mode === "formatted") params.output.write("ad-coder> ");
            return;
          } else {
            // Closed (the only remaining reason in the closed set).
            params.error.write(
              renderFailure(
                {
                  code: "turn_refused",
                  message: CONVERSATION_REFUSAL_TEXT[refusalReason],
                  action: "restart the console",
                  retryable: false,
                },
                mode,
              ),
            );
            reason = "turn_failed";
          }
        } else {
          writeUntypedTurnFailure(error);
        }
      } catch {
        // A typed branch was defeated by its own input. Every branch computes
        // its whole line BEFORE writing it, so nothing has been rendered yet
        // and this replacement is the turn's single failure record -- the real
        // failure, named as far as the value allows, rather than the
        // classifier's own.
        writeUntypedTurnFailure(error);
      }
      stopped = true;
    }
  };
  /**
   * Wait for in-flight controls, but never longer than `controlDrainMs`. A
   * control awaits a manager that can stall indefinitely -- a host launcher that
   * never spawns, a provider that ignores cancellation -- and shutdown must stay
   * finite regardless, or `/exit` and Ctrl-C leave the session unclosed and the
   * terminal in raw mode (docs/contracts/ui-responsiveness.md). Zero abandons an
   * in-flight control immediately.
   */
  const drainControls = async (): Promise<void> => {
    // Zero still resolves for an already-settled lane: a settled promise wins the
    // race in a microtask, ahead of any timer. So zero abandons work in flight
    // without penalising a console that simply had none.
    const drained = await Promise.race([
      controlQueue.then(() => true),
      new Promise<false>((resolve) => {
        const timer = setTimeout(() => resolve(false), controlDrainMs);
        void controlQueue.then(() => clearTimeout(timer));
      }),
    ]);
    // Abandoning work silently would read as a clean shutdown; say so instead.
    if (!drained) params.error.write(renderFailure(CONTROL_DRAIN_TIMEOUT_FAILURE, mode));
  };

  /**
   * Read the task file and dispatch its content as ONE prompt. The path is
   * verbatim from the registry, so it may contain spaces. Loading happens at
   * the task-file boundary (./task-file): it stats BEFORE reading, so an
   * over-ceiling file is refused without a read, and it keeps the errno
   * class, so a missing file and a denied root are different failures with
   * different advice (issue #247). The dispatch stays synchronous because the
   * operator's line was just read and the stat has already bounded the read
   * to `maxInputBytes` -- the task's position in the prompt queue is exactly
   * where it was typed.
   */
  const dispatchTaskFailure = (failure: ConsoleControlFailure): void => {
    params.error.write(renderFailure(failure, mode));
    if (mode === "formatted") params.output.write("ad-coder> ");
  };
  const dispatchTask = (line: string): void => {
    const taskPath = line.slice("/task".length).trim();
    if (taskPath === "") {
      dispatchTaskFailure({
        code: "invalid_command",
        command: "/task",
        message: "/task requires a task file path",
        action: "use: /task <path> (example: /task ../briefs/fix-the-editor.txt)",
        // A different, valid path can succeed.
        retryable: true,
      });
      return;
    }
    const load = loadTaskFile(taskPath, maxInputBytes);
    if (!load.ok) {
      dispatchTaskFailure({ command: "/task", ...load });
      return;
    }
    // The informational note every other front-side action carries: the
    // operator must be able to tell that a whole file, not one line, was sent.
    if (mode === "formatted")
      params.output.write(
        sanitizeTerminalText(`ad-coder: dispatching task read from ${taskPath}\n`),
      );
    // Normalise line endings and strip the file's trailing newline terminator:
    // a /task file is ONE message whose interior newlines arrive exactly as
    // written.
    queueLine(load.text.replace(/\r\n?/g, "\n").replace(/\n+$/, ""), true, taskPath);
  };
  /**
   * Queue one dispatchable unit of input. `forcePrompt` marks content that is
   * a message by construction — a pasted brief or a /task file — so even a
   * leading slashes line inside it reaches the model as prompt text.
   *
   * `source` is the original path for a `/task` dispatch so a dropped payload
   * can name the file the dispatcher must re-read (issue #452).
   */
  const queueLine = (line: string, forcePrompt = false, source?: string): void => {
    if (line.trim() === "") {
      if (mode === "formatted") params.output.write("ad-coder> ");
      return;
    }
    // A message with an interior newline is a whole brief by construction:
    // command-looking lines inside it are prompt text, never controls.
    if (!forcePrompt && line.includes("\n")) forcePrompt = true;
    if (line.trim().startsWith("/")) {
      // Only the command token selects in the registry; the argument is
      // verbatim below.
      const command = forcePrompt
        ? undefined
        : findConsoleCommand(line.trim().split(/\s+/)[0] as string);
      if (command?.frontAction === "task") {
        dispatchTask(line.trim());
        return;
      }
      // Exit takes effect when it is READ, not when the control lane reaches
      // it: the counts it freezes are what separates already-queued work from
      // input typed after the operator asked to leave.
      if (command?.frontAction === "exit") {
        reason = "exit";
        exitPromptCount = queuedPromptCount;
        exitControlCount = queuedControlCount;
        stopped = true;
        interruptForeground();
        return;
      }
      if (forcePrompt) {
        // Fall through: the whole message is one prompt.
      } else {
        // Controls own no model-turn state, so dispatch them outside the
        // serialized prompt lane. This keeps list/status/cancel and exit
        // available while a turn waits.
        const controlNumber = ++queuedControlCount;
        controlQueue = controlQueue.then(() => handleLine(line, { control: controlNumber }));
        return;
      }
    }
    const promptNumber = ++queuedPromptCount;
    lineQueue = lineQueue.then(() =>
      handleLine(
        line,
        { prompt: promptNumber, ...(source !== undefined && { source }) },
        forcePrompt,
      ),
    );
  };
  /**
   * EOF is the only message boundary for non-tty stdin: a piped brief is ONE
   * message (docs/contracts/cli.md, 2026-09-16). The accumulated buffer, with
   * its trailing newline terminator stripped, is queued as one dispatch — as a
   * prompt whenever it has an interior newline, so a brief's command-looking
   * lines do not execute as controls. A tty leaving bytes mid-line (paste
   * without a closing newline) dispatches by the same rule.
   */
  const queueBufferedMessage = (): void => {
    if (lineBytes.length === 0) return;
    let end = lineBytes.length;
    while (end > 0 && (lineBytes[end - 1] === 0x0a || lineBytes[end - 1] === 0x0d)) end--;
    lineBytes.length = end;
    if (lineBytes.length === 0) return;
    const text = Buffer.from(lineBytes).toString("utf8").replace(/\r\n?/g, "\n");
    lineBytes = [];
    if (text.trim() === "") {
      if (mode === "formatted") params.output.write("ad-coder> ");
      return;
    }
    if (Buffer.byteLength(text, "utf8") > maxInputBytes) {
      params.error.write(renderFailure(INPUT_TOO_LARGE_FAILURE, mode));
      reason = "input_too_large";
      stopped = true;
      return;
    }
    queueLine(text, text.trim().includes("\n"));
  };
  const requestEscapeInterrupt = (): void => {
    escapeTimer = undefined;
    escapeState = "text";
    interruptForeground();
  };

  let unsubscribeBackground: (() => void) | undefined;
  let unsubscribeWakeTurns: (() => void) | undefined;
  try {
    unsubscribeWakeTurns = params.session.subscribeWakeTurns?.(queueWakeRender);
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
      // Request bracketed paste so a pasted brief arrives framed between
      // ESC[200~ and ESC[201~ instead of as one newline per line. Formatted
      // mode only: a machine JSON front must keep its stdout free of terminal
      // control sequences — there /task is the way to send a whole brief.
      if (mode === "formatted") params.output.write("\u001b[?2004h");
    }
    if (mode === "formatted") {
      params.output.write(
        "ad-coder console — Escape interrupts the current turn; a newline ends the line.\nad-coder" +
          ": bracketed paste or /task <path> sends a whole brief as one turn; /exit or EOF to close\nad-coder> ",
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
              csiParams = "";
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
            if (byte >= 0x40 && byte <= 0x7e) {
              // In a csi, only an exact `200~` or `201~` is a paste frame; a
              // lone deadline is already cleared when csi was entered, so the
              // paste brackets cannot fire the escape interrupt.
              if (byte === 0x7e && csiParams === "200") pasteMode = true;
              if (byte === 0x7e && csiParams === "201") pasteMode = false;
              escapeState = "text";
            } else {
              csiParams += String.fromCharCode(byte);
            }
            continue;
          } else {
            if (byte >= 0x30 && byte <= 0x7e) escapeState = "text";
            continue;
          }
        }
        if (rawTty && byte === 0x1b) {
          escapeState = "escape";
          csiParams = "";
          escapeTimer = setTimeout(requestEscapeInterrupt, escapeSequenceTimeoutMs);
          continue;
        }
        if (rawTty && pasteMode) {
          // Inside a pasted brief the terminator characters are message text:
          // a pasted paragraph is ONE message, not one turn per line.
          if (byte === 0x0d) {
            pendingCr = true;
            lineBytes.push(0x0a);
            if (rawTty && mode === "formatted") params.output.write("\n");
            continue;
          }
          if (byte === 0x0a) {
            if (pendingCr) {
              pendingCr = false;
              continue;
            }
            lineBytes.push(byte);
            if (rawTty && mode === "formatted") params.output.write("\n");
            continue;
          }
          pendingCr = false;
          // A paste never dispatches lines, so the message ceiling is applied
          // to the accumulated message rather than to one pasted line.
          if (lineBytes.length >= maxInputBytes) {
            params.error.write(renderFailure(INPUT_TOO_LARGE_FAILURE, mode));
            reason = "input_too_large";
            stopped = true;
            break;
          }
        }
        if (rawTty) {
          // TTY: enter or return dispatches the current line; a paragraph is
          // assembled before this point when inside a bracketed paste.
          if (byte === 0x0a || byte === 0x0d) {
            if (mode === "formatted") params.output.write("\n");
            queueLine(Buffer.from(lineBytes).toString("utf8"));
            lineBytes = [];
            if (stopped) break;
          } else if (byte === 0x08 || byte === 0x7f) {
            if (lineBytes.length > 0) {
              let removed = lineBytes.pop() as number;
              while (lineBytes.length > 0 && removed >= 0x80 && removed <= 0xbf)
                removed = lineBytes.pop() as number;
              if (mode === "formatted") params.output.write("\b \b");
            }
          } else {
            if (lineBytes.length >= maxInputBytes) {
              params.error.write(renderFailure(INPUT_TOO_LARGE_FAILURE, mode));
              reason = "input_too_large";
              stopped = true;
              break;
            }
            lineBytes.push(byte);
            if (mode === "formatted" && (byte === 0x09 || byte >= 0x20))
              params.output.write(Buffer.from([byte]));
          }
          continue;
        }
        // Non-tty: no terminator dispatch at all — the pipe ends when it ends,
        // and queueBufferedMessage dispatches the whole brief once.
        if (
          lineBytes.length >= maxInputBytes &&
          !(lineBytes.length === maxInputBytes && (byte === 0x0a || byte === 0x0d))
        ) {
          params.error.write(renderFailure(INPUT_TOO_LARGE_FAILURE, mode));
          reason = "input_too_large";
          stopped = true;
          break;
        }
        lineBytes.push(byte);
      }
      if (stopped) break;
    }
    if (!stopped) queueBufferedMessage();
    await drainControls();
    await lineQueue;
  } catch {
    params.error.write(renderFailure(INPUT_FAILED_FAILURE, mode));
    reason = "input_failed";
  } finally {
    if (escapeTimer !== undefined) clearTimeout(escapeTimer);
    unsubscribeWakeTurns?.();
    unsubscribeBackground?.();
    await wakeRenderQueue;
    try {
      await params.session.close();
    } catch {
      params.error.write(renderFailure(CLOSE_FAILED_FAILURE, mode));
      if (isSuccessfulExit(reason)) reason = "close_failed";
    } finally {
      if (rawModeEnabled) {
        // Leave the terminal mode exactly as it was found: paste framing off
        // (in formatted mode, which is the only mode that turned it on), raw
        // off, on every exit path (docs/contracts/ui-responsiveness.md).
        if (mode === "formatted") params.output.write("\u001b[?2004l");
        ttyInput.setRawMode?.(false);
      }
    }
  }
  return { reason, completedTurns };
}
