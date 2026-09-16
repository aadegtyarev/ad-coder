import type {
  ToolActivityConfig,
  ToolActivityProjection,
  ToolActivityRecord,
} from "../observability/tool-activity";
import { boundToolActivityText, resolveToolActivityConfig } from "../observability/tool-activity";

export type ToolActivityRenderMode = "human" | "json";

/** The console supplies one shared line transport for every stderr producer. */
export interface LineOutput {
  write(chunk: string): boolean;
  on(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
}

interface HumanGroup {
  activity: string;
  label: string;
  count: number;
  lifecycle: string;
  durationMs?: number;
  /** Who is working: role, model, complexity -- one thought, rendered as one block. */
  actor: string;
  /** Wall-clock at which the group opened, so a reader can scan down the left edge. */
  at: number;
  costUsd?: number;
  budgetLeft?: number;
}

/** `14:32:07` -- local time, seconds resolution, fixed width so the column aligns. */
function clockOf(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * What the tool is acting on, in one short phrase.
 *
 * Preference order is what an operator scans for: the file first, then the
 * command, then the URL, then the query. An edit also carries its size, because
 * a three-line change that became three hundred is the thing worth catching
 * early.
 */
function subjectOf(projection: ToolActivityProjection | undefined): string {
  if (projection === undefined) return "";
  const subject = projection.path ?? projection.command ?? projection.url ?? projection.query ?? "";
  if (subject === "") return "";
  const added = projection.linesAdded;
  const removed = projection.linesRemoved;
  if (added !== undefined || removed !== undefined) {
    const plus = added === undefined ? "" : ` +${added}`;
    const minus = removed === undefined ? "" : ` -${removed}`;
    return `${subject}${plus}${minus}`;
  }
  // A read shows the window it asked for: `:120+40` is a slice, a bare path is
  // the whole file. Reading in slices and swallowing a large file cost
  // differently, and the difference is otherwise invisible.
  const offset = projection.readOffset;
  const limit = projection.readLimit;
  if (offset === undefined && limit === undefined) return subject;
  const from = offset === undefined ? "" : `:${offset}`;
  const span = limit === undefined ? "" : `+${limit}`;
  return `${subject}${from}${span}`;
}

/** Seconds, not milliseconds: `1.2s` reads at a glance where `1234ms` does not. */
function durationOf(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

/**
 * Cost, but only once it is worth a glance.
 *
 * Printing `$0.000` on every line trains the eye to skip the column, which
 * defeats the point of having it.
 */
function costOf(costUsd: number | undefined): string {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0.001) return "";
  return `$${costUsd.toFixed(3)}`;
}

/** A bounded, backpressure-aware stderr transport and semantic human grouper. */
export class ToolActivityRenderer {
  private readonly config: ToolActivityConfig;
  private readonly groups = new Map<string, HumanGroup>();
  /** Roles seen so far: one means the console, several mean a pipeline. */
  private readonly seenRoles = new Set<string>();
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private dropped = 0;
  private blocked = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly output: LineOutput,
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
    const label = subjectOf(record.projection);
    // Grouping keys on WHO and WHAT: two roles touching one file are two lines,
    // because "which role went there" is the question being asked.
    // The console runs one role, so printing "orchestrator" on every line is
    // noise the operator asked to drop. A pipeline alternates roles, where the
    // name IS the point -- so the role appears once a second one has been seen.
    this.seenRoles.add(record.role);
    const actor = [this.seenRoles.size > 1 ? record.role : undefined, record.model]
      .filter((part) => part !== undefined && part !== "")
      .join("\u00b7");
    const key = `${actor}\0${record.activity}\0${label}`;
    const previous = this.groups.get(key);
    if (previous === undefined && this.groups.size >= this.config.humanGroupCount) {
      this.dropped++;
      return;
    }
    this.groups.set(key, {
      activity: record.activity,
      label,
      actor,
      at: previous?.at ?? Date.now(),
      count: (previous?.count ?? 0) + (record.lifecycle === "requested" ? 1 : 0),
      lifecycle: record.lifecycle,
      ...(record.durationMs !== undefined && { durationMs: record.durationMs }),
      ...(record.budget?.costUsd !== undefined && { budgetLeft: record.budget.costUsd }),
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
      // Left to right: when, who, what, with what, how long, what it cost.
      // Empty columns collapse rather than printing a placeholder, so a line
      // never carries a field that says nothing.
      const count = group.count > 1 ? ` \u00d7${group.count}` : "";
      const parts = [
        clockOf(group.at),
        group.actor === "" ? "activity" : group.actor,
        `${group.activity}${count}`,
        group.label,
        group.lifecycle === "completed" ? "" : group.lifecycle,
        durationOf(group.durationMs),
        costOf(group.costUsd),
      ].filter((part) => part !== "");
      this.write(`${parts.join("  ")}\n`);
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
