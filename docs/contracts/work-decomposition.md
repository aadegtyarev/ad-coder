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
- A capacity or complexity problem has exactly two automatic responses: one
  measured, per-role/stage ceiling probe, or decomposition. The probe is allowed
  only once and only when the full remaining development cycle remains funded;
  a second exhaustion, an unsafe probe, or insufficient remaining cycle reserve
  emits `decomposition_required`.
- Decomposition signals include a planner's complexity-estimate mismatch or
  `too_complex` result; a coder or reviewer `too_complex` result; a repeated
  review finding; and a pipeline review loop. The signal records its source,
  bounded evidence, affected scope, attempt count, and the reason a probe was
  used or refused. It is a mechanism, not advisory prose a driver may ignore.
- Adjacent small follow-ups merge only when kind and destination agree, evidence
  is identical or shares a directory prefix, each item has bounded evidence, and
  the merged item still passes its save validation. Otherwise no partial merge
  occurs.
- A failed routing-tier escalation remains explicit until a per-dispatch tier and
  usable fallback rung exist; the system never claims it raised a route it did not
  change.

## Verification

Test every role-requested signal, repeated-review and loop detection, one allowed
and one refused probe, mandatory decomposition after a second exhaustion,
host-child precedence, empty derivation pause, maximum child count, allowed and
rejected consolidation, and unavailable routing-tier escalation.

## Related surfaces

- [Operation modes](operation-modes.md) owns auto-mode authority.
- [Decomposition](decomposition.md) owns code-structure refactoring.
- [Routing configuration](routing-config.md) owns model ladders.
- [Task estimation](task-estimation.md) owns whole-cycle reserve and feedback.
