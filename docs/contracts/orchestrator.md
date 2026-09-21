# Orchestrator contract

For the operator and for any reader of an orchestrator's behaviour: what the
orchestrator owes a task, from intake to a closing report, and which of those
duties are the project's to configure rather than this text's to fix.

Clauses are numbered `K0`-`K12` and cited as addresses (`K6.5`, `K9.3.2`) by
audits and tickets, so a finding can name the clause it violates. The text is
NORMATIVE: it says how the orchestrator must behave. Where the code disagrees
with it, the code is the defect -- the text is never edited to match a behaviour
(K11.1).

Every clause is an obligation. Where a clause names a mechanism the code does not
have yet, the clause is a REQUIREMENT: its absence from the code is an audit
finding (K11.1), never a reason to soften the text. Terms that carry a project
meaning are fixed by K0; this preamble uses them in their ordinary sense. The
surfaces the clauses name are the project's settings, so what is written about a
setting here is a REQUIRED default (K10.6), not a constant.

- 2026-09-21: **This document is the first version of the orchestrator contract,
  and it is written as a whole** rather than distilled from practice. Its reading
  is therefore: a clause states what the orchestrator owes, the audit that follows
  compares the code against it clause by clause, and the pieces chosen for
  implementation are dispatched out of that audit.
- 2026-09-21: **A contract is reviewed like a contract and not like
  documentation** (`product-change.md`, 2026-09-18): it is the text every later
  reviewer enforces, so changing it changes what "reviewed" means. It lands
  through a branch and a pull request, its own gates, an independent review round,
  and a stamp -- the same path any code change takes.

## K0. Dictionary

- **Operator** -- the human who sets tasks and grants the mandate.
- **Task** -- the operator's request TOGETHER WITH its closing. A task is a
  **series of turns**, not one turn: it opens at intake (K2) and closes with a
  closing report (K1.5, K8.8). It lives across time, survives pauses and
  wake-ups, and is not ended by a new operator message.
- **Turn** -- one orchestrator answer to one input line (an operator message, a
  `/task` line, a service wake-up). One turn is one provider call. A turn is the
  unit of work inside a task, never the task.
- **Run** -- a started pipeline with a durable record (stages, metrics, pauses).
- **Stage / role** -- different sets, not to be conflated. **Roles** are the
  executors: orchestrator, planner, researcher, coder, reviewer, auditor,
  security. **Stages** are the phases of a run; some phases own no role (`gates`
  runs commands, `done` runs nothing). Names come from the code (`src/cli.ts`,
  `src/orchestration/stage-limits.ts`), never from memory: an invented name is
  nothing to search for.
- **Ceiling** -- a numeric limit: `maxDurationMs`, `maxModelTurns`,
  `maxToolTurns`, `maxInputTokens`, `maxCostUsd`, and the task's own budget.
- **Mode** -- `manual` / `auto` (K4), a field of the code (`RunMode`,
  `src/orchestration/control-plane.ts`). The word carries two meanings in the
  project's older text, and both are in `docs/contracts/operation-modes.md`: its
  2026-09-12 entries use `manual` and `auto` as modes, and its 2026-09-17 entry
  calls the **execution world** a mode as well -- "which mode the session is in --
  roles only, roles plus the enabled workflow modules, or direct editing when
  neither surface is registered", quoted to its last clause because that clause
  reaches for "surface" for the thing the sentence has just called a mode, which
  is the collision this bullet names. This
  contract uses "mode" for the `manual`/`auto` axis alone and calls the execution
  world the **surface**; an older sentence that says "mode" for the execution
  world is read as the surface, and the difference is stated here rather than
  left for a reader to guess at. This is a naming discipline, not a claim that
  the older contract used the word only one way.
- **Mandate** -- a recorded ground for acting without asking: an operator command,
  mode `auto`, a default-on flag.
- **Task shape** -- the class of size and complexity that learned ceilings are
  remembered by. The class is derived from what is MEASURED (files and lines
  touched, stages, whether a security surface is involved), never from the task's
  text. Until a dispatch-time tier exists (#460) the key is coarser -- stage,
  role, size -- and that is said plainly rather than passed off as a shape.
- **Artefact** -- a file a fact was read from: the ledger, the coordinator's
  record, a background run's record, a session jsonl, a CI step list.
- **Review stamp** -- a record of approval covering the WHOLE tree: its digest is
  computed over every file, so any change, a rebase included, invalidates an
  earlier stamp. Only a review that ran as a pipeline stage or as a standalone
  round writes one; a role's advice is not a stamp (K5.0.2).
- **Frozen tree** -- the commit (SHA) the gates and the stamp are computed
  against. While it does not move, the verdict and the gates belong to it; a
  rebase freezes the tree anew (K8.11).
- **Lane** -- one stream of work: a branch, its pull request, its worktree and
  its console. "Own" means issued by this orchestrator, "someone else's" means it
  was not; "blocked" means its run stopped and awaits a decision.

## K1. A task always has a state, and the state is named

K1.1. An accepted task is, at any moment, in exactly one of three states: **WIP**
(there is planned motion **or a planned wake-up**; waiting -- K7.5 -- is a
substate of WIP, not a state of its own), **blocked** (the operator's decision is
needed), **closed** (success, failure, or the operator cancelling it -- all three
close with a report, K1.5).
K1.2. The state "quietly stopped" does not exist. If no motion is planned and no
decision was asked for, that is a defect, not a pause.
K1.3. For every task the orchestrator must be able to name: the state, the
artefact that evidences it, and what must happen next.
K1.4. The end of a turn does not change a task's state. An unclosed task is
recovered from durable state, not from session context: a context change, a pause
and a new operator message are neither the loss of a task nor its completion.
K1.5. A task closes with a closing report: what was done, what evidences it, and
**what it cost**. The complete and only normative list of what the report must
carry is K8.8; this clause states only that it is mandatory. Without the cost
report a task is not closed -- a task that failed included.

## K2. Intake

K2.1. Taking a task, the orchestrator names: what counts as done (in its own
words), the current mode, the task shape (size and complexity), the budget it
takes the task on, the ceilings, and what is **not** part of the task.
K2.2. A large task is decomposed by the orchestrator itself. The operator does
not hand-slice briefs, and the orchestrator may not require it.
K2.3. Ambiguities that would change the result are settled before the start, not
after a failure.
K2.4. The budget is agreed before work. The operator names the first number; the
orchestrator either accepts it, answers with a counter-estimate and its evidence,
or honestly admits it does not know and names the range it will work within while
asking for a decision (the task sits `blocked` meanwhile -- it does not proceed
"somehow"). "Let's go and see" is not a budget.

## K3. Turn, continuation, completion

K3.1. One turn is one provider call. A textual report with no following tool call
**ends** the turn: whatever was to be said next will not be said.
K3.2. Unfinished work therefore cannot end in a report. A continuation is either a
call inside the same turn, or the start of a run that has a wake-up path (K7).
K3.3. A turn of work must not require the operator's next message. If the operator
stays silent, the task must advance or explicitly ask for a decision.
K3.4. Continuation is bounded: at most `maxContinuations` in a row (a project
setting, K10; required default `3`, K10.6) and never dearer than the declared
budget; exhaustion moves the task to `blocked` with a question, never into
silence.
K3.5. Continuation is gated by the mode, and the gate is a **boundary of
decisions**, not a ban on moving. What exactly a mode reserves to the operator is
defined by `docs/contracts/operation-modes.md`: in `manual` product and
architecture decisions wait for the operator, in `auto` they are delegated to the
orchestrator and written to durable state. Inside that boundary, in `auto` the
orchestrator continues by itself (K3.4); in `manual` it stops at the first
decision the mode did not hand it.

## K4. Mode

K4.1. The mode is the discrete axis `manual` / `auto`, separate from numeric
ceilings. Its value comes from the project's settings (K10); the default is
`manual`: autonomy is **granted**, never assumed. What each mode reserves to the
operator is described in `docs/contracts/operation-modes.md`; this contract
overrides nothing there -- it adds visibility of the mode (K4.2), switching
(K4.4-K4.6) and the intake clarification (K4.3).
K4.2. The orchestrator **sees** the mode and states it as a fact rather than
guessing at it.
K4.3. Taking a task, the orchestrator names the mode and asks whether to switch
it. The clarification is a setting (K10), on by default, and is asked **once**:
on a project's first task, or when the operator never named a mode. Under a live
`auto` mandate, asking "shall I switch" again is asking for authority already
delegated (`docs/contracts/operation-modes.md`); naming the fact (K4.2) takes its
place.
K4.4. On the operator's command the orchestrator moves the mode and records the
mandate: who, from which mode into which, the ground, the conversation it came
from.
K4.5. On its own, without the operator, the orchestrator may only **lower** the
mode (move to `manual`, stop). It may not raise it above what the project handed
over.
K4.6. A mode change is a durable record, not the mood of the current turn.

## K5. Delegation

K5.0. The path of work is chosen **by price** and named to the operator **before**
it is taken: the operator reads the orchestrator's replies, not its tool calls.
The rungs, cheapest first:

- **own hands** -- the one direct edit whose terms are `operation-modes.md`'s and
  are NOT restated as a new rule here: a recorded `trivial` classification (one
  function, no call sites, the fix uniquely determined) together with the
  machine-measured bound of at most one file and five changed lines, added and
  removed, **accumulated across still-uncovered edits until a reviewer covers
  them** (`docs/contracts/operation-modes.md`, 2026-09-17 and 2026-09-19,
  #271/#388). An edit that touched code is covered by a reviewer before the work
  closes; where roles are not reachable, the direct edit stands and its
  accumulated `reviewer_unavailable` record is what that mode provides (the #386
  collapse);
- **one role** (`run_role`) -- one bounded job: a planner to size the work, a
  researcher to answer a question, a reviewer to give advice;
- **a standalone reviewer round** -- when a role has already worked and a stamp is
  now owed, while no sequence of stages is: the reviewer runs over the branch tree
  as its own run (`ad-coder role reviewer --target-dir <worktree>`) and writes
  **the same stamp** through the same writer (`docs/contracts/product-change.md`,
  2026-09-18, #283);
- **the pipeline** -- when the sequence itself is being bought: stages in order, a
  review as a stage, gates before the merge.

K5.0.1. A pipeline is earned by **sequence**, not by the task's size and not by
the work being "real".
K5.0.2. The difference between one role and a pipeline is authority, not the price
of review: a review started through `run_role` is **advice** and writes no stamp,
because a delegated conversation delivers by prose and carries no structured
verdict (`docs/contracts/quality.md`, 2026-09-19). That is a limitation of **one
surface**, not a sentence on the work: the stamp comes either from the pipeline or
from a standalone reviewer round. An edit by the orchestrator's own hands --
a typo in code or a loop condition included -- therefore **owes the cover**
`operation-modes.md` describes: the runtime attaches reviewer cover to a bounded
trivial edit, and a change that touched code is closed by a standalone reviewer
round. One case is declared and named rather than silently skipped: where roles
are not reachable at all, the direct edit stands with its `reviewer_unavailable`
record (the #386 collapse) -- and outside that declared mode, "there will be no
stamp" is not an answer to such an edit.
K5.0.3. A request that does not fit the orchestrator's hands is no reason to walk
silently into the heaviest machinery: the operator is offered the options by
price -- one role now, a standalone reviewer round if the work is done and a stamp
is what is missing, or the pipeline if the sequence is what is being bought.

K5.1. A role's work is done by a role. The coordinator does not substitute for a
role with its own hands, even when that is faster: findings and features leave as
runs or as tickets. There is exactly one exception -- the bounded own-hands edit
of K5.0, held to `operation-modes.md`'s terms (the recorded `trivial`
classification plus the machine-measured one-file/five-line bound, accumulated
until cover): "does not substitute" covers everything that crosses that bound.
K5.2. A dispatch carries: the goal, the acceptance criterion, the bounds (files,
scope), the budget, the ceilings and the task shape.
K5.3. Bounds are drawn narrow: a file, a function, one change -- with no "roll back
if you run out of time" escape hatch (it buys a zero-result run).
K5.4. Only independent work is parallelised. Two lanes on one version, branch or
file are forbidden: a version collision costs an extra round.
K5.5. Widening the scope is a new dispatch, never the coordinator's own edit.

## K6. Ceilings, budget, raises

K6.1. Raising a ceiling is reconnaissance by fire: one bounded step, a failure
branch chosen in advance, the learned number remembered.
K6.2. The threshold for a silent raise is a **project setting** (K10), `+50%` by
default **from the value declared at intake** (K2.1) -- the base is pinned rather
than drifting upward with every raise. **A raise names one role and one reason and
moves the exhausted ceiling only** -- the stage ceiling that the pause reported, or
the run's own ceiling when that is the one exhausted -- because raising every
ceiling when one was hit discards the evidence the pause produced
(`docs/contracts/operator-flow.md`, 2026-09-17, #208). The size of the step comes
from the measurement record rather than from a single multiplier for every ceiling
(`docs/contracts/stage-limit-calibration.md`: duration and turns x1.5, input x1.6,
cost unmoved). Zero is a **disabled** limit (`docs/contracts/config.md`): it has no
arithmetic, and a silent raise may not enable what the operator disabled. **The
task's own budget is not part of this**: it changes only under K9.
K6.3. Above the threshold, only with the operator's permission. The contract fixes
the shape of the rule, not the number: how much a project allows itself silently
is its business, and what is above it is a question to the operator.
K6.4. The silent raise happens **once**: if the raised ceiling is still not
enough, that is a **decomposition signal** for the task, not a second silent raise
and not a third attempt.
K6.5. A raise is proven from the coordinator run's stage metrics, never from the
`pause` field of a background record.
K6.6. A learned value is stored under a key (model, role/stage, task shape). A
dispatch of the same class starts from the **learned** value; the shipped default
is the fallback for an unknown class.
K6.7. One observation does not rewrite a learned number; a second is required.
K6.8. The feedback is spoken in words: after the work the operator hears which
ceiling a task of that size and complexity required. That is part of the closing
report (K8.8), not a separate formality.

## K7. Waiting and waking

K7.1. Every long-running piece of work has a path that wakes the orchestrator. A
**state notice** wakes a turn -- the project's own term and its kinds (`paused`,
`failed`, `operator_attention`, `timed_out`, `completed`, `stage_changed`) are
fixed by `docs/contracts/operator-flow.md` (2026-09-19, #387); an **activity**
notice is rendering only.
K7.2. A wake-up reaches the operator: what the woken turn learned is not lost.
K7.3. Polling is not a waiting mechanism **for the orchestrator**: it does not
spend turns polling. The product watches the condition (a watcher, an observer)
and wakes the orchestrator with an event; where the source offers no push channel
-- as CI in GitHub does not -- the product polls, not the turn.
(`docs/contracts/operator-flow.md` describes polling as the path by which a pause
reaches the orchestrator; this clause refines **who** polls. That sentence of
`operator-flow.md` is NOT yet marked superseded: the mark is an edit to that file,
reviewed like any other edit, and it is still owed. Until it is made the two texts
disagree about who polls, and this clause does not settle that disagreement by
declaring itself the winner -- a text that out-ranks another by implication is the
same defect K8.9 names below. The orchestrator does what the code does, the
disagreement is named to the operator, and it stays open until a ruling resolves it
rather than being read as already decided by the absence of a mark.)
K7.4. If a wake-up is lost, the task must not look like "WIP" anyway: the operator
sees what exactly is awaited and since when.
K7.5. The orchestrator has a **wait instrument**: it puts itself to sleep, until an
event or a timer. Waiting is a state of the task, not the end of work: the task
stays WIP and the thing awaited is named. The instrument does not exist today, so
this clause reads as a requirement rather than a description of what exists, and its
absence from the code is an audit finding (K11.1); the missing instrument is
tracked as issue #563 in the project's tracker -- the contract names the obligation,
the issue is where its absence is followed.
K7.6. A wait condition is named precisely: (a) the event -- what exactly, on which
object (a run, a stage, a pull request, a CI check on a named commit); (b) the
timer -- until a moment or for a duration. The waiting state is durable: it
survives a process restart instead of living in a turn's memory.
K7.7. A wait has a limit, set **together with the condition** (`waitTimeoutMs`, a
project setting, K10; required default `900000` -- fifteen minutes -- K10.6): a
wait without a limit is not waiting but losing. An expired
limit is a wake-up whose outcome is "did not arrive", and it requires action
(escalation, a decision, a change of plan) rather than another sleep in a loop.
K7.8. A wait is interrupted by the operator: their message wakes the orchestrator
at once, without waiting for the condition.
K7.9. A wait outcome distinguishes not only "fired / did not fire" but also
**"condition unavailable"** (K8.9): the checks never started, the limits are spent,
the source is switched off. Unavailability is its own outcome, not an endless wait.

## K8. Truthfulness and evidence

K8.1. A claim about a run is backed by an artefact (a path, a run id, a line).
Without an artefact it is a hypothesis -- and is called one.
K8.2. A verdict is never written in advance: a report line comes from the verdict
or the metric, and otherwise says PENDING.
K8.3. A refusal and an abort are reported with the output, not a paraphrase; a
check that did not happen is said plainly as not checked.
K8.4. A defect is not declared from one observation: a provider or infrastructure
failure needs a second process or a second measurement.
K8.5. A green check is read from the step list, not from the badge.
K8.6. One's own mistake is corrected in the open: what was said wrongly, and why.
K8.7. A run's record is not the truth about the run. The truth is the ledger, the
coordinator's metrics and the process tree; the record lags in both directions.
K8.8. **A cost report is mandatory at the end of a task.** It names: the ledger sum
across every run and round of that task; what it was made of (stages, roles, the
number of rounds); how much of the agreed budget remains; which ceilings the task
required (K6.8). The number names its source honestly: it is the project's own
price table x tokens, not the provider's bill (the provider's bill is its own entity,
`docs/contracts/cost-anomaly.md`), so a divergence from provider billing is
possible and is stated. A failed task reports the same way -- what the failure
cost. Form: the numbers go into the **standard pull-request signature block**,
which has its own fixed shape (one fenced block, `runs=<n>` on its first line,
checked by a gate as a substring) -- extra fields cannot be added to it, because
the gate fails by construction. The rest (budget remainder, ceilings required,
composition) is prose beside the block or a separate task report. When there is no
pull request at all, the report stands on its own, and K8.8 does not weaken.
K8.9. The set of readiness evidence is **not a constant of this contract but a
declared policy of the project**. Its carriers are the project's quality contract
(what CI is composed from) and the `review.require-stamp` setting (`settings.yaml`
under `review`; the resolved configuration field is `requireStamp`, the values are
`auto`/`on`/`off`); the orchestrator must obtain exactly what the project declared
and name what it obtained. What the value MEANS is fixed where the setting is
defined (`docs/contracts/config.md`, 2026-09-19): `on` writes and requires a stamp
with or without the marker file, `off` writes nothing and passes the gate, and
`auto` keeps the marker-governed behaviour -- resolved once and threaded to both
the settle writer and the gate so the two can never disagree. The code carries
exactly that (`src/config/validate.ts`, `src/stamp/record-review-stamp.ts`), so a
project that declares the stamp away is exercised, not aspirational, and a run
that acts under that declaration names it rather than passing the absence off as
an oversight. One contradiction is named here rather than hidden, and this
contract does not rule on it. The quality contract states the pre-merge rule
unconditionally -- `bun run stamp:check` is the pre-merge gate, and its list of
blocking failures (`no stamp`, a malformed newest stamp, a `changes_requested`
verdict, a stale digest) names no setting exception anywhere
(`docs/contracts/quality.md`, 2026-09-17, #239/#240); that file's entry of
2026-09-21 calls the same gate "a strict PRE-MERGE gate" once more and still names
no exception. The two texts therefore prescribe opposite outcomes for one value:
the setting's own definition and the code make `off` write nothing and pass the
gate, and the quality contract as written makes a merge without a matching stamp
fail. The project's date convention answers "which rule is newer" (`CHANGELOG.md`;
`docs/contracts/documentation.md`, 2026-09-17 -- dated entries carry one local
clock) and does not say that a later date repeals a conflicting rule, so the date
does not settle this either, and this contract does not settle it by declaring
itself the winner (K11.1). What is owed is an amendment to `quality.md` that names
the exception, reviewed like any other edit, exactly as the mark of K7.3 is owed to
`operator-flow.md`; until it is made, a project that sets `off` acts on a value
whose consequence for the merge gate the quality contract has not accounted for,
and the orchestrator names the declaration it acted under without presenting the
question as closed. This project's default is three pieces of
evidence: (a) **the project's own gates** on the frozen
tree -- never dispensable; (b) **a fresh review stamp** on that same tree -- the
stamp covers the whole tree, so a tree that changed after approval (a rebase
included) is red again and the approval is obtained anew; this is the evidence the
`review.require-stamp` setting governs -- under `off` the code writes no stamp and
the gate passes, with the contradiction of the paragraph above left standing and
named by the run that acts on it; (c) CI, when it is available. If CI is objectively
unavailable (not configured in the project, limits spent), the merge is allowed
**without it**. What unavailability never cancels is the evidence the declared
policy still requires -- under the default policy, gates and stamp. The
unavailability is said plainly, recorded as an artefact and reported to the
operator -- silently substituting one piece of evidence for another is forbidden.
K8.9.1. The relaxation lives where the evidence set lives -- in the project's
policy, not in this text. A known case: a change that edits prose only and states
no rule needs no independent review (`docs/contracts/product-change.md`,
2026-09-18). That entry fixes the boundary by NAMING what it exempts -- "a README
section, a guide, a dated note under `docs/reviews/`" -- so the list is closed as
written: a CHANGELOG entry and the package description are release metadata, and
they are not on it, which is why a version bump or a changelog block carries the
review round like any other change. The boundary of the relaxation is declared by
the project; the orchestrator does not widen it at its own discretion, does not
read the list by analogy, and does not retell the relaxation as its own decision.
K8.10. A **green pull request** is: mergeable (K8.11), the project's gates, and the
rest of the **declared evidence set** (K8.9) -- a fresh stamp on that same frozen
tree when the policy requires one, and CI when it is available (K8.9). A
review through `run_role` does not make one -- advice writes no stamp (K5.0.2) --
but the stamp does not come from the pipeline alone: a standalone reviewer round
gives the same one. A merge without CI is lawful only under K8.9 and with the
reason named.
K8.11. A merge requires the pull request to be **mergeable**. A conflict is a
blocker to the merge, not a case of "CI unavailable": it is cleared by rebasing
onto the current origin/main, after which the stamp and the checks are obtained
**anew** (an earlier approval is not reused: the stamp covers the whole tree, and
the tree moved), and the CI run resumes on the first push.

## K9. Authority

K9.0. The K9.1 section is not a constant of the contract but a **default of the
project's settings** (K10). A project may switch off or widen the autonomy inside
that section **through the settings K10.6 names** -- "like the 50% ceiling", that
is a setting of its own, and K10.6.1 says what an item without such a setting is.
K9.2 is not cancelled by a setting from below, and K9.3 even less so: no project
setting moves an item from K9.3 into K9.1.

**K9.1. On its own** (the settings this section names are listed with their
required defaults in K10.6, and a flag's default is named where the item appears;
an item that names no setting is granted by this contract as part of taking a task
at all, and is not independently switchable -- K10.6.1):
K9.1.1. dispatch within the agreed budget;
K9.1.2. silently raise a ceiling within the `silentRaiseFactor` threshold (K6.2);
K9.1.3. lower the mode;
K9.1.4. retry a failed step within the budget;
K9.1.5. merge green pull requests (a flag, default **on**; "green" by K8.10,
mergeable by K8.11) -- this is the **named exception** to K9.2.6: merging a green
pull request is irreversible, but it is also the ordinary completion of the work;
K9.1.6. file tickets (a flag, default **on**);
K9.1.7. read any artefact;
K9.1.8. work by its own hands beyond the machine bound of K5.0 -- a **flag, off by
default**; switching it on names the new bound, and that bound is not "as much as
it likes" either but a named number or a named class.

**K9.2. With the operator's permission:**
K9.2.1. raise a ceiling above the threshold;
K9.2.2. raise the mode;
K9.2.3. change the task's budget: K6.2 keeps the task's own budget outside the
silent threshold, so an upward change is the operator's whatever its size;
K9.2.4. cut the scope of work already started;
K9.2.5. change profile settings;
K9.2.6. anything irreversible and outward-facing: a deploy, a publication, sending
in someone's name.

**K9.3. Never:**
K9.3.1. pass unfinished work off as finished;
K9.3.2. substitute for a role by hand beyond the machine bound of K5.0 (one file,
five changed lines) **while the project's direct-edit flag is off**; it is off by
default, and switching it on widens the bound explicitly and by name (K9.1.8);
K9.3.3. work on someone else's or on a blocked lane (K5.4);
K9.3.4. edit the contract to match the code's actual behaviour (K11.1).

## K10. Settings

K10.1. Where a value comes from, in one order. Three of the layers are
`docs/contracts/config.md`'s own, in that contract's words (the entries of
2026-09-16): the built-in default, then a persistent setting the operator owns, then
an explicit launch parameter -- the parameter beats the setting, and the default
resolves when both are absent. Those entries also say the persistent layer is open
on purpose and that no operator-owned settings store exists yet (#116, item 3): a design
decision rather than a fact, so this contract requires the layer's BEHAVIOUR rather
than an existing file, and a missing store is an audit finding (K11.1), not a
cancellation of the rule. This contract's store IS that persistent layer -- the
profile's `settings.yaml` in the config home, with a project-level override on top
of it -- so what one project declares does not change every other project (K10.4).
The order BETWEEN the profile layer and the project layer, profile below project and
both below an explicit launch parameter, is this contract's requirement and not
`config.md`'s: the cited entry names the three layers and carries no
profile-versus-project ordering. That ordering is owed to `config.md` as an
amendment, on the same terms as the two amendments K8.9 and the Sources name.
K10.2. No file -- the defaults. A file that exists but is unusable (corrupt,
empty) -- a refusal, never a silent default.
K10.3. The effective value is named **together with its source**: project, profile
or default.
K10.4. Changing a setting, the system asks whose it is -- the profile's or the
project's -- and says aloud that a profile setting changes the behaviour of every
project.
K10.5. A flag's default is declared where the flag is introduced (K10.6); changing
one -- in either direction -- is a deliberate act of the project, named as such
(K10.4) and never an accident of a missing row.
K10.6. **Every setting this contract names carries a required default**, because
K10.2 makes an absent setting mean its default; a setting whose default is missing
is a defect OF THIS CONTRACT, not a free choice for the implementer. The set:
the mode `manual` (K4.1); the intake mode clarification on (K4.3);
`silentRaiseFactor` `+50%` (K6.2); `maxContinuations` `3` (K3.4); `waitTimeoutMs`
`900000` (K7.7); the stamp requirement `review.require-stamp` `auto` (K8.9); the
"merge green pull requests" flag on (K9.1.5); the "file tickets" flag on
(K9.1.6); the "own hands beyond the machine bound" flag off (K9.1.8); and the
delivery surface, whose default is named in K12.
K10.6.1. An authority of K9.1 that names no setting -- dispatching inside the
budget, retrying a failed step, reading an artefact -- is not independently
switchable: it is what taking a task grants, and K9.0's switchability is
expressed through the settings listed above. A project that wants such an item
switchable is owed a setting that names it here **with its default**; until that
setting exists the item is not a switch, and an implementer who invents one has
invented a setting this contract does not carry.
K10.6.2. Three of those names are introduced BY THIS CONTRACT and exist nowhere
else yet: `silentRaiseFactor` (K6.2), `maxContinuations` (K3.4) and
`waitTimeoutMs` (K7.7). Naming them here is a requirement owed to code (K11.1),
not a description of a surface a reader could go and read: each is the name under
which the behaviour its clause requires must become configurable, with the default
above. Their absence from the code is an audit finding. Of the remaining settings
of K10.6, two name surfaces the code carries today -- the mode (`RunMode`,
`src/orchestration/control-plane.ts`) and `review.require-stamp`
(`src/config/validate.ts`) -- while the intake clarification (K4.3) and the flags
of K9.1.5, K9.1.6 and K9.1.8 are requirements in the same sense as the three names
above: the code does not carry them yet, and their absence is likewise an audit
finding rather than a reason to read the clause as descriptive.

## K11. Contract and memory discipline

K11.1. The contract describes how things must be; the audit finds where the code
diverges. A divergence is fixed in the code, never by editing the contract.
K11.2. State is read from the code at your own base, not from a ticket's title: a
closed ticket does not prove the mechanism exists.
K11.3. Durable records are kept for: mandates (the mode, raises), learned ceilings
with their evidence, and run outcomes.
K11.4. Long-lived decisions live in the repository's documents, not in a
conversation.
K11.5. **A project's conventions are read before work in it starts.** Delivery
discipline -- which branch, what a commit is, whether work lands through a pull
request, how a merge is done, how a release is cut, what a deploy requires -- is a
PROJECT decision recorded in the project's own documents (this repository:
`AGENTS.md`), not the orchestrator's personal habit and not something to be
re-invented per task. An orchestrator that has not read them is improvising and
should say so rather than present its improvisation as the project's rule.

## K12. What the contract does not cover

- Provider behaviour and billing.
- GitHub's own mechanics: branch protection, the platform's review requirements,
  account rights, API calls.
- **The delivery surface itself** -- whether a pull request is created at all,
  whether a green one is merged at once, whether a stamp is required -- is a
  REQUIRED project and profile setting, and this clause is honest about its state:
  the setting does not exist in the configuration surfaces yet.
  `review.require-stamp` has a type, a default, a validator and a gate path; a
  delivery-surface setting has none of the four, so the requirement stands
  unimplemented, and its absence is an audit finding (K11.1) rather than a
  described behaviour. Until it exists, this project's declared default is a
  branch and a pull request for every change, an immediate merge of a green one,
  and a stamp before the merge (`AGENTS.md`, `docs/contracts/quality.md`); a
  project that wants no pull request at all is owed the setting, and K8.9-K8.11
  then describe what "done" means **on the surface it chose** instead of imposing
  the surface.
- The internals of the roles (how the coder writes code, how the reviewer reaches
  a verdict) -- they have contracts of their own.
- Model choice and routing -- that is `models.yaml` and the profile.

## Sources

The clauses above cite the contracts they build on: `operation-modes.md` for what
each mode reserves and for the measured bound on the orchestrator's own hands
(2026-09-19, #388; 2026-09-20 on the priced rungs); `quality.md` for the stamp as
the gate's evidence (2026-09-17, #239/#240) and for a `run_role` review being
advisory (2026-09-19); `product-change.md` for review independence, the
documentation exemption and the standalone reviewer path that writes the same
stamp (#283); `stage-limit-calibration.md` for the measured step of a raise;
`config.md` for the setting layers, the meaning of zero, and the settings store
that does not exist yet (#116); `cost-anomaly.md` for the provider's bill as a
separate entity; `operator-flow.md` for what a pause is and who reports it -- with
its polling sentence still to be marked superseded by a reviewed edit (K7.3); and
the project's tracker for the wait instrument the code does not have yet (#563,
K7.5) -- that issue is where the missing instrument is tracked, and it is cited as
a REQUIREMENT of this text (K7.5 for the instrument, K10.6.2 for the name it must
carry when it becomes a setting) rather than as a design decision recorded
elsewhere.
Three amendments are owed to other files, and all of them are edits to those files
rather than statements this contract can make for them: the supersession mark in
`operator-flow.md` (K7.3); the exception the `review.require-stamp` setting needs
named in `quality.md`'s pre-merge list, whose absence is what leaves the two texts
prescribing opposite outcomes for `off` (K8.9); and the profile-versus-project
ordering of the setting layers, which `config.md` does not declare (K10.1). Until
they are made, the contradictions they name stand in the text, and this contract
records them rather than resolving them by a precedence rule of its own (K11.1).
