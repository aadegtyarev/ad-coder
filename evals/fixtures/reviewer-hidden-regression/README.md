# Reviewer hidden regression fixture

Synthetic repository change for comparing reviewer models. The candidate must
find both seeded defects without seeing this answer key. The independent scorer
expects stable finding codes, so prose wording does not affect the score.

Materialize it with `bun run calibration:materialize -- <fixture-dir>
<new-target-dir>`. The command creates a disposable Git repository from the safe
baseline and applies `change.patch`, giving every model the same realistic diff.
