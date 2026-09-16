import * as crypto from "node:crypto";
import type { Events } from "@earendil-works/pi-agent-core";

export type ToolActivityLifecycle =
  | "requested"
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";
export type ToolActivityKind =
  | "Read"
  | "Search"
  | "Edit"
  | "Run"
  | "Web"
  | "Inspect image"
  | "Tool";

/**
 * What a tool is acting ON, so an operator can see a role going the wrong way
 * before it gets there.
 *
 * WHAT IS PROJECTED: the path being read or written, the command being run, the
 * URL being fetched, the query being searched -- bounded in length, never
 * dropped for containing a word like "token". A file named `src/auth/token.ts`
 * is not a secret to the person whose repository it is, and anyone able to start
 * ad-coder can already read every file on the machine. The previous rule
 * replaced such values with "unknown", which protected nothing and hid the one
 * thing worth watching.
 *
 * WHAT IS NOT: the CONTENT a tool returns -- file bodies, command output,
 * response bodies. That is where an unrequested secret actually surfaces (an
 * environment value echoed by a script, a key inside a config the operator never
 * opened), and the operator asked to see what is being done, not everything it
 * produced.
 */
export interface ToolActivityProjection {
  /** Target-relative path for a read or write. */
  path?: string;
  /** The command line for a shell tool, bounded. */
  command?: string;
  /** The URL for a web tool, bounded. */
  url?: string;
  /** The search pattern or query, bounded. */
  query?: string;
  /** For an edit: lines added and removed, so a runaway rewrite is visible as it happens. */
  linesAdded?: number;
  linesRemoved?: number;
  /**
   * For a read: the window requested, as `offset` and `limit`.
   *
   * Reading in slices and swallowing a whole file are different behaviours with
   * different costs, and the difference is invisible without this.
   */
  readOffset?: number;
  readLimit?: number;
}

/** Numeric-only remaining stage capacity attached after a tool reaches a terminal state. */
export interface ToolActivityBudget {
  durationMs?: number;
  modelTurns?: number;
  toolTurns?: number;
  inputTokens?: number;
  costUsd?: number;
  toolTurnsBeforeCloseout?: number;
}

export interface ToolActivityEvent {
  schemaVersion: 1;
  type: "tool_activity";
  sequence: number;
  timestamp: string;
  lifecycle: ToolActivityLifecycle;
  activity: ToolActivityKind;
  role: string;
  /**
   * The model serving that role, so a routing decision is visible while it runs
   * rather than inferred from a banner printed minutes earlier.
   */
  model?: string;
  runId: string;
  operationId: string;
  turnId: string;
  toolCallId: string;
  parentOperation: string;
  toolName: string;
  droppedCount: number;
  projection?: ToolActivityProjection;
  durationMs?: number;
  budget?: ToolActivityBudget;
}

export interface ToolActivityDropNotice {
  schemaVersion: 1;
  type: "tool_activity_drop";
  sequence: number;
  timestamp: string;
  dropped: number;
  droppedCount: number;
}

export type ToolActivityRecord = ToolActivityEvent | ToolActivityDropNotice;
export type ToolActivityConsumer = (record: ToolActivityRecord) => void | Promise<void>;
export type ToolActivityErrorCode = "closed";

export class ToolActivityError extends Error {
  readonly code: ToolActivityErrorCode;

  constructor(code: ToolActivityErrorCode) {
    super(`tool activity channel ${code}`);
    this.name = "ToolActivityError";
    this.code = code;
  }
}

export interface ToolActivityConfig {
  replayCapacity: number;
  subscriberPendingCapacity: number;
  projectionBytes: number;
  maxEventBytes: number;
  maxStringBytes: number;
  closeDrainMs: number;
  groupingRefreshMs: number;
  humanGroupCount: number;
  renderedLineBytes: number;
  renderQueueCount: number;
  renderQueueBytes: number;
}

export const DEFAULT_TOOL_ACTIVITY_CONFIG: Readonly<ToolActivityConfig> = Object.freeze({
  replayCapacity: 32,
  subscriberPendingCapacity: 16,
  projectionBytes: 160,
  maxEventBytes: 2048,
  maxStringBytes: 160,
  closeDrainMs: 250,
  groupingRefreshMs: 100,
  humanGroupCount: 12,
  renderedLineBytes: 4096,
  renderQueueCount: 32,
  renderQueueBytes: 16_384,
});

const CONFIG_MAX: Readonly<ToolActivityConfig> = Object.freeze({
  replayCapacity: 4096,
  subscriberPendingCapacity: 4096,
  projectionBytes: 4096,
  maxEventBytes: 16_384,
  maxStringBytes: 1024,
  closeDrainMs: 5000,
  groupingRefreshMs: 60_000,
  humanGroupCount: 512,
  renderedLineBytes: 16_384,
  renderQueueCount: 4096,
  renderQueueBytes: 4_194_304,
});

export function resolveToolActivityConfig(
  input: Partial<ToolActivityConfig> = {},
): ToolActivityConfig {
  const result = { ...DEFAULT_TOOL_ACTIVITY_CONFIG, ...input };
  const zeroAllowed = new Set<keyof ToolActivityConfig>([
    "replayCapacity",
    "closeDrainMs",
    "groupingRefreshMs",
  ]);
  for (const key of Object.keys(result) as (keyof ToolActivityConfig)[]) {
    const value = result[key];
    if (
      !Number.isSafeInteger(value) ||
      value < (zeroAllowed.has(key) ? 0 : 1) ||
      value > CONFIG_MAX[key]
    ) {
      throw new RangeError(`${key} is outside its safe configured range`);
    }
  }
  if (
    result.maxEventBytes < 512 ||
    result.renderedLineBytes < 128 ||
    result.renderedLineBytes <= result.maxEventBytes
  )
    throw new RangeError(
      "tool activity output ceilings are too small for stable newline-framed records",
    );
  return result;
}

/** UTF-8-safe bounding: never cuts a code point or emits invalid Unicode. */
export function boundToolActivityText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return "";
  let output = "";
  let bytes = 0;
  let inspectedCodeUnits = 0;
  const inspectionLimit = maxBytes * 8;
  for (const character of value) {
    inspectedCodeUnits += character.length;
    if (inspectedCodeUnits > inspectionLimit) break;
    const point = character.codePointAt(0) ?? 0;
    if (
      point < 0x20 ||
      point === 0x7f ||
      point === 0x9b ||
      (point >= 0xd800 && point <= 0xdfff) ||
      /\p{Cf}/u.test(character)
    )
      continue;
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    output += character;
    bytes += characterBytes;
  }
  return output;
}

const KNOWN_TOOLS: Readonly<Record<string, { activity: ToolActivityKind; publicName: string }>> = {
  read: { activity: "Read", publicName: "read" },
  write: { activity: "Edit", publicName: "write" },
  edit: { activity: "Edit", publicName: "edit" },
  bash: { activity: "Run", publicName: "bash" },
  explore_project: { activity: "Search", publicName: "explore_project" },
  search_project: { activity: "Search", publicName: "search_project" },
  read_project: { activity: "Read", publicName: "read_project" },
  web_search: { activity: "Web", publicName: "web_search" },
  web_read: { activity: "Web", publicName: "web_read" },
  inspect_image: { activity: "Inspect image", publicName: "inspect_image" },
  // The orchestration tools. Without these a `submit_plan` rejection loop reads
  // as an anonymous "Activity: Tool -- failed 0ms", which is how four identical
  // failures hid in plain sight on 2026-09-16 until someone opened the ledger.
  run_role: { activity: "Tool", publicName: "run_role" },
  run_pipeline: { activity: "Tool", publicName: "run_pipeline" },
  start_pipeline: { activity: "Tool", publicName: "start_pipeline" },
  resume_pipeline: { activity: "Tool", publicName: "resume_pipeline" },
  cancel_pipeline: { activity: "Tool", publicName: "cancel_pipeline" },
  pipeline_status: { activity: "Tool", publicName: "pipeline_status" },
  pipeline_events: { activity: "Tool", publicName: "pipeline_events" },
  pipeline_result: { activity: "Tool", publicName: "pipeline_result" },
  decompose_task: { activity: "Tool", publicName: "decompose_task" },
  run_step: { activity: "Tool", publicName: "run_step" },
  choose_transition: { activity: "Tool", publicName: "choose_transition" },
  show_cost: { activity: "Tool", publicName: "show_cost" },
  submit_plan: { activity: "Tool", publicName: "submit_plan" },
  submit_verdict: { activity: "Tool", publicName: "submit_verdict" },
  submit_follow_up: { activity: "Tool", publicName: "submit_follow_up" },
  // The durable-run control surface. Same reasoning: a bare "Tool" in the
  // console tells the operator nothing about what the orchestrator just did.
  control_start: { activity: "Tool", publicName: "control_start" },
  control_status: { activity: "Tool", publicName: "control_status" },
  control_events: { activity: "Tool", publicName: "control_events" },
  control_report: { activity: "Tool", publicName: "control_report" },
  control_resume: { activity: "Tool", publicName: "control_resume" },
  control_cancel: { activity: "Tool", publicName: "control_cancel" },
  control_list: { activity: "Tool", publicName: "control_list" },
  control_publish: { activity: "Tool", publicName: "control_publish" },
  control_triage: { activity: "Tool", publicName: "control_triage" },
  control_decisions: { activity: "Tool", publicName: "control_decisions" },
  control_decision_request: { activity: "Tool", publicName: "control_decision_request" },
  control_run_until: { activity: "Tool", publicName: "control_run_until" },
};

/**
 * Redacts VALUES that look like credentials while leaving the shape readable.
 *
 * `echo API_KEY=ultra-secret` becomes `echo API_KEY=***`, and a bearer token
 * becomes `Authorization: Bearer ***`. The operator asked to see which commands
 * run -- and this still shows that -- but a command line is the one projected
 * field that can carry a literal secret inline, and this output lands in
 * terminal scrollback that gets screenshotted and pasted. Names stay, values go.
 */
function redactInlineSecrets(value: string): string {
  return value
    .replace(
      /((?:api[_-]?key|token|secret|password|passwd|auth)\s*[:=]\s*)(\S+)/giu,
      (_match, name: string) => `${name}***`,
    )
    .replace(/(bearer\s+)(\S+)/giu, (_match, name: string) => `${name}***`);
}

function boundProjection(
  projection: ToolActivityProjection,
  maxBytes: number,
): ToolActivityProjection {
  const bound = (value: string | undefined) =>
    value === undefined ? undefined : boundToolActivityText(value, maxBytes);
  const out: ToolActivityProjection = {};
  const path = bound(projection.path);
  if (path) out.path = path;
  const command = bound(projection.command);
  if (command) out.command = redactInlineSecrets(command);
  const url = bound(projection.url);
  if (url) out.url = redactInlineSecrets(url);
  const query = bound(projection.query);
  if (query) out.query = redactInlineSecrets(query);
  const added = projection.linesAdded;
  if (added !== undefined && Number.isSafeInteger(added)) out.linesAdded = added;
  const removed = projection.linesRemoved;
  if (removed !== undefined && Number.isSafeInteger(removed)) out.linesRemoved = removed;
  const offset = projection.readOffset;
  if (offset !== undefined && Number.isSafeInteger(offset)) out.readOffset = offset;
  const limit = projection.readLimit;
  if (limit !== undefined && Number.isSafeInteger(limit)) out.readLimit = limit;
  return out;
}

function classifyTool(name: string): { activity: ToolActivityKind; publicName: string } {
  return KNOWN_TOOLS[name] ?? { activity: "Tool", publicName: "custom" };
}

/** Argument keys each tool family carries its subject in, in order of preference. */
const SUBJECT_KEYS: Readonly<Record<string, readonly string[]>> = {
  path: ["path", "file", "filePath", "file_path", "target"],
  command: ["command", "cmd", "script"],
  url: ["url", "href"],
  query: ["query", "pattern", "q", "search"],
};

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function countLines(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.split("\n").length;
}

/**
 * Reads a tool's arguments into the subject the operator wants to watch.
 *
 * Only the SUBJECT is taken -- which file, which command, which URL, how many
 * lines an edit moves. The content a tool returns is never read here; see
 * `ToolActivityProjection`.
 */
export function projectToolArguments(
  toolName: string,
  args: unknown,
  maxBytes: number,
): ToolActivityProjection | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const bound = (value: string | undefined) =>
    value === undefined ? undefined : boundToolActivityText(value, maxBytes);
  const projection: ToolActivityProjection = {};
  const path = bound(pickString(record, SUBJECT_KEYS.path ?? []));
  if (path !== undefined && path !== "") projection.path = path;
  const command = bound(pickString(record, SUBJECT_KEYS.command ?? []));
  if (command !== undefined && command !== "") projection.command = command;
  const url = bound(pickString(record, SUBJECT_KEYS.url ?? []));
  if (url !== undefined && url !== "") projection.url = url;
  const query = bound(pickString(record, SUBJECT_KEYS.query ?? []));
  if (query !== undefined && query !== "") projection.query = query;
  // An edit's size, not its text: a rewrite ballooning from three lines to three
  // hundred is exactly what the operator is watching for.
  if (toolName === "read" || toolName === "read_project") {
    const offset = record.offset;
    const limit = record.limit;
    if (typeof offset === "number" && Number.isSafeInteger(offset)) projection.readOffset = offset;
    if (typeof limit === "number" && Number.isSafeInteger(limit)) projection.readLimit = limit;
  }
  if (toolName === "edit" || toolName === "write") {
    const added = countLines(record.new_string ?? record.newString ?? record.content);
    const removed = countLines(record.old_string ?? record.oldString);
    if (added !== undefined) projection.linesAdded = added;
    if (removed !== undefined) projection.linesRemoved = removed;
  }
  return Object.keys(projection).length === 0 ? undefined : projection;
}

const SENSITIVE_TEXT =
  /(secret|token|credential|password|passwd|api[_-]?key|private[_-]?key|\.env)/iu;
const TOOL_ACTIVITY_LIFECYCLES = new Set<ToolActivityLifecycle>([
  "requested",
  "started",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const TOOL_ACTIVITY_KINDS = new Set<ToolActivityKind>([
  "Read",
  "Search",
  "Edit",
  "Run",
  "Web",
  "Inspect image",
  "Tool",
]);

const trustedOutcomes = new WeakMap<object, "timed_out" | "cancelled" | "failed">();

/** First-party wrappers can retain a safe terminal classification without exposing it in tool details. */
export function markTrustedToolOutcome<T extends object>(
  details: T,
  outcome: "timed_out" | "cancelled" | "failed",
): T {
  trustedOutcomes.set(details, outcome);
  return details;
}

export interface ToolActivitySnapshot {
  droppedCount: number;
  retained: readonly ToolActivityRecord[];
  closed: boolean;
}

interface SubscriberState {
  consumer: ToolActivityConsumer;
  pending: number;
  dropped: number;
  active: boolean;
  promises: Set<Promise<void>>;
}

export class ToolActivityChannel {
  readonly config: ToolActivityConfig;
  private sequence = 0;
  private dropped = 0;
  private closed = false;
  private readonly retained: ToolActivityRecord[] = [];
  private readonly subscribers = new Set<SubscriberState>();
  private readonly correlationIds = new Map<string, string>();
  private nextCorrelationId = 0;

  constructor(config: Partial<ToolActivityConfig> = {}) {
    this.config = resolveToolActivityConfig(config);
  }

  get droppedCount(): number {
    return this.dropped;
  }

  subscribe(consumer: ToolActivityConsumer, options: { replay?: boolean } = {}): () => void {
    if (this.closed) throw new ToolActivityError("closed");
    const state: SubscriberState = {
      consumer,
      pending: 0,
      dropped: 0,
      active: true,
      promises: new Set(),
    };
    this.subscribers.add(state);
    if (options.replay) for (const record of this.retained) this.deliver(state, record);
    return () => {
      state.active = false;
      this.subscribers.delete(state);
    };
  }

  publish(
    record: Omit<
      ToolActivityEvent,
      "schemaVersion" | "type" | "sequence" | "timestamp" | "droppedCount"
    >,
  ): void {
    if (this.closed) return;
    if (!TOOL_ACTIVITY_LIFECYCLES.has(record.lifecycle))
      throw new TypeError("invalid tool activity lifecycle");
    if (!TOOL_ACTIVITY_KINDS.has(record.activity))
      throw new TypeError("invalid semantic tool activity");
    const safeIdentifier = (value: string) => {
      const bounded = boundToolActivityText(value, this.config.maxStringBytes);
      return bounded === "" || SENSITIVE_TEXT.test(bounded) || bounded.includes("://")
        ? "unknown"
        : bounded;
    };
    const opaqueIdentifier = (kind: string, value: string) => {
      const digest = crypto.createHash("sha256").update(value).digest("base64url");
      const key = `${kind}:${digest}`;
      const existing = this.correlationIds.get(key);
      if (existing !== undefined) return existing;
      const identifier = `${kind}-${++this.nextCorrelationId}`;
      this.correlationIds.set(key, identifier);
      return identifier;
    };
    const publicToolName = Object.values(KNOWN_TOOLS).some(
      ({ publicName }) => publicName === record.toolName,
    )
      ? record.toolName
      : "custom";
    const event: ToolActivityEvent = {
      schemaVersion: 1,
      type: "tool_activity",
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      lifecycle: record.lifecycle,
      activity: record.activity,
      role: safeIdentifier(record.role),
      runId: opaqueIdentifier("run", record.runId),
      operationId: opaqueIdentifier("operation", record.operationId),
      turnId: opaqueIdentifier("turn", record.turnId),
      toolCallId: opaqueIdentifier("call", record.toolCallId),
      parentOperation: safeIdentifier(record.parentOperation),
      toolName: publicToolName,
      droppedCount: this.dropped,
      ...(record.durationMs !== undefined &&
        Number.isFinite(record.durationMs) &&
        record.durationMs >= 0 &&
        record.durationMs <= CONFIG_MAX.closeDrainMs * 1_000_000 && {
          durationMs: Math.round(record.durationMs),
        }),
      ...(record.budget !== undefined && { budget: record.budget }),
      // The subject, bounded but NOT redacted: a path or command is what the
      // operator is watching for, and anyone who can start ad-coder can already
      // read every file on this machine. Content a tool RETURNS is still never
      // projected -- see `ToolActivityProjection`.
      ...(record.projection !== undefined && {
        projection: boundProjection(record.projection, this.config.projectionBytes),
      }),
      ...(record.model !== undefined && {
        model: boundToolActivityText(record.model, this.config.maxStringBytes),
      }),
    };
    if (!this.fits(event)) {
      this.noteDrop(1);
      return;
    }
    this.retain(event);
    for (const subscriber of this.subscribers) this.deliver(subscriber, event);
  }

  snapshot(): ToolActivitySnapshot {
    return {
      droppedCount: this.dropped,
      retained: structuredClone(this.retained),
      closed: this.closed,
    };
  }

  async close(): Promise<ToolActivitySnapshot> {
    if (this.closed) return this.snapshot();
    this.closed = true;
    const outstanding = [...this.subscribers].flatMap((subscriber) => [...subscriber.promises]);
    if (outstanding.length > 0 && this.config.closeDrainMs > 0) {
      await Promise.race([
        Promise.allSettled(outstanding),
        new Promise<void>((resolve) => setTimeout(resolve, this.config.closeDrainMs)),
      ]);
    }
    for (const subscriber of this.subscribers) {
      if (subscriber.pending > 0) {
        subscriber.dropped += subscriber.pending;
        this.noteDrop(subscriber.pending);
      }
      this.flushDropNotice(subscriber);
      subscriber.active = false;
    }
    this.subscribers.clear();
    return this.snapshot();
  }

  private fits(record: ToolActivityRecord): boolean {
    return Buffer.byteLength(JSON.stringify(record)) <= this.config.maxEventBytes;
  }

  private noteDrop(count: number): void {
    this.dropped += count;
  }

  private retain(record: ToolActivityRecord): void {
    if (this.config.replayCapacity === 0) return;
    if (this.retained.length === this.config.replayCapacity) this.retained.shift();
    this.retained.push(record);
  }

  private flushDropNotice(subscriber: SubscriberState): void {
    if (!subscriber.active || subscriber.dropped === 0) return;
    const notice: ToolActivityDropNotice = {
      schemaVersion: 1,
      type: "tool_activity_drop",
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      dropped: subscriber.dropped,
      droppedCount: this.dropped,
    };
    subscriber.dropped = 0;
    this.invoke(subscriber, notice);
  }

  private deliver(subscriber: SubscriberState, record: ToolActivityRecord): void {
    if (!subscriber.active) return;
    if (subscriber.pending >= this.config.subscriberPendingCapacity) {
      subscriber.dropped++;
      this.noteDrop(1);
      return;
    }
    this.flushDropNotice(subscriber);
    this.invoke(subscriber, record);
  }

  private invoke(subscriber: SubscriberState, record: ToolActivityRecord): void {
    subscriber.pending++;
    let result: void | Promise<void>;
    try {
      result = subscriber.consumer(record);
    } catch {
      subscriber.pending--;
      subscriber.dropped++;
      this.noteDrop(1);
      return;
    }
    if (result === undefined) {
      subscriber.pending--;
      return;
    }
    const promise = Promise.resolve(result).then(
      () => {
        subscriber.pending--;
      },
      () => {
        subscriber.pending--;
        subscriber.dropped++;
        this.noteDrop(1);
      },
    );
    subscriber.promises.add(promise);
    promise.finally(() => subscriber.promises.delete(promise));
  }
}

export interface AttachToolActivityOptions {
  channel: ToolActivityChannel;
  events: Events;
  targetDir: string;
  role: string;
  runId: string;
  step: string;
  /** The model serving `role`, shown beside it so routing is visible while it runs. */
  model?: string;
  parentOperation?: string;
  now?: () => number;
  /** Supplies a content-free stage-budget projection after terminal tool events. */
  budget?: () => ToolActivityBudget | undefined;
}

export interface ToolActivityAttachment {
  (): void;
  cancelActive(): void;
}

/** Attach the sole harness-to-domain adapter. The returned cleanup is idempotent. */
export function attachToolActivity(options: AttachToolActivityOptions): ToolActivityAttachment {
  const now = options.now ?? Date.now;
  const started = new Map<
    string,
    { at: number; toolName: string; runId: string; turnId: string }
  >();
  const requested = new Set<string>();
  const terminal = new Set<string>();
  /**
   * The subject projected when a call was first seen, keyed by tool call.
   *
   * Arguments arrive only on the REQUEST event; `tool_start` and `tool_end`
   * carry none. Reading them per-event therefore produced one line with the
   * command and the next two blank -- `Run  ls -la; git log ...  started`
   * followed by a bare `Run  25ms`. The operator saw exactly that and asked
   * what the empty ones were. Remembering the subject makes every line in a
   * call's lifecycle say what it is about.
   */
  const subjects = new Map<string, ToolActivityProjection>();
  const base = (event: {
    runId?: string;
    turnId?: string;
    toolCallId: string;
    toolName: string;
    args?: unknown;
  }) => {
    const classification = classifyTool(event.toolName);
    const projection =
      projectToolArguments(event.toolName, event.args, options.channel.config.projectionBytes) ??
      subjects.get(event.toolCallId);
    if (projection !== undefined) subjects.set(event.toolCallId, projection);
    return {
      activity: classification.activity,
      ...(projection !== undefined && { projection }),
      ...(options.model !== undefined && {
        model: boundToolActivityText(options.model, options.channel.config.maxStringBytes),
      }),
      role: boundToolActivityText(options.role, options.channel.config.maxStringBytes),
      runId: boundToolActivityText(options.runId, options.channel.config.maxStringBytes),
      operationId: event.runId ?? "",
      turnId: event.turnId ?? "",
      toolCallId: event.toolCallId,
      parentOperation: boundToolActivityText(
        options.parentOperation ?? options.step,
        options.channel.config.maxStringBytes,
      ),
      toolName: classification.publicName,
    };
  };
  const offMessage = options.events.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    for (const block of event.message.content) {
      if (block.type !== "toolCall" || requested.has(block.id)) continue;
      requested.add(block.id);
      options.channel.publish({
        ...base({ toolCallId: block.id, toolName: block.name, args: block.arguments }),
        lifecycle: "requested",
      });
    }
  });
  const offStart = options.events.on("tool_start", (event) => {
    if (!requested.has(event.toolCallId)) {
      requested.add(event.toolCallId);
      options.channel.publish({ ...base(event), lifecycle: "requested" });
    }
    started.set(event.toolCallId, {
      at: now(),
      toolName: event.toolName,
      runId: event.runId,
      turnId: event.turnId,
    });
    options.channel.publish({ ...base(event), lifecycle: "started" });
  });
  const offEnd = options.events.on("tool_end", (event) => {
    if (terminal.has(event.toolCallId)) return;
    terminal.add(event.toolCallId);
    const began = started.get(event.toolCallId);
    started.delete(event.toolCallId);
    const details = event.result.details;
    const trusted =
      details !== null && typeof details === "object" ? trustedOutcomes.get(details) : undefined;
    const lifecycle: ToolActivityLifecycle = trusted ?? (event.isError ? "failed" : "completed");
    const budget = options.budget?.();
    options.channel.publish({
      ...base(event),
      lifecycle,
      ...(began !== undefined && { durationMs: Math.max(0, now() - began.at) }),
      ...(budget !== undefined && { budget }),
    });
    // Published; the subject has served its purpose and must not accumulate
    // one entry per call for the life of the session.
    subjects.delete(event.toolCallId);
  });
  const offRunEnd = options.events.on("run_end", (event) => {
    if (event.status !== "aborted") return;
    for (const [toolCallId, began] of started) {
      if (terminal.has(toolCallId)) continue;
      terminal.add(toolCallId);
      options.channel.publish({
        ...base({
          toolCallId,
          toolName: began.toolName,
          runId: began.runId,
          turnId: began.turnId,
        }),
        lifecycle: "cancelled",
        durationMs: Math.max(0, now() - began.at),
      });
    }
    started.clear();
  });
  const cancelActive = () => {
    for (const [toolCallId, began] of started) {
      if (terminal.has(toolCallId)) continue;
      terminal.add(toolCallId);
      options.channel.publish({
        ...base({
          toolCallId,
          toolName: began.toolName,
          runId: began.runId,
          turnId: began.turnId,
        }),
        lifecycle: "cancelled",
        durationMs: Math.max(0, now() - began.at),
      });
    }
    started.clear();
  };
  let attached = true;
  const cleanup: ToolActivityAttachment = () => {
    if (!attached) return;
    attached = false;
    offMessage();
    offStart();
    offEnd();
    offRunEnd();
  };
  cleanup.cancelActive = cancelActive;
  return cleanup;
}
