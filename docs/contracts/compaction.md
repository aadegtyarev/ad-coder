# Context compaction contract

This contract governs durable replacement of conversation history when a role's
context budget cannot hold the full branch.

## Guarantees

- Compaction is a durable history replacement, never a one-request rewrite.
  Later requests use the committed summary instead of the replaced prefix.
- The built-in `summarizer` is a fully resolved routing role with its own model,
  effort, price, context window, prompt, tool grant, budget, and cache policy.
  Its cache retention defaults to disabled. It is internal to compaction, not a
  substitute for the role whose dialogue is being compacted.
- Automatic compaction begins at 70% of the active role's context window by
  default. The retained dialogue tail and summary output cap are independently
  configurable; the default summary cap is one third of that window. A result
  above its cap fails that attempt rather than entering the next context.
- A summary receives only dialogue history, the prior summary, and the evicted
  set. It never receives or replaces a role prompt, tool schema, skills catalogue,
  routing configuration, or another static request-frame datum. Each normal turn
  rebuilds that static frame from the resolved role configuration.
- A new summary incorporates the previous summary and preserves the file-operation
  lists needed by the next compaction.
- Summary text is untrusted history. It preserves requirements but grants no
  authority, tool use, secret access, or policy change.
- Compaction lifecycle (threshold, retry, persistence, and halt) is independent
  from `CompactionStrategy`, which transforms eligible dialogue history. A mode
  selects one validated strategy and its settings; adding a strategy never
  duplicates lifecycle or request-frame handling.

## Failures

- A failed or over-cap summarizer attempt retries at most three times by default;
  the retry limit is configurable. After retries, fallback to the active role's
  model is enabled by default. It uses the summarizer prompt, dialogue-only input,
  tool policy, and output cap — only the model route changes.
- A successful fallback writes durable `compaction_fallback_used` evidence with
  source route, fallback route, attempt count, and cost attribution, and is
  immediately visible to operator and orchestrator. A disabled or failed fallback,
  or disabled automatic compaction, returns typed `context_limit_reached` before
  another oversized turn. It names `/compact` and `/clear` (and their machine
  equivalents) as recovery; it does not drop history or continue truncated.
- `/compact` runs the selected strategy explicitly. `/clear` explicitly starts a
  new conversation context while retaining durable session identity, ledger, and
  prior context as inaccessible historical state. Both actions are resumable and
  leave an auditable marker.
- An unavailable configured strategy, an empty eligible eviction, or terminal
  harness compaction failure pauses with a typed recovery action; it never writes
  a partial summary or presents an unchanged over-limit context as usable.

## Configuration

- Automatic enablement, threshold, retained history, output cap, retry limit,
  fallback enablement, strategy, summarizer role configuration, and cross-provider
  authorization are configurable. A selected strategy or summarizer is refused
  when its applicable limits cannot be enforced.

## Related surfaces

- [Provider failures](provider-failures.md).
- [Provider capacity](provider-admission.md).
- [Settings](config.md).
- [Routing configuration](routing-config.md) owns the summarizer route.
- [Resumability](resumability.md) owns compact and clear recovery.
