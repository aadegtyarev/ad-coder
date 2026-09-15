# Working notes for agents on ad-coder

Conventions and operator preferences for anyone (human or agent) developing
ad-coder. This file is in the repo ON PURPOSE: it travels with `git pull` to
every machine and every tool, unlike a tool-local memory store. Until ad-coder
ships its own committed project-memory, this file and the docs it points to are
the canonical home for that knowledge.

## Knowledge lives in the repo

Project knowledge — design decisions, architecture, conventions, and notes about
how to work on this project — belongs IN the project, committed, not scattered in
a tool-local per-project memory (`~/.claude/...`, which is machine-local and does
NOT cross GitHub to another machine, so it is lost the moment you switch hardware).

- A design decision → `docs/ROADMAP.md` (or a decision record). ROADMAP is canonical.
- A working convention or operator preference → this file.
- Architecture / how a module works → `docs/ARCHITECTURE.md`.
- An unresolved item and the current product priority → a GitHub issue on this
  repository, filed under one of the epics `docs/BACKLOG.md` indexes. That file
  is a pointer now, not a list; do not restore prose items to it.
- Exceptional incident evidence → a dated file in `docs/reviews/`; routine
  verification belongs in durable run state, not a committed receipt.
- Measured provider or SDK research → the relevant `docs/*-economics.md` or
  `docs/*-capabilities.md` research note.
- A tool-local memory may hold at most lightweight pointers to the above and
  genuinely cross-project facts about the operator — never project content.

README is navigation, not a second copy of these documents. Contracts remain
the only home for enforceable project-wide rules.

## Prompts: small, but carry the load-bearing guard-rails

Role prompts (`prompts/*.md`) are kept terse — small prompts are a project value
(cost, cache). But terse is not hollow: keep the specific hard-won disciplines
that make a role work (the reviewer's revert-and-restore proof, the planner's
"narrow the step for a cheap coder" and problem-evidence honesty, the coder's
fail-loud-over-a-quiet-default). Drop only what is specific to another harness's
infrastructure (contract directories, migrations, worktree isolation, foreign
output schemas) — those arrive with the feature that needs them, not before.

## Ledgers and working files are safe to share, or gitignored

Typed errors carry names/paths/numbers only, never secrets or file contents. The
`.ad-coder/` runtime dir (ledger, sessions, scratch) is gitignored via its own
`.ad-coder/.gitignore`; only the bounded anonymous `calibration.json` snapshot
is unignored. The repository root carries the same exception so a fresh clone
can commit the snapshot without exposing runtime state.

## Write verified research to the repo as you find it, not batched

When research or reconnaissance establishes a fact worth keeping (a provider
quirk, an SDK signature, a measured cost), write it to `docs/` at that moment —
`docs/pi-capabilities.md`, `docs/cost-economics.md`, or the relevant doc — not in a
batch at the end. Research that lives only in a chat transcript is lost when the
session ends and re-paid in tokens the next time someone needs it. The repo is the
durable store; the transcript is not.

## Everything configurable is configurable; defaults are maximally efficient

If a behavior has a reasonable alternative someone might want, expose it as
configuration rather than hardcoding one choice. The counterweight to a small
config surface is not fewer knobs — it is good DEFAULTS: ship the most efficient
option (not the most conservative), so a user gets good behavior out of the box
and can override any of it. "Opinionated defaults, everything overridable", never
"configure everything yourself".

This is not a soft convention — it is an ENFORCED contract that the reviewer reads
and blocks on: `docs/contracts/config.md`. Otherwise config-worthy values get
hardcoded as constants. It applies especially to the context/compaction strategy
(see docs/ROADMAP.md): a user who wants full control must be able to turn
auto-compaction OFF entirely and have the harness HALT and require a manual
clear/compact command instead of silently summarizing history.

## Put knowledge where it is read; keep the session lean

Do not hoard state in the conversation — it is re-sent every turn and overflows.
Do not scatter it into a memory store that does not travel or a scratch file
nobody opens. Durable knowledge goes to the place the next reader actually looks:
`docs/ROADMAP.md` (design), `docs/ARCHITECTURE.md` (how it works), this file
(conventions), `docs/contracts/` (enforced rules). When something matters past the
turn, write it there; when it does not, let it go. This applies to the orchestrator
as much as to whoever is developing ad-coder.

## Naming: workflow vs pipeline

Two words that are easy to blur, kept distinct on purpose. A **workflow** is the
stepped SUBSTRATE — the scriptable step-graph concept: `createWorkflowSession` owns
a graph, `step`/`applyTransition`/a `Driver` walk it, and any number of workflows
(a bare role, a custom step-graph a user drops under `.ad-coder/workflows/`) can ride
it. The **pipeline** is the ONE built-in workflow: the plan → [security] → code ⇄
review flow (`runPipeline`, the auto-driver over a workflow session). So the
orchestrator's autonomous tool is `run_pipeline` (it runs that one built-in flow to
completion), while its manual `run_step` / `choose_transition` tools drive the
underlying WORKFLOW session one step at a time. When you write "workflow" mean the
substrate/graph; when you write "pipeline" mean the specific built-in flow — do not
use them interchangeably.

## An enforceable rule is a contract, not a note here

This file is for ORIENTATION and non-enforced conventions. A rule that guides the
build and that a coder could violate belongs in `docs/contracts/` (the reviewer reads
it and blocks on a violation), not here. Current contracts: `config.md` (everything
configurable), `architecture.md` (headless core + thin fronts, every capability
reachable programmatically — the harness is friendly to humans AND machines),
`quality.md` (every change passes `bun run check` — Biome format + lint — with the
Reviewer blocking on a non-clean run).





## Step closeout

After every material implementation step, persist the handoff before stopping:
record verdict and command evidence in durable run state; create a dated
`docs/reviews/` receipt only when an exceptional incident needs durable evidence;
update `docs/ARCHITECTURE.md` only when the current system map changed; and
file an issue for unresolved work under the matching epic rather than editing
`docs/BACKLOG.md`, which now only indexes those epics. Put
decisions in `docs/ROADMAP.md` and research in its relevant research note.
There is no parallel checkpoint file. Do not leave project knowledge only in a
chat transcript or ignored harness runtime state.

## Native dogfood and calibration program

Run ad-coder itself with the `openrouter-presets` inventory profile by default.
Use another inventory profile only when the operator explicitly requests it.

### Finish this program end to end

The active dogfood/calibration program is one continuous project objective, not a
series of optional chat tasks. Keep moving autonomously through research,
ad-coder repairs, prompt/tool/profile changes, benchmark construction, reruns,
calibration, review, documentation, PR, CI, and merge until the whole accepted
scope is complete. A progress report is never a stopping point: after reporting,
immediately execute the next unblocked step in the same turn. Do not emit a final
answer merely because one role, slice, test, review, or research report finished.

When dogfood exposes a benchmark-blocking ad-coder defect, stop the affected
benchmark generation, preserve its evidence as rejected/diagnostic, fix and test
the product defect, then rerun every invalidated cell under a new versioned
generation. Non-blocking defects may wait only until the current bounded round
finishes. Never trade research quality for a superficially cheaper run when its
decision controls architecture, dependencies, provider economics, or model
routing.

If the host forcibly ends a turn or process, persist a cold-session handoff before
the boundary: current branch/commit, accepted and rejected evidence, exact active
checkpoint/run IDs, token/cost totals, files changed, verified commands, blockers,
and the exact next command. On the next turn, resume from that handoff without
asking the operator to restate scope and without repeating completed work.

The completion condition for this program is all of: blocking pipeline defects
fixed; model research independently verified and durable; role briefs and native
Orchestrator behavior updated; portable profiles/economics history/import/export
implemented; representative benchmark corpus built; manual-role, manual-workflow,
and automatic-pipeline modes exercised; model/role/complexity calibration recorded
with accepted-result economics; full checks and independent review clean; and the
resulting PR merged. Until all conditions hold, report at most 99% and continue.

For the active ad-coder optimization and model-calibration program, do not use
LDO. Develop directly or through ad-coder's native Planner, Researcher, Security,
Coder, Reviewer, Auditor, and Orchestrator roles. Exercise standalone roles,
manual workflow stepping, and the fully automatic built-in pipeline so product
failures remain visible. This explicit operator instruction overrides the generic
LDO guidance below for this program.

Optimize accepted-result efficiency, never token count alone. Charge planning,
research, security, coding, repair, re-review, failed stages, and recovery to the
route being evaluated. Preserve identical quality gates. Record duration,
model/tool turns, fresh/cache/output/reasoning tokens, provider-reported and
estimated cost, context size/tier, stage limits, verdict, escaped defects, and
operator interventions. Keep API token billing separate from subscription
capacity and rate-limit/reset observations.

Calibrate against small realistic repositories covering trivial changes, medium
repairs, behavior-preserving refactors, complex cross-surface features, hidden
review defects, and orchestration/recovery choices. Start unfamiliar inventories
from documented provider guidance and independent evidence, then test the
cheapest plausible models at one effort level. Vary effort or an adjacent model
only around failed or unstable cells. Prefer a different model family for Coder
and Reviewer when the operator-authored inventory permits it; within a Codex-only
inventory use distinct recommended variants such as Sol and Terra.

Treat Orchestrator, Planner, and observed complexity as separate calibration
signals. Planner disagreement and actual rounds, scope changes, limit hits,
quality gates, and accepted-result cost refine only an explicit project-local
override. The reusable calibrated base and full price/limit history belong to the
user profile. A project may retain a bounded anonymous current snapshot so it is
portable. Export/import must be versioned, validated before atomic mutation, and
must exclude credentials, account identity, raw provider responses, transcripts,
and precise private activity history.
Use the root agent's own routing decisions as shadow Orchestrator samples: before
dispatch, note the mode, estimated complexity, model/effort, and finite budgets;
afterward compare them with Planner and observed outcomes. A role prompt's soft
turn guidance is not a runtime limit. Apply an explicit ceiling during dogfood
and treat overruns as evidence for role-specific defaults.

Write durable decisions to `docs/ROADMAP.md`, unresolved implementation to a
GitHub issue under the matching epic, provider/economic evidence to the relevant research note, and
aggregate benchmark conclusions to `docs/model-calibration.md`. Raw runs remain
gitignored. After finding pipeline waste or failure, fix and verify it before
expanding the benchmark matrix; do not run a broad suite until the targeted fix
passes focused checks.

Every bootstrap or refresh research run that can affect routing must leave a
dated, source-linked note in the developed project's `docs/`; preserve verified
facts, unknowns, confidence, model/effort, run ID, and aggregate usage so a later
Researcher can compare rather than start over. Update the existing thematic note
instead of scattering equivalent research. Never leave useful research only in
`.ad-coder/` or chat.
For model bootstrap, use the strongest available Researcher with finite budgets.
The active Orchestrator must independently open the primary official source before
accepting a conclusion that sets the initial model matrix, price, limit, or route.
Claims that documentation does not exist require a family/product-index search,
an exact catalog check, and a provider-domain web search; one empty search result
is never enough. If verification overturns the report, retain it only as rejected
role-calibration evidence and rerun every benchmark whose routing premise depended
on it.
Check exact identifiers in official provider material first. If they are absent,
confirm against one official catalog and stop variant-specific web expansion;
mark specifications unknown and proceed to empirical calibration. If present,
collect only routing-relevant capability, effort, context/cache, price-tier,
subscription/rate-limit, and published-eval facts, then seek one independent
exact-model source. Never infer a tier from a model name.

Append every meaningful role or benchmark sample to
`docs/calibration-evidence.jsonl`. Keep one bounded secret-free JSON object per
sample: schema version, date, task/corpus ID, mode, role, assigned and observed
complexity, provider/model/effort, accepted/verdict, rounds, duration, model/tool
turns, fresh/cache/output/reasoning tokens, reported/estimated cost, limit event,
escaped-defect count, and a short behavioral observation. Omit unavailable
values rather than estimating them. This compact ledger is committed for later
statistics; raw outputs, prompts, transcripts, exact private activity times, and
account identity remain gitignored.

## Working-tree and harness notes

- Every change merged into `main`, including documentation-only work, must bump
  the package version according to SemVer and add a dated changelog entry.
- Changes go through a feature branch/worktree and PR; merge green PRs immediately
  after required checks pass. Do not push directly to `main`. Historical direct-main commits `958254a` and
  `c09e4ef` predate this rule and were accepted by operator decision.
- The product requirement is that plan reuse and isolation remain composable;
  do not inherit a harness limitation that makes them mutually exclusive.
- Earlier legacy-LDO research runs failed when a StructuredOutput `findings`
  field arrived malformed. Treat that as harness evidence, not a product fact;
  provide already-verified facts or diagnose the harness before relying on that
  research mode.
















<!-- BEGIN ldo-codex -->
## LDO orchestration

For a non-trivial implementation request, let LDO plan first and decide whether review is needed. First tell the user that LDO is starting, then run:

```sh
node .codex/ldo/scripts/ldo-run.mjs --runtime codex "<the user request>"
```

LDO saves every plan locally. In `review-plan=auto` (default), it pauses for discussion only when Planner rates the task `complex` or `elevated`; use `--review-plan always` or `never` to override. When paused, show the plan and wait for explicit approval; then run `node .codex/ldo/scripts/ldo-run.mjs --runtime codex --continue-plan latest`. If a pipeline later crashes, run `node .codex/ldo/scripts/ldo-run.mjs --runtime codex --resume-run latest` to continue from its first incomplete phase. If the user changes scope, create a new plan-only artifact instead. Use `--research` when current external facts are required and `--no-record` for fast, disposable iterations. Do not add `--isolate` in a normal `workspace-write` Codex session: Git worktree creation writes shared `.git/refs`, which that sandbox may forbid. Use `--isolate` only when the host explicitly permits Git metadata writes (for example, an externally sandboxed bypass session). Run independent tasks sequentially in the normal Codex path.
Planner runs once on Sol; do not add a preliminary classifier or second refinement pass. Trivial Reviewers use a compact verification prompt. These policies are Codex-only.

After every completed pipeline, always print a concise operator report in normal prose; raw pipeline JSON is not the report. Include the task outcome and verdict, changed files, tests, unresolved issues, token totals and per-stage usage, `runCheckpoint` path, and Recorder's `backlog.destination`, `backlog.file`, and `backlog.count`. When unresolved items exist in a developed project, the Recorder writes them to that project's own backlog destination; on this repository that destination is a GitHub issue under the matching epic, not `docs/BACKLOG.md`. Never silently finish without the operator report or without confirming the terminal checkpoint and backlog outcome. A deliberate `--no-record` run or a trivial run may report that backlog recording was skipped.

If the prompt begins with `You are LDO's` or says `You are an LDO subagent`, you are already a pipeline worker: do not invoke LDO again. Perform only the assigned role and return the requested JSON.

A Planner, Researcher, Security, Coder, Reviewer, or Orchestrator launched by
ad-coder itself is likewise already a pipeline worker, even when its prompt does
not use LDO's wording. Such a role must never invoke LDO recursively; it performs
only its assigned role inside the current workflow.

For a one-file mechanical edit, a direct factual answer, or a request explicitly asking not to orchestrate, work normally without LDO.
<!-- END ldo-codex -->
