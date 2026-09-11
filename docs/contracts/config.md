# Configuration contract

Rules the operator declared for ad-coder. A violation is always blocking.

- 2026-09-11: Any behavior a reasonable user may want to change is configurable.
- 2026-09-11: Defaults are maximally efficient; every setting remains overridable.
- 2026-09-11: Context mode, window percentage, reply reserve, and summarization percentage are configurable end to end.
- 2026-09-12: Numeric resource limits default to `0`; `0` disables and only a positive value enables them.
- 2026-09-12: Context-window enforcement and summarization percentage are the only exceptions to the zero-disabled limit policy.

## Sources

The 2026-09-11 rules implement “good out of the box, everything overridable.”
The 2026-09-12 rules govern session turn and USD limits in programmatic and
console surfaces without changing the existing context-window safeguards.
