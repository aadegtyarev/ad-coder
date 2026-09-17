/**
 * The numeric shape of one provider usage reading: tokens and money, no
 * identifiers and no diff-only bookkeeping.
 *
 * `cacheWrite1h` is a subset of `cacheWrite` and `reasoning` is a subset of
 * `output`; aggregating either into its parent double-counts.
 */
export interface UsageAmounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  /** Provider-reported money, only ever copied or subtracted -- never derived from tokens times a rate. */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/**
 * Per-turn difference between two CUMULATIVE provider usage readings.
 *
 * Only meaningful for a source that accumulates over a stream -- see the file
 * block in ./usage for which event that is and which one it is not.
 */
export interface UsageDelta extends UsageAmounts {
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
  /** That one response's own numbers, not a difference against anything. */
  usage: UsageAmounts;
  /**
   * Tool names the model REQUESTED in this one response, mapped to how many
   * times each was called. Per-response, matching the usage granularity above,
   * and omitted entirely when the response made no tool calls.
   *
   * This is a REQUEST signal, not an outcome: it does not record whether a call
   * executed, succeeded, or returned `isError` -- that needs the separate
   * `after_tool` hook and is a documented FOLLOW-ON, not this field. It carries
   * tool NAMES and COUNTS only -- never call arguments, never tool output --
   * so it preserves the safe-to-share invariant above.
   */
  toolCalls?: Record<string, number>;
  /**
   * Byte sizes of the three parts of the request this response answered.
   *
   * SIZES, never content: the same safe-to-share invariant as `toolCalls`. They
   * are recorded because nothing else preserves them -- the stage metrics that
   * carry `requestBytes` travel in the pipeline result, which a hung run never
   * returns (issue #315), and a session transcript stores streamed assistant
   * frames only. Without this row a role that received no system prompt, or a
   * brief that arrived truncated, is indistinguishable after the fact from a
   * role that simply behaved oddly (issue #317).
   *
   * Constant for every turn of one role run, and repeated per row anyway: a
   * ledger is read row by row, and a value stored once in a header nobody reads
   * with the row is a value that does not answer the question.
   */
  requestBytes?: {
    systemPrompt: number;
    prompt: number;
    toolDefinitions: number;
    total: number;
  };
}
