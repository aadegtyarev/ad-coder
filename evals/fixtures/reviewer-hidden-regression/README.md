# Reviewer hidden regression fixture

Synthetic repository change for comparing reviewer models. The candidate must
find both seeded defects without seeing this answer key. The independent scorer
expects stable finding codes, so prose wording does not affect the score.

Materialize it with `bun run calibration:materialize -- <fixture-dir>
<new-target-dir>`. The command creates a disposable Git repository from the safe
baseline and applies `change.patch`, giving every model the same realistic diff.
For a coding or full-pipeline sample, append `--commit-defect`: the seeded defect
becomes HEAD so differential regression tests can restore it independently of
the candidate's working-tree repair. Reviewer-only samples should keep the diff.
