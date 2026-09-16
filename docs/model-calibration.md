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

`bun run calibration:corpus -- run <task-id> --repeat N` runs a task N times and
reports the spread rather than one number. One run does not measure a model, it
samples one: the same model on the same reviewer task produced 0.43, 0.79, an
unreadable answer and 1.00 in a single sitting, so a cell decided from any one of
them was decided by which run came first. A later five-run repeat on the same
pair reported four accepted of five, worst 0.47 against a mean of 0.89 -- the
mean is the number that reads well and the worst is the one an operator lives
with, so both are printed. The per-run measurements are kept in the summary, and
the `harnessOutcome` tally says how many runs reached a scored answer at all.

No routing cell should move on a single run. Repeats cost what the task costs:
those five runs came to two cents.

An artifact-scored task may also ship `.gamed.json` beside its pass and fail
samples. The other two prove the scorer can tell a good answer from a bad one;
this one proves it resists the SPECIFIC evasion the task was built to catch --
the plan that pastes a whole contract file, the review that lists its
suspicions. It must score at most two thirds of the task's weight. Not zero: a
plausible evasion answers the rest of the task properly, and demanding it score
nothing would only select for implausible samples.

Every scorer comment explaining why a check works the way it does is a claim
that a defence holds. Until this sample existed those claims were prose, and
three of them proved wrong the first time they were executed -- including a
precision check written an hour earlier, whose weight let six findings instead
of two cost an evasion only fourteen percent of the score. The sample is how a
claimed defence becomes a run.

A task declares what it is FOR, in `purpose`. A `calibration` task may move a
routing cell. A `smoke` task is kept because it proves the harness still
dispatches a role, materializes a fixture and scores a diff end to end, and its
result is never evidence about a model.

The distinction is needed because a saturated task looks exactly like a good one
from outside. The three trivial coder tasks scored nine of nine at quality 1.00
for the cheapest model on the provider -- which says nothing about that model
except that it is not broken, and would have justified routing a whole tier on a
measurement that cannot discriminate within it. They are now labelled `smoke`,
and `bun run calibration:corpus -- smoke` reports the two counts separately so a
sweep cannot quietly total them together.

Labelling is the cheap half. The other half is not quoting a smoke task's score
when a routing decision is being argued.

`refactor-config-v1` is `smoke`, and how it got there is worth recording. The
health check flagged it as saturated, and the flag was right for the wrong
reason: its five samples had all measured one orchestrator model rather than
three coders, because the task ran as `manual-workflow` and the orchestrator
simply did the work itself -- no coder turn was ever taken, and `model` came back
`null` because the measured role never appeared in the ledger. Its
`extracts-shared-parser` check was also weighted 2 against the two
API-preservation checks' 7, so an answer that kept the duplication and broke
nothing scored 7 of 10.

Run as a `role` task with the extraction weighted 5 of 13, all three models still
score 1.00, so the saturation is real. The lesson is the flag's: a task that
names a role must dispatch it, and a verdict worth acting on is worth checking
before acting.

`planner-absent-artifact-v1` asks for a plan against two documents that do not
exist, in a fixture that is otherwise real. The honest answer reports the block,
names BOTH absent documents, proves it looked by naming what it did read, asks
for something specific, and writes no steps for the spec nobody wrote. Public
benchmarks reward answering rather than asking -- an exact-match grader scores a
clarifying question as zero -- so this shape is written here rather than adapted.

It is `smoke`, not calibration, and the reason is worth stating. Every model
tried scores 1.00, which this document's own saturation rule says is a task that
does not discriminate. The likely explanation is that it measures whether the
role prompt's own instruction -- mark a surface `research_required` rather than
guess -- is being followed, and it currently is, by everyone. That is worth
guarding and not worth quoting: a model that begins inventing a plan for a
missing document is caught the day it does.

`orchestrator-decompose-v1` measures the operation the orchestrator is expected
to perform on a real ticket: turn it into issues someone can pick up. Its six
requirements each carry a trap that decomposition actually fails on. One is
already satisfied by the fixture's code, so a decomposition that schedules it is
scheduling work that is done. One is phrased with an "and" and is nevertheless a
single requirement -- a rate limit that does not reject is not a limit -- so a
model splitting on the conjunction produces an issue nobody can finish. Two
adjacent requirements sound like one topic and are separately shippable. And one
pair carries the only real ordering constraint among several that merely sound
related.

The checks ask for those properties rather than for one correct answer, which is
deliberate: a live run grouped two requirements the task does not require apart,
and scored full marks. A decomposition has many right shapes and a few wrong
ones, and only the wrong ones are worth scoring.

**What the field already knows, and what we were reinventing.** A research brief
commissioned on 2026-09-16 (`benchmark-scoring-research.md`) settled several
things this document had been asserting from taste. Three matter enough to state
here.

*Judging a cell on its worst run has a name.* It is `pass^k`, introduced by
τ-bench and adopted by Terminal-Bench, CORE-Bench and others -- requiring all k
trials to succeed is the same thing as scoring the minimum. The practice was
right; calling it by its name makes it citable instead of a preference.

*Three repeats is too few.* Terminal-Bench, FrontierCode and SWE-Doctor each
independently settled on five runs per cell. Our three came from a budget guess.

*A task every model fails identically is a defective task, and that is the
published position, not a hunch.* The ABC audit states it directly, the
item-response literature names near-zero or negative discrimination as the
signature of a wrong answer key, and a unanimous agent failure is recommended as
a quality-control step in its own right. This project reached the same
conclusion twice by hand, on `planner-contract-carry-v1` and on
`coder-retention-v1`, before knowing it had a name.

The gap that matters most is in the other direction. Every artifact task here
ships a `.gamed.json` -- the cheating answer that must fail -- and none ships its
mirror: a *different but equally valid* answer that must pass. FrontierCode calls
the pair a hack report, and the missing half is exactly what let
`coder-retention-v1` ship a fixture that argued against its own scorer. Terminal-
Bench's acceptance criterion says it as an iff: the scorer passes if and only if
the artifact is acceptable, which means the task must describe every acceptable
end state and the scorer must accept every one of them.

One number from that research is worth keeping in view. Terminal-Bench spends
about three hours of combined expert review per task, and its v2.1 release still
fixed defects in 28 of 89 tasks. SWE-bench Verified put 93 developers and three
independent reviews across 1,699 samples, discarded 68% of them, and an audit
still estimated 5-10% of the survivors flawed. Task defects are the normal
condition of a benchmark, not evidence that its author was careless -- which is
the argument for finding them by running the thing rather than by staring at it.

`coder-retention-v1` measures the coder at medium complexity, the cell the
corpus could not measure at all once `refactor-config-v1` saturated -- the
busiest cell in real use, and the one where the routing decision has the most
money in it. Four surfaces spread across four modules answer the same retention
question four ways, and the correct answer is split between a contract file and
a checked-in test the contract never mentions. So the majority behaviour is
wrong, and a model that carefully preserves what the code does today fails: the
committed rule outranks the status quo, which is this project's own priority
rule.

Its first version is the more useful half of the record. Three surfaces in one
file, both rules stated plainly in the contract, and glm-5.3-flash -- the
cheapest model on the provider -- scored 1.00 twice. That is the saturation
signature, caught before the task was committed rather than after it had been
quoted in a profile. Rebuilt with the rules split across two sources, the callers
crossing module boundaries, and a fourth surface violating a contract line nobody
thinks to check, it separates four models across two vendors: 0.78-0.88 for the
cheapest with nothing accepted, 0.94-1.00 for the dearest. Eight cents.

`planner-contract-carry-v1` is the standing example of a task scoring its
author. Six models across four families and two vendors scored 0.82 by failing
one check identically -- and the most expensive scored lowest, the inverted
signature the health check calls broken rather than hard. Three separate defects
hid behind one number. The fixture's third rule governed identifier validation
while the change reads a report by id, so carrying it was a defensible reading.
The check demanded the carried set be exactly two rules, so a plan that also
carried a real invariant it had read in the code was marked wrong for good
planning. And verification demanded a verbatim contract quotation from an entry
sourced to the code, where no verbatim text exists.

Each fix narrowed what the check asserts. The rule is now plainly inapplicable to
the change; the check forbids carrying that rule rather than forbidding anything
unlisted; and verbatim matching applies only where a plan claims to be quoting a
file. The lesson is worth more than the fix: when a check and a model disagree,
read the model's reasoning from the artifact before concluding the model is
wrong. Six models agreeing with each other and disagreeing with the check is
evidence about the check.

`bun run calibration:health` reads the recorded evidence and names any task that
has stopped telling models apart. Two signatures, meaning opposite things.
**Saturated**: every model of every price is accepted, so the task does not
measure the difference a routing decision needs and quoting it in favour of any
model quotes nothing. **Inverted**: quality falls as price rises, which is not a
hard task but a broken one -- an expensive model has no reason to do worse unless
the checks are scoring something other than capability.

Both of this project's task defects were found by a person reading a sweep
printout. Both were visible in the numbers, so neither should have needed one.
The check reports rather than fails: the evidence is observational, a sweep may
cover two models one week and six the next, so a finding is a question put to
whoever reads it rather than a gate on sample size.

**A failure is data, not an exception.** One shape of bug appeared three times in
one day, in three unrelated places, and each time it destroyed measurements
rather than recording them: a scorer threw on an answer it could not read, so the
run left the sample -- and the runs it lost were the bad ones, which flattered
the model; the runner could not say whether a zero came from a wrong answer or a
broken tool, so both were the same number; a repeat series lost four finished
measurements when its fifth run hit a stage limit, failing exactly where repeats
matter most.

The common cause is treating something unexpected as a reason to stop rather than
as something to write down. So, wherever this pipeline meets the unexpected, the
question is not how to abort but what to record. A scorer that cannot read an
answer fails every check. A run that never reached a scored answer is named in
`harnessOutcome`. A repeat series reports what aborted and continues. The next
instance of this will be somewhere nobody is looking, and the rule is what
catches it.

Every measurement carries a `harnessOutcome` beside its `quality`, because the
two answer different questions. A `quality: 0` from a model that answered badly
and a `quality: 0` from a tool that refused, a stage that ran out of time, or an
answer no scorer could read are three different facts, and one number cannot tell
them apart. The last two are evidence about the harness rather than the model, so
a sweep that cannot separate them reports the model as worse than it is -- or,
while unreadable answers were being dropped from the sample entirely, better.
`clean` means the run reached a scored answer with nothing to report; the other
values name what intervened. Sweep summaries should be read stratified by it.

A check must score something the task asked for. `planner-contract-carry-v1`
failed 20 runs out of 20 across five models and four families -- and the ranking
inverted, the most expensive model scoring worst -- which is the shape of a
broken task, not a hard one. Two of its checks scored unstated requirements: one
demanded that only the applicable contract rules be carried while the prompt
asked merely for "the short rule text", and the other expected an
`evidenceRating` of `asserted` on a task that adds a feature, while the rating's
definitions are written around a defect that exists. Both are now stated in the
prompt. The lesson generalises: when every model fails a task the same way, read
the task before reading the models, and treat an inverted cost ranking as the
signal that the measurement has stopped being about capability.

**Every target-scored task also scores what the model touched that nobody asked
about.** The task declares `writes`, an allow-list of path globs, and a
`stays-in-scope` check; the runner snapshots the target before the run and after
it and fails the check when anything outside the list was added, rewritten or
deleted. The offending paths are reported in the measurement as `strayPaths`,
because the target directory is deleted before anyone reads the score.

Until this existed, a model that fixed the named function and also pulled in a
logging framework, reformatted a neighbouring module and left a scratch file
behind scored a clean 1.00 in every task here. Scope creep is among the most
expensive things an agent does to a real codebase -- it inflates review and mixes
unrelated risk into one change -- and `reviewer.md` treats it as blocking, so a
bench that could not see it was selecting for it. The prompt states the
constraint too: a requirement scored but never stated is the
`planner-contract-carry-v1` mistake.

Three things it deliberately does not charge to the model. The `.ad-coder/`
directory, which the harness itself writes into every target. Anything the
fixture's own `.gitignore` covers, which is how `target/` for Cargo and
`__pycache__` for Python stay free for a task that asks the model to run its
tests. And a fixture's seeded defect, when it ships as an uncommitted change so
the role under test can read it as a `git diff` -- which is why the comparison is
against a snapshot taken after materialization rather than against the baseline
commit.

**A task may also forbid a tool, and the ledger says whether it was used.** The
task declares `forbids` beside a `honours-prohibitions` check, and the runner
reads the tool names every ledger row already carries. `security-plan-threats-v1`
forbids `bash`: its role prompt says not to run the project's test suite, and a
threat model is a reading task.

A prohibition is usually in a prompt because obeying it is *inconvenient* --
running the tests would be reassuring, re-reading would feel thorough. So
ignoring one is a distinct trait from being wrong: invisible in the answer's
quality, and exactly what makes an agent unusable in a real workflow, because the
constraint you were relying on silently stops holding. It also costs money a
routing decision is trying to optimise.

The limit is worth stating plainly. The ledger records tool NAMES and counts,
never call arguments, so "did not run the test suite" is only answerable as "did
not call `bash`". A task may therefore prohibit a tool, never an intention -- and
must say so in its prompt, in those words, because scoring a rule the model was
given only in its role prompt punishes it for a context it was never shown.

**A prose bracket is not an answer.** The artifact extractor took the first `[`
or `{` in the output and read from there, which assumes no prose before the
answer contains one -- and prose about code routinely does. A live planner
explained an id format as `[a-z0-9-]` above its plan; the extractor returned that
character class as the whole answer, no scorer could read it, and a run that
passed every check was recorded as `unreadable_answer` at quality 0.12. That is a
model failure the harness invented, which is the one error this pipeline must not
make. Each bracket is now tried in turn and the first span that both closes and
parses is the answer; a span that parses *inside* an earlier unclosed one is
treated as truncation rather than as a brief answer.

**A claim is checked against the fixture wherever a claim is checkable.** The
artifact-scored tasks read the JSON the model asserted, so a confident,
well-formed, wholly invented answer scored exactly as well as one that did the
work: an auditor could cite a contract file that is not in the repository, a
reviewer a line number past the end of a seventeen-line file, a security answer a
step of a plan that has three. Each of those is the one part of the claim that is
mechanically checkable, and each is now checked -- `cites-only-real-material`,
`cited-lines-exist`, `cites-only-real-plan-steps`, joining
`planner-contract-carry-v1`'s verification of a carried rule against the real
contract text.

Over-claiming matters more here than its size suggests, because it propagates: a
fabricated citation becomes the next role's justification, and a bench that
cannot see it will route a confident fabricator into every cell. What is *not*
checked is stated too -- a reviewer naming a command and its output is giving
equally good evidence, so only `path:line` citations are verified; the point is
to catch an invented location, not to demand one. The researcher's fetched URLs
remain unverifiable for the reason #141 records: the ledger carries tool names
without arguments, by design.

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
