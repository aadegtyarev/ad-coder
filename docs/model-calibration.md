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
<ledger.jsonl> <checks.json> <inventory> <duration-ms> <thinking-level>
[report.json]`. It consumes the real safe ledger and emits one machine-readable
measurement. Both complexity votes come from that optional observed report, never
from an argument: an operator who types the tier the run was supposed to produce
scores their own expectation, not the run. `costEfficiency` is
quality points per provider dollar; it is diagnostic only (and `null` for free
runs). Routing requires full acceptance and zero escaped defects before cost or
wall time can break ties.

The initial `reviewer-hidden-regression-v1` fixture contains two seeded defects
and one tempting false positive. Its scorer derives check results from stable
finding codes. This keeps grading independent of prose and lets the same task be
repeated across every model in an inventory.

**Match those codes on meaning, not spelling.** The task prompt asks for
"concise stable defect codes" and deliberately supplies no vocabulary, so each
model invents its own: one sweep of six models produced four spellings of the
same path-traversal finding. An exact-match code list therefore measures
spelling luck, and it scored three reviews that found every seeded defect with
executed evidence — and correctly refused the false positive — at 0.2. The
scorer now reduces a code to its word tokens and requires a PAIR of words that
together name the specific defect, so an adjacent-but-vague finding still fails
and a non-blocking one still does not count. When adding a scorer, budget for
this: the check must recognise the defect a model describes, not the label it
happened to choose.

The version-one corpus manifest now contains twelve tasks, and every role the
CLI can dispatch is represented: trivial bounded normalization in three
languages, medium behavior-preserving refactoring, hidden-defect review, medium
pipeline repair, complex concurrent-state repair, manual orchestrator tool use,
plan-carries-the-contract, threat-modelling a plan, contract-conformance
auditing, and a research question whose third part asks about something that
does not exist. The four role tasks each plant a tempting wrong answer -- an id
that is validated before it reaches the filesystem, an authorization door that
is genuinely closed, an HTTP header nobody ever standardized -- so a model that
pattern-matches scores strictly worse than one that reads.

`bun run calibration:corpus -- smoke` exercises every scorer in the manifest.
Target-based scorers run against a materialized fixture. Artifact- and
report-based scorers have no fixture to read, so each such task ships two
checked-in sample answers under `evals/samples/`: `<task-id>.pass.json`, which
must score every check, and `<task-id>.fail.json`, which must miss at least one.
The failing sample is the half that matters -- a scorer stuck at `true` reports
every model as perfect, and without a negative case nothing notices. `bun test`
runs this smoke, so a scorer that stops discriminating fails CI rather than
wasting a live calibration run. Measurements retain the orchestrator and Planner complexity
votes plus correctness and agreement, so live Planner feedback can calibrate
project-local triage without silently changing the user baseline.

Two scorer design notes follow from an independent review of the role tasks.

`planner-contract-carry-v1` verifies a carried rule against the fixture's own
contract file rather than scoring its words. A keyword bag is satisfied without
doing the task: boilerplate assembled from the expected vocabulary and sourced to
"made up" scored full marks, and so did pasting the whole contract file. A carried
rule is a quotation, so it must be findable in the file it cites, and a separate
check asks whether only the applicable rules arrived -- a Coder handed every rule
has been told which ones matter no more precisely than by the path alone.

`researcher-absence-claim-v1` names its citation check
`cites-a-well-formed-source`, not `cites-a-fetched-source`. The scorer receives
the artifact and nothing else, so it cannot distinguish a retrieved page from an
invented one; the old name claimed a verification it never performed and would
have credited a fabricated citation as evidence of research. Where a check can
only see shape, it says so.

`bun run calibration:corpus -- run <task-id>` executes one task for real: it
materializes the fixture, invokes ad-coder in the task's declared mode
(`ad-coder role`, `ad-coder drive --auto`, or a scripted `ad-coder console
--json` session), reads the ledger from the path the front printed, scores it,
and emits the measurement. Nothing about the result is supplied by whoever
started it.

What the run is allowed to claim is bounded by what it can observe. A ledger row
stepped `role:<name>` is the only proof a role was independently delegated —
console JSON carries tool NAMES without arguments, so it cannot distinguish one
delegated role from another. Cost is attributed per `(role, model)` pair from
ledger-record position, so a multi-role run reports every model's share rather
than crediting whoever took the first turn.

A task's `complexity` is passed to the run as `--default-complexity`, so the
cell being measured is the cell the task declares. Until 0.13.3 it was not, and
every task routed at the built-in `medium`: a trivial task's measurement was
labelled `trivial` while the work had been done by whatever model the medium cell
named. A caller who wants a task run against a neighbouring cell still can, by
passing the flag after `--`, since the later occurrence wins.

A task's `role` is its dispatch label, not necessarily a ledger role: a pipeline
task dispatches as `pipeline`, while its rows are stamped with the workers that
took the turns. Such a task declares `measuredRoles` — the ledger roles whose
model the measurement names — and the corpus runner refuses to load an
`automatic-pipeline` task without it. A single-role task omits the field and
falls back to its `role`, which its rows do carry.

## Where a task's shape comes from

A bench task is only as honest as the problem it poses. Inventing eight problems
from taste produces a corpus that measures how well a model matches the taste of
whoever wrote it, and it drifts the moment a new task is added by someone else.
So every task records where its SHAPE came from, in a `source` field carrying a
URL and the source's licence.

`source` is provenance, not attribution of code. The corpus adapts the FORM of a
published benchmark problem — the defect class, the acceptance question, the way
the failure is made observable — and writes its own fixture and prompt against
this project's languages and contracts. It does not copy content. That
distinction is what makes the field safe to require: a task whose shape follows a
GPL-2.0 benchmark carries the link and the licence name, and still ships no line
of that benchmark's source.

Surveyed as shape sources, with the licence that governs reuse:

| Source | Licence | What it is good for |
| --- | --- | --- |
| [QuixBugs](https://github.com/jkoppel/QuixBugs) | MIT | Single-line defects with a known correct fix — trivial Coder cells. |
| [NIST SARD / Juliet 1.3](https://samate.nist.gov/SARD/) | Public domain (US Gov) | Seeded vulnerabilities by CWE — Security role, per-class. |
| [CWE](https://cwe.mitre.org/) | MITRE terms of use | The vocabulary a Security finding must name, not a task source. |
| [SWE-bench](https://github.com/princeton-nlp/SWE-bench) | MIT (harness) | Issue-to-patch shape for pipeline tasks; instances come from their own repos' licences. |
| [openai/simple-evals](https://github.com/openai/simple-evals) | MIT | Factual-lookup grading shape — Researcher confidence grading. |
| [OWASP BenchmarkJava](https://github.com/OWASP-Benchmark/BenchmarkJava) | **GPL-2.0** | True/false-positive discrimination design. **Form only — no code, no test text.** |
| [CodeReviewer](https://github.com/microsoft/CodeBERT) | MIT (repo); dataset under separate Zenodo terms | Review-comment framing; the dataset itself is not vendored. |

The decision that follows from the table: **adapt forms, never copy content.** A
GPL-2.0 source can inform how a discrimination task is posed without any of its
text entering this repository, and that is the only use made of it. Where a
task's shape is original to this project, `source` says so explicitly rather than
being omitted — an absent field would be indistinguishable from an oversight.

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

### Expanded corpus samples — 2026-09-13

On `trivial-normalize-v1`, Luna low Coder passed all three machine checks and an
independent Terra mutation review with no repair. Coder cost was $0.00380988;
Terra review cost was $0.03120320, so full accepted-result cost was $0.03501308.
This makes review routing, rather than coding, the dominant trivial-task cost.

On `refactor-config-v1`, a manually driven Luna Planner → Luna Coder → Terra
Reviewer workflow passed all four corrected machine checks and independent
review in one coding round. Successful stages reported $0.07620220, but a
paused first Planner attempt added $0.00690724, making actual cost $0.08310944.
The run used 67,505 fresh, 89,600 cached, 8,349 output, and 3,400 reasoning
tokens. The discrepancy is harness evidence: resumed attempts must remain in
terminal metrics and accepted-result economics.

On the corrected `reviewer-hidden-regression-v1` Git diff, Luna low found both
seeded blockers and avoided the tempting false positive: 59.36 s, 9 model turns,
17 tool turns, 15,013 fresh plus 18,432 cached input, 2,365 output, 1,044
reasoning tokens, and $0.00620924. This supports Luna for bounded review, but the
first sample is insufficient to replace Terra for complex or broad review. The
run also exposed an invalid scorer assumption that models would guess hidden
exact defect codes; the scorer now accepts equivalent stable codes and the CLI's
documented trailing cost line.

On `complex-reservation-v1`, the first Luna Planner → Sol Coder ⇄ Terra Reviewer
automatic run exhausted two rounds despite passing the original 5/5 scorer.
Terra found negative and then NaN constructor-capacity holes. A continuation run
closed both and was approved in one round; the strengthened scorer passes 6/6.
Across both runs: 607.10 s of stage time, 152,680 fresh plus 223,744 cached input,
17,995 output, 8,621 reasoning tokens, and $0.83711116. Both Luna Planner samples
classified the corpus-labelled complex task as medium, so complex planning moves
provisionally to Terra. Sol remains the complex Coder candidate, while Terra is
retained for medium/complex review. The committed `codex-5.6-calibrated` snapshot
uses Luna for trivial/bounded cells and medium coding, and Sol for deep research
and complex coding; cells without controlled role samples remain hypotheses.


On a repeated `pipeline-repair-regressions-v1` sample, Sol low Coder with Terra
low Reviewer was accepted only after three coding rounds. All four machine checks
passed, but Terra twice found regression tests that did not independently fail
against HEAD. The eight stages used 439.54 s, 121,506 fresh plus 189,056 cached
input, 15,655 output, 7,607 reasoning tokens, and $0.69747004. Sol coding alone
cost $0.4120 and did not reduce review rounds, so medium coding stays on Luna low;
Sol remains only the complex-coding hypothesis. Two retry handoffs fell back from
incremental projection to full context, so projection failure is a separate
harness cost defect. The task prompt now names its existing canonical contract
and requires independently executable HEAD-failing tests, preventing Planner
surface-name drift and masked assertions from consuming calibration rounds.


A focused-handoff regression reran the same repair shape with Luna low Coder and
Terra low Reviewer after allowing bounded untracked paths to remain incremental.
It passed all four scorer gates and was approved after three rounds: 360.85 s,
92,696 fresh plus 177,664 cached input, 14,759 output, 6,577 reasoning tokens,
and $0.24770508. Every retry Coder and Reviewer stage reported `focused` with no
fallback. This sample validates context transport, not general model capability:
the task prompt names known edge cases, so routing conclusions continue to rely
on hidden and holdout tasks.

An unprompted Orchestrator holdout asked Sol low to perform the bounded
`refactor-config-v1` change. It chose the automatic pipeline, which passed all
four scorer gates and Terra review in one round, then redundantly reran tests,
read three files, and checked the diff. The child pipeline used 144.32 s, 79,716
fresh plus 118,272 cached input, 5,711 output, 1,417 reasoning tokens, and
$0.21419568. Orchestrator added 8,268 fresh plus 9,600 cached input, 661 output,
115 reasoning tokens, and $0.06597000, for $0.28016568 total. The result was
correct but the route and duplicate verification were inefficient for a bounded
refactor. Orchestrator now treats a terminal approved report with named passing
checks as sufficient evidence unless it is missing, stale, or contradictory.


### Polyglot holdouts — 2026-09-13

Two repository-independent trivial repairs extend the corpus beyond TypeScript.
For Python stable label normalization, Luna low Coder passed all five machine
checks and Terra low approved independently: 74,515 input, 3,991 output, 1,896
reasoning tokens, and $0.06893012 total. For Rust Unicode-safe prefixing, the
same pairing passed all four checks and independent review: 46,404 input, 3,062
output, 1,470 reasoning tokens, and $0.06204084 total. Both completed in one
coding round.

Luna is therefore the supported trivial Coder default across TypeScript,
Python, and Rust samples. Terra remains a reliable Reviewer, but its share was
91% of Python cost and 95% of Rust cost. This supports an adaptive compact
review path for truly trivial tasks after risk classification; it does not
support removing independent review from security-sensitive or broad changes.

### Background observability dogfood — 2026-09-13

A natural complex lifecycle task exposed a stale cross-process read in the new
background runner. Terra Planner classified it complex correctly. Two Sol low
Coder rounds cost $2.251194 and both closed without verification; the second
also printed intended tool calls instead of executing them. A focused Terra low
Coder continuation cost $0.45419120 and delivered more working integration per
dollar, though closeout still needed narrower follow-ups. Luna low efficiently
handled a mechanical cleanup for $0.02681112 but made an unexecuted docs claim.

Terra Reviewers cost $1.10295040 across four passes and found every material
cross-process, queue-bound, escape-injection, polling, integration-test, and docs
blocker. The accepted result used 893,998 fresh plus 3,685,376 cached input,
69,963 output, and 28,979 reasoning tokens for $4.47404352. Complex Coder routing
moves from Sol low to Terra low; Sol remains reserved for broad Researcher work.
The run also confirms that long work needs detached lifecycle notices rather
than an orchestrator turn waiting on the pipeline.
