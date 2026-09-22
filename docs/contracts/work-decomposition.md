# Work decomposition contract

This contract owns automatic splitting and consolidation of workflow follow-up work.

## Guarantees

- A settled run can signal `decomposition_required` separately from ordinary
  `changes_requested`. The signal is a bounded typed result and status projection
  with reason and blocking-verdict identities, so the orchestrator can act on it.
- On that signal, the orchestrator creates at most four children, one per final
  blocker or major finding. Host-supplied children take precedence. If no valid
  child can be derived, the run pauses with a deferred decision; it never emits
  invalid configuration as a substitute.
- Adjacent small follow-ups merge only when kind and destination agree, evidence
  is identical or shares a directory prefix, each item has bounded evidence, and
  the merged item still passes its save validation. Otherwise no partial merge
  occurs.
- A failed routing-tier escalation remains explicit until a per-dispatch tier and
  usable fallback rung exist; the system never claims it raised a route it did not
  change.

## Verification

Test role-requested and verdict-derived signals, host-child precedence, empty
derivation pause, maximum child count, allowed and rejected consolidation, and
unavailable routing-tier escalation.

## Related surfaces

- [Operation modes](operation-modes.md) owns auto-mode authority.
- [Decomposition](decomposition.md) owns code-structure refactoring.
- [Routing configuration](routing-config.md) owns model ladders.
