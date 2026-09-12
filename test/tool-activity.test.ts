import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import type { Events } from "@earendil-works/pi-agent-core";
import { ToolActivityRenderer } from "../src/cli/tool-activity";
import {
  attachToolActivity,
  markTrustedToolOutcome,
  ToolActivityChannel,
  type ToolActivityRecord,
} from "../src/observability/tool-activity";

class MemoryWritable extends Writable {
  private readonly chunks: Buffer[] = [];
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

class FakeEvents {
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  on(type: string, listener: (event: never) => void): () => void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

function message(toolCallId: string, name: string, args: Record<string, unknown>) {
  return {
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
    },
  };
}

function lifecycleEvent(
  overrides: Partial<Extract<ToolActivityRecord, { type: "tool_activity" }>> = {},
) {
  return {
    schemaVersion: 1 as const,
    type: "tool_activity" as const,
    sequence: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    lifecycle: "started" as const,
    activity: "Read" as const,
    role: "coder",
    runId: "public-run",
    operationId: "operation",
    turnId: "turn",
    toolCallId: "call",
    parentOperation: "code:1",
    toolName: "read",
    droppedCount: 0,
    ...overrides,
  };
}

describe("tool activity core", () => {
  test("emits ordered success, failure, timeout, and cancellation without projecting secrets", () => {
    const channel = new ToolActivityChannel({ groupingRefreshMs: 0 });
    const records: ToolActivityRecord[] = [];
    channel.subscribe((record) => {
      records.push(record);
    });
    const fake = new FakeEvents();
    let clock = 10;
    const detach = attachToolActivity({
      channel,
      events: fake as unknown as Events,
      targetDir: process.cwd(),
      role: "coder\nforged",
      runId: "public-run",
      step: "code:1",
      now: () => clock,
    });

    const secret = "API_KEY=ultra-secret";
    fake.emit("message_end", message("ok", "bash", { command: `echo ${secret}` }));
    fake.emit("tool_start", {
      runId: "operation",
      turnId: "turn",
      toolCallId: "ok",
      toolName: "bash",
      args: { command: secret },
    });
    clock = 15;
    fake.emit("tool_end", {
      runId: "operation",
      turnId: "turn",
      toolCallId: "ok",
      toolName: "bash",
      result: { details: undefined },
      isError: false,
    });

    for (const [id, details, isError] of [
      ["failure", {}, true],
      ["timeout", markTrustedToolOutcome({}, "timed_out"), false],
    ] as const) {
      fake.emit("tool_start", {
        runId: "operation",
        turnId: "turn",
        toolCallId: id,
        toolName: "web_search",
        args: { query: secret },
      });
      fake.emit("tool_end", {
        runId: "operation",
        turnId: "turn",
        toolCallId: id,
        toolName: "web_search",
        result: { details },
        isError,
      });
    }
    fake.emit("tool_start", {
      runId: "operation",
      turnId: "turn",
      toolCallId: "cancel",
      toolName: "inspect_image",
      args: { source: `https://example.test/${secret}`, question: secret },
    });
    fake.emit("run_end", { runId: "operation", status: "aborted" });
    fake.emit("message_end", message("never-started", `custom-${secret}`, { value: secret }));
    detach();

    const events = records.filter((record) => record.type === "tool_activity");
    expect(events.map((event) => event.lifecycle)).toEqual([
      "requested",
      "started",
      "completed",
      "requested",
      "started",
      "failed",
      "requested",
      "started",
      "timed_out",
      "requested",
      "started",
      "cancelled",
      "requested",
    ]);
    expect(events.at(-1)?.toolName).toBe("custom");
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(records.every((record) => Buffer.byteLength(JSON.stringify(record)) <= 2048)).toBe(true);
  });

  test("bounds subscriber queues and makes loss visible when delivery resumes", async () => {
    const channel = new ToolActivityChannel({ subscriberPendingCapacity: 1, replayCapacity: 0 });
    const records: ToolActivityRecord[] = [];
    let release: (() => void) | undefined;
    channel.subscribe((record) => {
      records.push(record);
      if (records.length === 1) return new Promise<void>((resolve) => (release = resolve));
    });
    const publish = () =>
      channel.publish({
        lifecycle: "started",
        activity: "Tool",
        role: "coder",
        runId: "run",
        operationId: "op",
        turnId: "turn",
        toolCallId: crypto.randomUUID(),
        parentOperation: "step",
        toolName: "custom",
      });
    publish();
    publish();
    expect(channel.droppedCount).toBe(1);
    release?.();
    await Promise.resolve();
    publish();
    expect(records.some((record) => record.type === "tool_activity_drop")).toBe(true);
  });

  test("zero replay retains nothing and throwing consumers cannot fail producers", () => {
    const channel = new ToolActivityChannel({ replayCapacity: 0 });
    channel.subscribe(() => {
      throw new Error("consumer failed");
    });
    expect(() =>
      channel.publish({
        lifecycle: "failed",
        activity: "Tool",
        role: "role",
        runId: "run",
        operationId: "op",
        turnId: "turn",
        toolCallId: "call",
        parentOperation: "step",
        toolName: "custom",
      }),
    ).not.toThrow();
    expect(channel.snapshot().retained).toEqual([]);
    expect(channel.droppedCount).toBe(1);
  });
});

describe("tool activity renderer", () => {
  test("groups repeated human activity and renders stable NDJSON", () => {
    const humanOutput = new MemoryWritable();
    const human = new ToolActivityRenderer(humanOutput, "human", { groupingRefreshMs: 0 });
    human.consume(lifecycleEvent({ lifecycle: "requested" }));
    human.consume(lifecycleEvent({ lifecycle: "requested", sequence: 2 }));
    human.consume(lifecycleEvent({ lifecycle: "failed", sequence: 3, durationMs: 8 }));
    human.close();
    expect(humanOutput.text()).toContain("Activity: Read");
    expect(humanOutput.text()).toContain("failed");

    const jsonOutput = new MemoryWritable();
    const json = new ToolActivityRenderer(jsonOutput, "json");
    const event = lifecycleEvent();
    json.consume(event);
    json.close();
    expect(JSON.parse(jsonOutput.text())).toEqual(event);
  });
});
