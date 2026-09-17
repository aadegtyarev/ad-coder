/**
 * Which pi hook events report CUMULATIVE usage and which report PER-RESPONSE
 * usage. Documented here once, because getting it backwards silently
 * under-reports or double-counts every turn. Evidence is line-specific to the
 * pinned @earendil-works 0.85.1; a version bump makes it checkable.
 *
 * `after_response` is PER-RESPONSE. The harness folds each persisted row into
 * the session totals by ADDITION -- `addUsage(this.stats.usage, row.usage)` at
 * `pi-agent-core/dist/harness/session/in-memory-storage-state.js:67` -- and
 * that row is `usage: committed.usage`
 * (`harness/runtime/drive/response.js:246`, where `committed = response` at
 * `:124`), the very settled message that
 * `harness/execution/assistant.js:46-50` hands the hook. Addition-based totals
 * are only correct for per-response rows; a session-cumulative row would make
 * totals grow quadratically. So `diffUsage`/`UsageDeltaTracker` are the WRONG
 * tool on this event.
 *
 * `message_update` IS cumulative within one streaming response: pi-ai assigns
 * absolute values into a single mutable `output.usage`
 * (`pi-ai/dist/api/anthropic-messages.js:409-417` and `:568-578`), and
 * `harness/execution/assistant.js:38` re-emits it as `{ ...event.partial }` --
 * a SHALLOW copy, so every update shares that same usage object. That is the
 * event `diffUsage`/`UsageDeltaTracker` exist for, and the reason the tracker
 * snapshots a reading before retaining it as a baseline.
 */

import type { SettledAssistantMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { UsageAmounts, UsageDelta } from "./types";

/**
 * Derive one turn's usage from two cumulative readings.
 *
 * `prev === undefined` means the first reading of a stream, whose delta is the
 * reading itself. Cost fields are subtractions of provider-reported
 * `Usage.cost` and are never recomputed from token counts times a rate: a
 * recomputation silently diverges from provider billing.
 *
 * A field that would go negative is clamped to 0 and the whole delta is marked
 * `anomaly: "non_monotonic"`, so a counter reset never emits negative money.
 */
export function diffUsage(prev: Usage | undefined, next: Usage): UsageDelta {
  let nonMonotonic = false;
  const sub = (after: number, before: number): number => {
    const d = after - before;
    if (d < 0) {
      nonMonotonic = true;
      return 0;
    }
    return d;
  };

  const cacheWrite1h = subsetField(prev, next, "cacheWrite1h", sub);
  const reasoning = subsetField(prev, next, "reasoning", sub);

  return {
    input: sub(next.input, prev?.input ?? 0),
    output: sub(next.output, prev?.output ?? 0),
    cacheRead: sub(next.cacheRead, prev?.cacheRead ?? 0),
    cacheWrite: sub(next.cacheWrite, prev?.cacheWrite ?? 0),
    ...(cacheWrite1h !== undefined && { cacheWrite1h }),
    ...(reasoning !== undefined && { reasoning }),
    totalTokens: sub(next.totalTokens, prev?.totalTokens ?? 0),
    cost: {
      input: sub(next.cost.input, prev?.cost.input ?? 0),
      output: sub(next.cost.output, prev?.cost.output ?? 0),
      cacheRead: sub(next.cost.cacheRead, prev?.cost.cacheRead ?? 0),
      cacheWrite: sub(next.cost.cacheWrite, prev?.cost.cacheWrite ?? 0),
      total: sub(next.cost.total, prev?.cost.total ?? 0),
    },
    ...(nonMonotonic ? { anomaly: "non_monotonic" as const } : {}),
  };
}

/**
 * Copy a provider reading into the ledger's own numeric shape.
 *
 * Field by field through an explicit allow-list, never a spread of the input
 * and never structuredClone: a field pi-ai adds in a later version would
 * otherwise land in the ledger file unreviewed, and a ledger line is meant to
 * be safe to keep and to share. The returned object -- `cost` included -- is
 * fresh, so a caller that later mutates the provider's `Usage` cannot
 * retroactively rewrite a record a sink has already retained or written.
 */
export function usageAmounts(usage: Usage): UsageAmounts {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined && { cacheWrite1h: usage.cacheWrite1h }),
    ...(usage.reasoning !== undefined && { reasoning: usage.reasoning }),
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

/**
 * Count the tool calls a settled response REQUESTED, by tool name.
 *
 * Derived from the SAME per-response settled message that supplies usage, so it
 * shares that granularity exactly: it is what the model asked to call in this
 * one response, NOT whether any call executed or succeeded -- execution outcome
 * (`isError`) lives on the separate `after_tool` hook and is a documented
 * FOLLOW-ON. The map is built by iterating `message.content` for
 * `type === "toolCall"` blocks and counting their `name`; `block.arguments` is
 * never read, so only names and counts -- both safe to share -- ever leave this
 * function. A response with no tool calls yields `{}`, which the caller uses to
 * decide the ledger field is omitted rather than written as an empty object.
 *
 * A tool name is attacker-influenced data, so the tally is kept in a `Map`, not
 * a plain object: an object keyed by `hasOwnProperty`/`toString`/etc. would read
 * back the inherited prototype function instead of a number and concatenate
 * garbage, and a `__proto__` key would reassign the prototype instead of
 * creating an entry, silently dropping the call from the count. `Object.fromEntries`
 * materialises every name -- `__proto__` included -- as an own property.
 */
/**
 * What a MISSING or empty tool name means (issue #251, decided 2026-09-17): it
 * is a provider anomaly, not a tool the project knows -- no such tool can be
 * invoked, and a call block whose name did not arrive is the visible half of a
 * malformed or truncated provider response. The plain empty string recorded
 * nothing that could be read back (`=1` in every name-keyed projection). The
 * call is counted under the sentinel below, which the reader sees as exactly
 * that anomaly; the shape of the trouble is on the same record, because the
 * ledger row carries `stopReason` -- an `<unnamed>` count beside a truncated
 * or error stop reason is the read-back signature of a lost response tail,
 * and beside `stop` it is an isolated provider quirk. Nothing can be
 * attributed from the block's call id here: resolving a name back from the id
 * would need the earlier request that registered the tool, which this
 * per-response hook does not have.
 */
export const UNNAMED_TOOL_CALL = "<unnamed>";

/** Map a reported tool name to its ledger key, reserving the sentinel for a name that did not arrive. */
function toolCallNameKey(name: string): string {
  return name && name.trim().length > 0 ? name : UNNAMED_TOOL_CALL;
}

export function toolCallCounts(message: SettledAssistantMessage): Record<string, number> {
  const counts = new Map<string, number>();
  for (const block of message.content) {
    if (block.type === "toolCall") {
      const name = toolCallNameKey(block.name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return Object.fromEntries(counts);
}

/**
 * A field only some providers report: absent on both readings means the key is
 * omitted from the delta entirely rather than emitted as 0, so "not reported"
 * stays distinguishable from "reported as zero".
 */
function subsetField(
  prev: Usage | undefined,
  next: Usage,
  key: "cacheWrite1h" | "reasoning",
  sub: (after: number, before: number) => number,
): number | undefined {
  const before = prev?.[key];
  const after = next[key];
  if (before === undefined && after === undefined) return undefined;
  return sub(after ?? 0, before ?? 0);
}

/**
 * Holds the last cumulative reading per stream so each turn yields its own
 * increment. For a cumulative source only -- the file block above says which
 * event that is. Key by lane and run, never by role: two roles sharing a lane
 * share one cumulative counter, and keying by role would restate the whole
 * running total as each role's first delta.
 */
export class UsageDeltaTracker {
  private readonly last = new Map<string, Usage>();

  /**
   * Deliberately synchronous, and must stay so: an await between the read of
   * the baseline and its replacement lets two concurrent turns on one key diff
   * against the same stale reading and count the same tokens twice.
   */
  delta(key: string, cumulative: Usage): UsageDelta {
    const prev = this.last.get(key);
    this.last.set(key, snapshot(cumulative));
    return diffUsage(prev, cumulative);
  }

  /** Drop a finished stream's baseline. The map is not otherwise pruned. */
  forget(key: string): void {
    this.last.delete(key);
  }

  /** Number of streams currently holding a baseline. */
  get trackedKeys(): number {
    return this.last.size;
  }
}

/** The caller owns the Usage object it passed; copy before retaining it as a baseline. */
function snapshot(usage: Usage): Usage {
  return { ...usage, cost: { ...usage.cost } };
}
