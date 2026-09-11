# Configuration contract

Rules the operator declared for ad-coder. A violation is always blocking.

- 2026-09-11: A value a user might reasonably want to change is a configurable
  setting with an efficient default — never a hardcoded constant. Judgement call:
  would a reasonable user want to turn this knob? If yes, it is config.
- 2026-09-11: Ship opinionated, maximally-efficient defaults, but expose the knob
  anyway. The goal is "good out of the box, everything overridable", never
  "configure everything yourself".
- 2026-09-11: The context/compaction strategy is configurable end to end: the mode
  (auto / cache-aware / disabled-then-halt-for-manual-compaction), the budget as a
  percent of the model context window, and the reply reserve. Never hardcode a
  single compaction policy.
