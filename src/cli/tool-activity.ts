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
  /** Who is working: role and model, both held here and named only on render. */
  role: string;
  model?: string;
  /** Wall-clock at which the group opened, so a reader can scan down the left edge. */
  at: number;
  count: number;
  lifecycle: string;
  durationMs?: number;
  /** Stage spend, as far as the last terminal event knew it. */
  costUsd?: number;
  tokens?: number;
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
 * command, then the URL, then the query, then the skill a `load_skill` call
 * targeted. An edit also carries its size, because a three-line change that
 * became three hundred is the thing worth catching early.
 */
function subjectOf(projection: ToolActivityProjection | undefined): string {
  if (projection === undefined) return "";
  const subject =
    projection.path ??
    projection.command ??
    projection.url ??
    projection.query ??
    projection.skillId ??
    "";
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
 * defeats the point of having it; a known-but-zero spend still prints, so the
 * column never silently lies by omission, but unknown stays blank.
 */
function costOf(costUsd: number | undefined): string {
  if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd <= 0) return "";
  return costUsd < 0.001 ? "<$0.001" : `$${costUsd.toFixed(3)}`;
}

/** Tokens at a glance: `850 tok`, `12.3k tok`. Zero or unknown prints nothing. */
function tokensOf(tokens: number | undefined): string {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 1) return "";
  if (tokens < 1000) return `${Math.round(tokens)} tok`;
  const k = tokens / 1000;
  return k < 100 ? `${k.toFixed(1)}k tok` : `${Math.round(k)}k tok`;
}

const TERMINAL_LIFECYCLE = new Set(["completed", "failed", "cancelled", "timed_out"]);

/** A bounded, backpressure-aware stderr transport and semantic human grouper. */
export class ToolActivityRenderer {
  private readonly config: ToolActivityConfig;
  /** Groups persist across flushes until their call reaches a terminal state. */
  private readonly groups = new Map<string, HumanGroup>();
  /** Roles seen so far: one means the console, several mean a pipeline. */
  private readonly seenRoles = new Set<string>();
  /** The in-place line, if any: erased on the next flush and redrawn. */
  private live: { key: string; text: string } | undefined;
  /**
   * The last known stage spend, so a line drawn when NO call is running (a
   * stall between calls) still names the price instead of going mute about it.
   */
  private lastSpend?: { usedTokens?: number; usedCostUsd?: number };
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
    // because "which role went there" is the question being asked. The role is
    // decided on render, not here, so a second role appearing later cannot
    // re-key mid-lifecycle groups.
    this.seenRoles.add(record.role);
    const key = record.toolCallId;
    const previous = this.groups.get(key);
    if (previous === undefined) {
      if (this.groups.size >= this.config.humanGroupCount) {
        this.dropped++;
        return;
      }
      this.groups.set(key, {
        activity: record.activity,
        label,
        role: record.role,
        ...(record.model !== undefined && { model: record.model }),
        at: Date.now(),
        count: record.lifecycle === "requested" ? 1 : 0,
        lifecycle: record.lifecycle,
        ...(record.durationMs !== undefined && { durationMs: record.durationMs }),
        ...(record.budget?.usedCostUsd !== undefined && { costUsd: record.budget.usedCostUsd }),
        ...(record.budget?.usedTokens !== undefined && { tokens: record.budget.usedTokens }),
      });
    } else {
      // ONE call is ONE group for its whole lifecycle: subject, duration, and
      // spend update that same line instead of stacking a second unrelated one.
      previous.activity = record.activity;
      previous.label = label || previous.label;
      previous.lifecycle = record.lifecycle;
      if (record.lifecycle === "requested") previous.count++;
      if (record.durationMs !== undefined) previous.durationMs = record.durationMs;
      if (record.budget?.usedCostUsd !== undefined) previous.costUsd = record.budget.usedCostUsd;
      if (record.budget?.usedTokens !== undefined) previous.tokens = record.budget.usedTokens;
      if (record.model !== undefined) previous.model = record.model;
    }
    if (record.budget?.usedCostUsd !== undefined || record.budget?.usedTokens !== undefined) {
      this.lastSpend = {
        ...(record.budget?.usedTokens !== undefined && { usedTokens: record.budget.usedTokens }),
        ...(record.budget?.usedCostUsd !== undefined && {
          usedCostUsd: record.budget.usedCostUsd,
        }),
      };
    }
    this.scheduleFlush(record.lifecycle);
  };

  private readonly scheduleFlush = (lifecycle: string): void => {
    if (
      lifecycle === "failed" ||
      lifecycle === "cancelled" ||
      lifecycle === "timed_out" ||
      this.config.groupingRefreshMs === 0
    ) {
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.config.groupingRefreshMs);
    }
  };

  /**
   * Signals bunched terminal groups first, as settled lines; the newest still
   * running call then takes the ONE in-place line, re-erased and rewritten on
   * every flush so one call stays one line.
   */
  private renderLine(group: HumanGroup, live: boolean): string {
    const count = group.count > 1 ? ` ×${group.count}` : "";
    // Who is shown only once a second role has been seen. A literal "activity"
    // printed while one role worked named nothing, so the column simply
    // collapses instead.
    const actor =
      this.seenRoles.size > 1
        ? [group.role, group.model].filter((part) => part !== "" && part !== undefined).join("·")
        : "";
    const lifecycle = live ? "…" : group.lifecycle === "completed" ? "" : group.lifecycle;
    const duration = live ? durationOf(Date.now() - group.at) : durationOf(group.durationMs);
    // Left to right: when, who, what, with what, how long, what it spent.
    const parts = [
      clockOf(group.at),
      actor,
      `${group.activity}${count}`,
      group.label,
      lifecycle,
      duration,
      tokensOf(group.tokens),
      costOf(group.costUsd),
    ].filter((part) => part !== "");
    return live ? `${parts.join("  ")} …` : `${parts.join("  ")}\n`;
  }

  flush(): void {
    if (this.mode === "json") return;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Erase the in-place line before anything new lands under it.
    this.eraseLive();
    let liveKey: string | undefined;
    let liveGroup: HumanGroup | undefined;
    for (const [key, group] of this.groups) {
      if (TERMINAL_LIFECYCLE.has(group.lifecycle)) {
        this.write(this.renderLine(group, false));
        this.groups.delete(key);
      } else {
        liveKey = key;
        liveGroup = group;
      }
    }
    if (liveGroup !== undefined && liveKey !== undefined) {
      const text = this.renderLine(liveGroup, true);
      this.write(text, false);
      this.live = liveKey === undefined ? undefined : { key: liveKey, text };
    }
  }

  /** Erase whatever this renderer last drew in place, before the next draw. */
  private eraseLive(): void {
    if (this.live === undefined) return;
    this.raw(`\r${" ".repeat(Buffer.byteLength(this.live.text))}\r`);
    this.live = undefined;
  }

  /**
   * The busy line (issue #501): one line, updated in place, that says what the
   * turn is DOING -- the current activity's subject and, once a second role
   * works, the worker; the caller's prefix carries the elapsed time -- and the
   * spend so far -- instead of a bare "still running" that names nothing and
   * stacks a fresh line per heartbeat. Drawing goes through the SAME single
   * in-place slot the activity lines use, so a heartbeat can never become a
   * line storm: identical text is not rewritten, and the next flush erases
   * whatever the busy line last drew. JSON mode keeps complete event lines and
   * never draws in place.
   */
  renderBusyLine(prefix: string): void {
    if (this.closed || this.mode === "json") return;
    // The newest call still running: what the turn is acting on right now.
    let live: HumanGroup | undefined;
    for (const group of this.groups.values()) {
      if (!TERMINAL_LIFECYCLE.has(group.lifecycle)) live = group;
    }
    const parts = [prefix];
    if (live !== undefined) {
      const count = live.count > 1 ? ` ×${live.count}` : "";
      const subject = [`${live.activity}${count}`, live.label]
        .filter((part) => part !== "")
        .join(" ");
      if (subject !== "") parts.push(subject);
      // The worker is named only once a second role has been seen, exactly as
      // the activity line names it: while one role works, the column collapses.
      const actor =
        this.seenRoles.size > 1
          ? [live.role, live.model].filter((part) => part !== "" && part !== undefined).join("·")
          : "";
      if (actor !== "") parts.push(actor);
    }
    const spend = this.lastSpend?.usedCostUsd;
    if (spend !== undefined && Number.isFinite(spend) && spend > 0) parts.push(costOf(spend));
    const text = `${parts.join("  ")} …`;
    // Identical consecutive progress lines are never repeated: the line on
    // screen is already exactly this text, so neither erase nor rewrite fires.
    if (this.live?.text === text) return;
    this.eraseLive();
    this.write(text, false);
    this.live = { key: "", text };
  }

  /** Direct write, bypassing newline framing: used only for erase sequences. */
  private raw(chunk: string): void {
    this.output.write(chunk);
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

  private write(raw: string, frame = true): void {
    const line = boundToolActivityText(raw, this.config.renderedLineBytes);
    const framed = !frame || line.endsWith("\n") ? line : `${line}\n`;
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
