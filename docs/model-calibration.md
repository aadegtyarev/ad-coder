# Model calibration

This document records accepted-result evidence used to seed and refine each
model inventory's `(role, complexity)` routing. Quality gates are invariant;
the objective is the lowest total provider cost and wall time through accepted
implementation, including repair and re-review.

## Evaluation corpus

Keep versioned realistic fixtures in `evals/fixtures/`, tasks and expected
surfaces in `evals/tasks/`, headless execution in `evals/runner/`, and
machine/independent-review scoring in `evals/scorers/`. Raw provider output and
run state belong in gitignored `.ad-coder/evals/`. Cover planning localization,
research evidence, seeded security defects, three coding complexities, hidden
review regressions, orchestration choices, and summarizer fact retention.

The first executable scorer is `bun run calibration:score -- <task.json>
<ledger.jsonl> <checks.json> <inventory> <duration-ms> <thinking-level>`. It consumes the real
safe ledger and emits one machine-readable measurement. `costEfficiency` is
quality points per provider dollar; it is diagnostic only (and `null` for free
runs). Routing requires full acceptance and zero escaped defects before cost or
wall time can break ties.

The initial `reviewer-hidden-regression-v1` fixture contains two seeded defects
and one tempting false positive. Its scorer derives check results from stable
finding codes. This keeps grading independent of prose and lets the same task be
repeated across every model in an inventory.

Run each corpus task at least once as its declared mode: a standalone `run_role`,
manual `run_step`/`choose_transition`, or complete `run_pipeline`. Repeat samples
before changing defaults. The Orchestrator receives this same rule: inventory
selects the available provider/account model set, while task complexity selects
a route inside it.

## Sampling policy

Before the first run for an unfamiliar inventory, Researcher records three kinds
of evidence: provider guidance, provider-published benchmarks, and independent
benchmarks. Use them only to seed a falsifiable `(role, complexity)` matrix; they
do not outrank accepted-result measurements from this corpus.

Start with the cheapest plausible model in every role at `low` effort. Assign
provisional role/complexity cells from accepted-result samples. Test `medium`
only for boundary cells
where `low` misses a gate or repair and re-review erase its price advantage;
compare an adjacent model only when results are close or unstable. Reserve
`high` for diagnosing difficult failures. This keeps calibration bounded while
still allowing effort to move when it lowers total accepted-result cost.

Persist the corpus-calibrated inventory as user configuration so it can seed
multiple projects for the same account/provider. Persist later project evidence
as an explicit `.ad-coder/` override layered over that base. Never rewrite the
user baseline from one project's observations, and keep the effective source of
every routing cell visible in resolved configuration.

Prefer different model families for Coder and Reviewer when the selected
inventory offers them: correlated blind spots are part of accepted-result risk.
For a single-family inventory such as a Codex subscription, seed the pair from
the provider's role recommendations (for example Sol as Coder and Terra as
Reviewer), then verify it with the same corpus and gates. The user, not the
router, defines which models and providers the inventory contains.

For every sample record the inventory, model, role, assigned and observed
complexity, outcome, escaped defects, repair/re-review rounds, duration, model
and tool turns, fresh/cache/output/reasoning tokens, provider cost, and ceilings.
Do not compare models from different tasks as if they were a controlled result.

## Initial dogfood observations — 2026-09-13

These runs establish ceiling and behavior hypotheses; tasks differed and they
are not a leaderboard.

| role/model | task/outcome | responses | fresh/cache input | output/reasoning | cost | observation |
|---|---|---:|---:|---:|---:|---|
| Planner/Luna | model-inventory design; usable complex/elevated plan | 10 | 68,766 / 148,992 | 4,329 / 1,398 | $0.021928 | 24 tool turns was too low; plan was useful after resume |
| Coder/Sol | model-inventory implementation; incomplete, finished manually | 20 | 94,797 / 997,504 | 8,655 / 1,913 | $1.232387 | spent over 1M input mostly on reconnaissance and did not integrate CLI |
| Reviewer/Terra | broad inventory review; found two atomicity blockers across focused passes | 14 | 63,341 / 394,240 | 4,921 / 1,649 | $0.264582 | high recall, but 240k and 350k input ceilings were too low |
| Reviewer/Luna | final narrow atomicity recheck; approved | 8 | 17,390 / 40,960 | 1,534 / 660 | $0.006138 | 16 tool turns was too low; completed cheaply after resume |

Current hypotheses: Luna is viable for bounded planning/security/re-review but
needs task-specific tools or a tool ceiling above 16–24. Sol is not justified as
the default Coder for configuration-heavy work under the current reconnaissance
prompt/tool boundary. Terra remains the broad-review baseline until controlled
fixtures measure Luna's escaped-defect rate. Project observations supersede
these hypotheses as comparable samples accumulate.

### Controlled fixture sample

On the initial non-Git draft of `reviewer-hidden-regression-v1`, DeepSeek Chat
accepted all three checks in 27.387 s: 11 model turns, 16 tool calls, 5,270 fresh
input, 43,392 cached input, 3,217 output tokens, and $0.007999. GPT-5.6 Luna did
not finish: it reached the 32-tool ceiling after about 100 s with 7 model turns,
19,372 fresh input, 26,112 cached input, 2,168 output, 742 reasoning tokens, and
$0.006998 partial cost. Treat this as harness evidence only: the fixture was then
corrected to materialize a real Git baseline plus diff, which the Reviewer prompt
expects. Repeat both models on the corrected fixture before changing defaults.

### First automatic Codex profile run

`pipeline-repair-regressions-v1` ran with every role at low effort, Sol for
Planner/Security/Coder and Terra for Reviewer. It completed two rounds without
acceptance: 465.587 s of recorded stage time, 88,940 fresh input, 283,520 cached
input, 16,541 output, 6,577 reasoning tokens, and $0.831816 total provider cost.
Planner classified the task medium/elevated. Security found all seeded issues.
Coder repaired the behavior in round one, but Terra's revert-and-restore check
showed that the four tests did not fail against the defective implementation.
Round two added 11 tests and mutation evidence; Terra still rejected because the
fixture exposed no configured test command to its chosen runner. The independent
machine scorer gave the implementation 0.9 quality: all three behavioral checks
passed and only test discovery failed.

The run led to fixture fixes: a standard `test` script, repository-wide test
discovery, runtime-state exclusion during materialization, and a project contract.
A follow-up Planner attempt then exposed two harness issues before coding: Sol/low
hit a 300 s stage limit and repeated reconnaissance after resume, then produced
`research_required`; the Researcher result was rejected, and the CLI could not
authorize `resumeResearch`. The accepted-result cost is therefore still unknown.
Do not change the routing matrix from this single failed sample. It does justify
testing a cheaper Planner first and fixing research recovery before another full
matrix run.

A later retry-capable run reached two complete review rounds and passed all four
machine checks for $0.704820, but independent Terra review correctly rejected
the regression proof: materialization kept the safe implementation at HEAD and
placed seeded defects only in the working diff, so restoring HEAD could never
reproduce the defect. Full-pipeline calibration now uses `--commit-defect`; the
original diff mode remains for standalone Reviewer calibration.

With the corrected committed-defect baseline, Luna low handled Planner,
Security, and Coder while Terra low independently reviewed. The run was accepted
in one round and passed all four machine checks: 170.9 s, 58,140 fresh plus
58,880 cached input, 6,687 output, 2,367 reasoning tokens, and $0.078138 total.
This seeds medium behavioral repair with Luna for those three roles and Terra for
Reviewer; broader task classes must pass before this becomes a general default.
