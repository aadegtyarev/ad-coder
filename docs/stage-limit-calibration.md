# Stage-limit calibration

Learned stage ceilings from deliberate probe raises — "reconnoitre by fire": raise one bounded
step to answer a question ("does this shape fit at 1.5x?"), observe the outcome, and record the
number that worked. A same-shape dispatch starts from the learned value. Never rewrite a learned
number from a single observation without a second confirming one.

Pre-committed branches for any probe: success → record the number below; failure → **no second
raise** — classify the next snapshot as loop (identical repeated attempts, no progress) vs
too-large (real progress still ongoing), then stop-and-report or decompose instead.

| Stage | Limit reason | Shape | Learned ceiling | Evidence |
|-------|--------------|-------|-----------------|----------|
| plan | duration | slice-planning of one bounded medium slice inside a complex feature | **810000 ms** — 540000 exhausted mid-composition (19 model turns, 432k input, adaptive resubmit in flight); probed 810000, stage completed at **726866 ms** | run `4c26d8d9-f682-4587-8e5e-07f1de1f8e82`, checkpoint `stageMetrics`, 2026-09-18 |

Reading the snapshot — known blind spot: `readFiles` counts full-file reads only; sliced reads
(`read_project`) and searches do not appear. `readFiles: []` is **not** evidence of zero
reconnaissance — the 540s pause above looked like a no-read loop on that field alone and was a
working, composition-underway stage. Diagnosis must weigh fresh-input accumulation and turn pace
before the read count.
