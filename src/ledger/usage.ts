import type { Usage } from "@earendil-works/pi-ai";
import type { UsageDelta } from "./types";

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
 * increment. Key by lane and run, never by role: two roles sharing a lane
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
