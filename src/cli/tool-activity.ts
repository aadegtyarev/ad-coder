import type { ToolActivityConfig, ToolActivityRecord } from "../observability/tool-activity";
import { boundToolActivityText, resolveToolActivityConfig } from "../observability/tool-activity";

export type ToolActivityRenderMode = "human" | "json";

interface HumanGroup {
  activity: string;
  label: string;
  count: number;
  lifecycle: string;
  durationMs?: number;
}

/** A bounded, backpressure-aware stderr transport and semantic human grouper. */
export class ToolActivityRenderer {
  private readonly config: ToolActivityConfig;
  private readonly groups = new Map<string, HumanGroup>();
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private dropped = 0;
  private blocked = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly output: NodeJS.WritableStream,
    private readonly mode: ToolActivityRenderMode,
    config: Partial<ToolActivityConfig> = {},
  ) {
    this.config = resolveToolActivityConfig(config);
    output.on("drain", this.onDrain);
  }

  consume = (record: ToolActivityRecord): void => {
    if (this.closed) return;
    if (this.mode === "json") {
      this.write(`${JSON.stringify(record)}\n`);
      return;
    }
    if (record.type === "tool_activity_drop") {
      this.write(`Activity: ${record.dropped} event(s) dropped (${record.droppedCount} total)\n`);
      return;
    }
    const label = record.projection?.path ?? "";
    const key = `${record.activity}\0${label}`;
    const previous = this.groups.get(key);
    if (previous === undefined && this.groups.size >= this.config.humanGroupCount) {
      this.dropped++;
      return;
    }
    this.groups.set(key, {
      activity: record.activity,
      label,
      count: (previous?.count ?? 0) + (record.lifecycle === "requested" ? 1 : 0),
      lifecycle: record.lifecycle,
      ...(record.durationMs !== undefined && { durationMs: record.durationMs }),
    });
    if (
      record.lifecycle === "failed" ||
      record.lifecycle === "cancelled" ||
      record.lifecycle === "timed_out"
    ) {
      this.flush();
    } else if (this.config.groupingRefreshMs === 0) {
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.config.groupingRefreshMs);
    }
  };

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const group of this.groups.values()) {
      const count = group.count > 1 ? ` ×${group.count}` : "";
      const label = group.label === "" ? "" : ` ${group.label}`;
      const duration = group.durationMs === undefined ? "" : ` ${group.durationMs}ms`;
      this.write(`Activity: ${group.activity}${label}${count} — ${group.lifecycle}${duration}\n`);
    }
    this.groups.clear();
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    const lostOnClose = this.dropped + this.queue.length;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.dropped = 0;
    if (lostOnClose > 0) {
      // One final bounded write is the finite shutdown policy; it cannot grow with event volume.
      this.output.write(this.dropLine(lostOnClose, true));
    }
    this.closed = true;
    this.output.off("drain", this.onDrain);
  }

  private readonly onDrain = (): void => {
    this.blocked = false;
    if (this.dropped > 0) {
      const dropped = this.dropped;
      this.dropped = 0;
      this.write(this.dropLine(dropped, false));
    }
    while (!this.blocked && this.queue.length > 0) {
      const line = this.queue.shift() as string;
      this.queuedBytes -= Buffer.byteLength(line);
      this.blocked = !this.output.write(line);
    }
  };

  private dropLine(dropped: number, final: boolean): string {
    return this.mode === "json"
      ? `${JSON.stringify({ schemaVersion: 1, type: "tool_activity_render_drop", dropped, final })}\n`
      : `Activity: ${dropped} rendered event(s) dropped${final ? " before close" : ""}\n`;
  }

  private write(raw: string): void {
    const line = boundToolActivityText(raw, this.config.renderedLineBytes);
    const framed = line.endsWith("\n") ? line : `${line}\n`;
    if (!this.blocked && this.queue.length === 0) {
      this.blocked = !this.output.write(framed);
      return;
    }
    const bytes = Buffer.byteLength(framed);
    if (
      this.queue.length >= this.config.renderQueueCount ||
      this.queuedBytes + bytes > this.config.renderQueueBytes
    ) {
      this.dropped++;
      return;
    }
    this.queue.push(framed);
    this.queuedBytes += bytes;
  }
}
