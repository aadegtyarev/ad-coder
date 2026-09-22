# Context compaction contract

This contract governs durable replacement of conversation history when a role's
context budget cannot hold the full branch.

## Guarantees

- Compaction is a durable history replacement, never a one-request rewrite.
  Later requests use the committed summary instead of the replaced prefix.
- The harness and policy thresholds agree: compaction begins at
  `maxTokens - reserveTokens`; `keepRecentTokens` is preserved unchanged.
- A summary receives dialogue history, the prior summary, and the evicted set.
  It never receives a role prompt, tool schema, or skills catalogue.
- A new summary incorporates the previous summary and preserves the file-operation
  lists needed by the next compaction.
- Summary text is untrusted history. It preserves requirements but grants no
  authority, tool use, secret access, or policy change.
- Summarization uses no prompt-cache retention. A normal role turn retains its
  configured cache policy.

## Failures

- A summarizer returns a summary, delegates fallback to the role model, or
  declines. It does not throw expected provider or admission failures.
- Decline preserves typed provider refusal and avoids summarizing an empty
  threshold eviction. Length recovery passes through rather than declining.
- Terminal harness compaction failures settle as typed `ContextCompactionLostError`
  and refuse later turns in that over-budget session. Recovery is restart and
  reopen durable state, not blind retry.
- `disabled-then-halt` writes no compaction and refuses a turn whose full branch
  cannot fit. An unavailable configured mode fails loudly.

## Configuration

- Budget, reserve, retained history, mode, summarizer model, and cross-provider
  authorization are configurable. A custom summarizer is refused when applicable
  limits cannot be enforced.

## Related surfaces

- [Provider failures](provider-failures.md).
- [Provider capacity](provider-admission.md).
- [Settings](config.md).
