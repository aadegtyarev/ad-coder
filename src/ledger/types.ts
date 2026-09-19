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
  /**
   * Present ONLY on a refusal row: a turn the conversation refused before any
   * provider call (issue #422). Carries the typed code, the discriminator and
   * the authored sentence -- never the prompt or any other in-scope payload --
   * and its usage is always zero, which is what distinguishes it from a
   * provider-failure row (usage from the provider, no refusal field). Additive:
   * readers that do not know it simply ignore it.
   */
  refusal?: { code: string; reason: string; message: string };
  /**
   * Bounded provider-reported failure cause, present ONLY on an error-stopped
   * settled message (issue #418): `status` is the 3-digit HTTP status the
   * provider embedded in its failure (anchored message shapes or a structured
   * field, validated to 400..599) and `code` is the provider's own error code
   * as a strict-charset token (`[A-Za-z0-9_.-]{1,64}`). Both fields are
   * optional and one or the other may be absent when the provider named only
   * a bare status.
   *
   * SAFE TO SHARE. Only these two bounded values are stored -- never the
   * message they were read from, never the response body (a provider error
   * body can echo the request it refused), never prose, never a URL. Two
   * rows repeating the same paired values are what an operator reads as
   * "all presets fail with 402 / insufficient_credits" -- without re-running
   * anything, and without the body ever having reached a file.
   */
  providerError?: {
    status?: number;
    code?: string;
  };
}
