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

export interface ToolActivityProjection {
  /** A verified target-relative path. Arbitrary labels, commands, queries and URLs are never projected. */
  path?: string;
}

export interface ToolActivityEvent {
  schemaVersion: 1;
  type: "tool_activity";
  sequence: number;
  timestamp: string;
  lifecycle: ToolActivityLifecycle;
  activity: ToolActivityKind;
  role: string;
  runId: string;
  operationId: string;
  turnId: string;
  toolCallId: string;
  parentOperation: string;
  toolName: string;
  droppedCount: number;
  projection?: ToolActivityProjection;
  durationMs?: number;
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
  web_search: { activity: "Web", publicName: "web_search" },
  web_read: { activity: "Web", publicName: "web_read" },
  inspect_image: { activity: "Inspect image", publicName: "inspect_image" },
};

function classifyTool(name: string): { activity: ToolActivityKind; publicName: string } {
  return KNOWN_TOOLS[name] ?? { activity: "Tool", publicName: "custom" };
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
  parentOperation?: string;
  now?: () => number;
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
  const base = (event: {
    runId?: string;
    turnId?: string;
    toolCallId: string;
    toolName: string;
    args?: unknown;
  }) => {
    const classification = classifyTool(event.toolName);
    return {
      activity: classification.activity,
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
    options.channel.publish({
      ...base(event),
      lifecycle,
      ...(began !== undefined && { durationMs: Math.max(0, now() - began.at) }),
    });
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
