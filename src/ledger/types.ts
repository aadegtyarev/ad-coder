/**
 * Per-turn difference between two cumulative provider usage readings.
 *
 * `cacheWrite1h` is a subset of `cacheWrite` and `reasoning` is a subset of
 * `output`; aggregating either into its parent double-counts.
 */
export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  /** Provider-reported money, only ever subtracted -- never derived from tokens times a rate. */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  /** Set when a cumulative reading went backwards; the affected fields are clamped to 0. */
  anomaly?: "non_monotonic";
}

/**
 * One ledger line: identifiers and numbers only. Deliberately carries no
 * request or response payload, no message body and no HTTP response metadata,
 * so a ledger file is safe to keep and to share.
 */
export interface LedgerRecord {
  ts: number;
  runId: string;
  lane: string;
  role: string;
  step: string;
  provider: string;
  model: string;
  stopReason: string;
  status?: number;
  delta: UsageDelta;
}
