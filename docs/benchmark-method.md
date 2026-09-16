# How to build a bench task, prove it, and route from it

Three procedures, in the order they are used: designing a task, validating it,
and turning its results into a routing decision. Each step exists because
skipping it produced a specific wrong answer in this project, and the failure is
named where it applies — a rule whose cost is invisible gets dropped the first
time someone is in a hurry.

Results live in [model-calibration.md](model-calibration.md), evidence in
[calibration-evidence.jsonl](calibration-evidence.jsonl), and the outside
literature in [benchmark-scoring-research.md](benchmark-scoring-research.md).
This file is the method.

---

## 1. Designing a task

### Decide what the task is for before writing it

A task is `calibration` if its result may move a routing cell, or `smoke` if it
exists to prove the harness still dispatches a role and scores an answer. Label
it, and never quote a smoke task's score as evidence about a model.

A task nobody can fail tells you nothing about which model to buy — but it may
still be the answer to a real question. `reviewer-trivial-v1` and
`security-trivial-v1` are both saturated and both worth having: "on a change
this small the cheapest model on the provider is adequate" is exactly what the
trivial tier was built to establish.

### Write the problem here; borrow only its shape

Adapt the *form* of a public benchmark — its scoring mechanism, its difficulty
definition, its controls — and invent the fixture. This is a contamination
defence, not a licensing hedge: audits of SWE-bench found roughly a third of
"solved" instances carry the fix in the issue text, and a frontier model
identifies the buggy file from the issue alone most of the time. That is
memorisation scoring as skill.

Record where the shape came from in the task's `source`, including `url:
"original"` when the shape is this project's own. An absent field is
indistinguishable from an oversight; a claim someone can dispute is not.

### Make the tier a property, not a feeling

- **trivial** — one file, one function, no call sites, the fix uniquely
  determined.
- **medium** — crosses two or more call sites, or preserves two public
  behaviours under a structural change, or carries a rule into a downstream
  artifact.
- **complex** — requires an ordering or concurrency invariant, or reconciling
  two sources of truth that disagree, or an error introduced upstream and
  observable only downstream.

A trivial task is not a smaller medium one. It still has to measure restraint:
a reviewer that reports two findings on a two-line diff is unusable however
cheap it is, so the fixture keeps a tempting non-defect and the scorer caps what
may be reported.

### Plant the wrong answer, not only the right one

Every role task carries a defect *and* something that looks like one and is not:
an id validated before it reaches the filesystem, an authorization door that is
genuinely closed, an optional parameter documented as optional. A model that
pattern-matches must score strictly worse than one that reads.

### Score properties, not one blessed answer

Decomposition, review and planning all have many right shapes and a few wrong
ones. Score the wrong ones. `orchestrator-decompose-v1` asks whether a
requirement was split that should not have been, not whether the issues match
the author's list — a live run grouped two requirements differently from the
author and was correct.

### Match findings on meaning, never on the author's spelling

The prompts ask for "concise stable defect codes" and supply no vocabulary, so
every model invents its own. One sweep produced four spellings of one finding.
Reduce a code to word tokens, require a *pair* of words that together name the
specific defect, and accept a controlled vocabulary — a CWE id — as an
alternative to any wording.

This is the defect this corpus produces most often. See §2.

---

## 2. Proving the task before trusting it

### Four samples, and the two that matter are not the obvious ones

Every artifact-scored task ships four checked-in answers:

| sample | must | proves |
| --- | --- | --- |
| `.pass.json` | score every check | the scorer can say yes |
| `.fail.json` | miss at least one | the scorer can say no |
| `.gamed.json` | score ≤ 0.67 of the weight | it resists the evasion the design claims to stop |
| `.alt.json` | score every check | it accepts a *different* right answer |

`.fail.json` catches a scorer stuck at `true` — the failure that silently
reports every model as perfect. `.alt.json` catches the opposite and is the one
this project added last and needed most: it found two tasks rejecting correct
answers on the day it was introduced.

Write the alternative by phrasing the answer differently on purpose, not by
restating the pass sample. An alternative written to satisfy the check you just
wrote proves nothing.

### Write the cheating answer and run it

Every scorer comment explaining why a check works a given way is a claim that a
defence holds. Until the evasion is executed, that claim is prose. Three such
claims proved false the first time they were run — including a precision check
written an hour earlier, weighted so lightly that six findings instead of two
cost the evasion 14% of the score.

The ceiling is two thirds rather than zero: a plausible evasion answers the rest
of the task properly, and demanding it score nothing selects for implausible
samples.

### Calibrate live before committing, across families and vendors

Run the task against several models of different families before it enters the
corpus. Two signals that it is broken rather than hard:

- **every model fails identically** — the published position, not a hunch: the
  ABC audit says so directly, and the item-response literature names near-zero
  or negative discrimination as the signature of a wrong answer key;
- **quality falls as price rises** — an expensive model has no reason to do
  worse unless the checks are scoring something other than capability.

Three tasks were rebuilt this way on 2026-09-16, and in every case the models
were right and the task was wrong.

### Read an artifact before concluding anything about a model

When several runs produce the same score, open one answer. Six times in one
session a check was stricter than reality, and the artifacts said so plainly:

- a reviewer coded the seeded defect `primary-write-precedes-metadata` and
  scored zero where `order-reversed` scored full;
- a security answer coded it `failure-response-reveals-storage-layout`, with
  CWE-200 and an exploit naming the report path, and scored zero for omitting
  the word "disclosure";
- a planner carried a real invariant read from the code and was marked wrong for
  carrying more than two rules;
- a coder task's fixture carried a comment calling the rule its scorer required
  a drift from the contract, and four models across three vendors deleted the
  rule and cited that comment;
- a model proved a defect *by evaluating the changed expression* and scored zero
  because the word list lacked "falsy fallback";
- a threat model found a real ownership gap the fixture contained and the author
  had not planted, and was penalised for reporting two threats.

The sixth is the instructive one: the check was right to demand restraint and
wrong about the ceiling, which had been set from what the author imagined the
fixture contained.

### Prove the mechanism the task claims to exercise actually runs

`summarizer-retention-v1` measures what survives context eviction. Its first
version scored 1.00 in three turns because the fixture fit in the budget and
compaction never ran — it would have shipped measuring reading while claiming to
measure retention. A task that depends on a subsystem must observe that
subsystem: the runner now counts compactions and a task may declare
`requiresCompaction`.

### Let the corpus report on itself

`bun run calibration:health` reads the recorded evidence and names tasks that
have stopped discriminating: **saturated** (every model of every price accepted)
and **inverted** (quality falls as price rises). It reports rather than fails —
the evidence is observational, so a finding is a question for whoever reads it.

Both task defects this project found before the check existed were caught by a
person reading a printout. Both were visible in the numbers.

---

## 3. Running a sweep

### Five runs, and judge on the worst

One run samples a model, it does not measure one: the same model on the same
task produced 0.43, 0.79, an unreadable answer and 1.00 in a single sitting, and
`minimax-m3` spans 0.25 to 1.00 across five runs on one task. Any single number
there decides the cell differently.

Five is the convergent choice of three independent benchmark maintainers.
Judging on the worst run has a name — `pass^k`, from τ-bench — so it is citable
rather than a preference. The mean is the number that reads well; the worst is
what an operator lives with.

### Record the provider, not only the model

The same model name behind two providers can differ in supported thinking
levels, context ceilings and what is billed. `deepseek-v4-pro` accepts `low` on
opencode-go and is marked unsupported on openrouter — same vendor, same name. A
measurement published without its provider invites a reader to carry it
somewhere it does not hold.

### Record what happened to the run, beside how good the answer was

A `quality: 0` from a bad answer and one from a refused tool, an exhausted stage
or an unreadable answer are different facts, and the last three are evidence
about the harness. `harnessOutcome` carries that. The rule behind it:

> **A failure is data, not an exception.** Wherever this pipeline meets the
> unexpected, the question is not how to abort but what to record.

One shape of bug appeared three times in one day and each time it destroyed
measurements rather than recording them — and the runs it destroyed were the bad
ones, which flatters the model.

### Never compare models across tasks

A sweep that covers one model on one task and another elsewhere is not a
controlled result. Say so rather than tabulating it.

### Append every run to the evidence file

`docs/calibration-evidence.jsonl` exists so a tier can be revisited against what
was measured rather than re-measured from nothing, and so the data can
eventually be published. A run left in a scratch directory is a run the next
session will not find.

---

## 4. Turning results into routing

### Compare against a reference, in four bands

An absolute `0.78` answers no question anyone is asking. The decision is always
against the best thing you would actually pay for, so the reference model runs
every task, at the effort level it will be used at.

| band | meaning | decision |
| --- | --- | --- |
| `unusable` | not accepted where the reference is accepted | do not route here |
| `risky` | matches at its best, falls well below at its worst | only where a bad run is cheap |
| `equivalent` | indistinguishable within the observed spread | route it — this is the saving |
| `better` | its worst run beats the reference's worst run | route it, and reconsider the reference |

"Worse" and "much worse" were one band wearing two names. `risky` stays separate
from `unusable` because they are different purchases.

The bands are a product decision; no published source defines them. The
statistic underneath need not be: for "is A worse than B given n runs each" at
small n, the named test is **exact McNemar** on the discordant pairs, paired on
the task rather than the run. Add an explicit *unresolved* verdict and publish
how often it fires — a decision rule that never says "I don't know" manufactures
confidence.

### On a subscription, the list price is the wrong number

What a request consumes is a slice of that model's own monthly allowance, so the
comparable quantity is the fraction of the pot, not the dollars. Measured among
the models that reach 1.00 on the coder task: `glm-5.2` is allowanced $60 while
`kimi-k3` and `qwen3.8-max` are $15 — the two that look cheapest per token buy a
quarter of the work. This project recommended `kimi-k3` from a quality table and
withdrew it hours later. See
[opencode-go-economics.md](opencode-go-economics.md) and issue #182.

Listed, allowanced and available are three different states: `gpt-5.6-luna` is
listed with an allowance and answers HTTP 500 on every request.

### Report cost and latency with the band

A model that is `equivalent` at a third of the cost is the answer; one that is
`equivalent` and three times slower is an answer only where nobody is waiting.
`qwen3.8-max` never dropped a run across five and takes 6.5 minutes against 2.5
for `glm-5.2` — two halves of one decision.

### Prefer different families for Coder and Reviewer

Correlated blind spots are part of the risk: the author is blind exactly where
they erred, and a reviewer from the same family may share the blindness. Where
the inventory offers only one family, seed the pair from the provider's own role
recommendations and verify with the corpus.

### Route per role, not per model

`deepseek-v4.1-flash` measured against `v4` on the same four role tasks is
better at review and auditing and worse at threat modelling. A global swap would
have traded one for the other silently.

### Effort is part of the selection

A reasoning model at minimum effort is a different product. Raise effort before
changing model when a cell fails — and when a cell is decided, the reference it
was decided against is a model *and* an effort level.

### Keep the baseline and the project separate

Persist the corpus-calibrated inventory as user configuration so it seeds
multiple projects; layer later project evidence as an explicit `.ad-coder/`
override. Never rewrite the user baseline from one project's observations, and
keep the source of every routing cell visible in resolved configuration.

---

## What this method costs

The full 2026-09-16 rebuild — thirteen models, four vendors, ten tasks, several
tasks rebuilt and re-measured — came to **$3.41 and about 140 minutes** of
machine time. Three tasks had to be rebuilt after live runs because they
measured something other than what they claimed.

That ratio is the argument for the method rather than against it. Terminal-Bench
spends roughly three hours of expert review per task and still fixed defects in
28 of 89 tasks in a point release; SWE-bench Verified used 93 developers and
three independent reviews, discarded 68% of its candidates, and an audit still
estimated 5–10% of the survivors flawed. Task defects are the normal condition
of a benchmark, and they are found by running it.
