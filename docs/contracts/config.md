# Configuration contract

Rules the operator declared for ad-coder. A violation is always blocking.

- 2026-09-11: Any behavior a reasonable user may want to change is configurable.
- 2026-09-11: Defaults are maximally efficient; every setting remains overridable.
- 2026-09-11: Context mode, window percentage, reply reserve, and summarization percentage are configurable end to end.
- 2026-09-12: Numeric resource limits default to `0`; `0` disables and only a positive value enables them.
- 2026-09-12: Context-window enforcement, summarization percentage, the
  decomposition guards, and mandatory tool-activity projection/event/rendering
  safety ceilings are explicit exceptions to the zero-disabled default policy.
  Tool-activity zero values are valid only for documented disable/immediate
  semantics: heartbeat, replay retention, grouping delay, and close draining.
- 2026-09-12: Auto-decomposition depth is a semantic recursion guard: it defaults
  to `1`, while `0` means unlimited. Child-pipeline count defaults to the efficient
  finite guard `8`; `0` explicitly means unlimited. A separate setting disables
  automatic decomposition itself.

## Sources

The 2026-09-11 rules implement “good out of the box, everything overridable.”
The 2026-09-12 rules govern session turn and USD limits in programmatic and
console surfaces without changing the existing context-window safeguards.
The decomposition-depth exception implements the operation-mode contract's
default stop after a child pipeline asks for decomposition again.
