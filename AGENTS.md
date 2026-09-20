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

Dating clock for releases and contract entries: use the operator's LOCAL date,
never `date -u` (`docs/contracts/documentation.md`, 2026-09-17; the CHANGELOG
order it protects is enforced by `bun run check:release`).

## Who does the work: the orchestrator and its roles, not the coordinator

(Operator, 2026-09-19.) The agent coordinating a workstream does not implement.
Its work is to hand the orchestrator a ticket -- the issue, the finding, the
branch, the constraints -- and to sequence what comes back. Implementation is the
coder's, judgement is the reviewer's, and how the work is sliced is the
orchestrator's. Review findings that come back `changes_requested` are a ticket
like any other: they go back to the orchestrator, not into the coordinator's own
editor. A hand fix is a loss even when it is faster, because the run that would
have learned the shape of the problem never happens, and no ledger, verdict or
stamp is left behind to show what was done.

What the coordinator still owns, because no role does: reading the durable record
when a run cannot answer the question, deciding what is dispatched next and in
what order, checking claims against the tree before writing them into a PR body,
and reporting to the operator.


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

## Model routing: seed from published evidence, correct with real work

Run ad-coder itself with the `openrouter-presets` inventory profile by default.
Use another inventory profile only when the operator explicitly requests it.

**The routing matrix is seeded from public benchmark numbers, not measured
locally.** Published agentic results rest on thousands of tasks; a local sweep
of two dozen rests on one run per cell, where the run-to-run spread of a single
model exceeds every difference between models. The 2026-09-16 round spent a day
and $1.49 to learn that, and the conclusion is in the git history rather than in
a document, because the document would invite rebuilding it.

So: derive the initial matrix by rule from published evidence -- agentic and
tool-use scores, an intelligence index, latency, and the subscription allowance
-- and mark it `estimated`. Then correct it from work the project actually does.

**What research must establish before a cell is seeded.** Open the primary
source; a vendor blog is a claim, not a measurement. Read several benchmarks
rather than one, and prefer independently reproduced numbers -- the same
checkpoint moves 3-8 points on the same benchmark by harness alone, so a single
leaderboard row is not a fact about a model. Record the dated checkpoint, the
provider, the effort the numbers were produced at, and whether the figure is
vendor-reported. A model name alone does not identify what will run: providers
retire and realias slugs, and structured-output support differs per provider for
one model id.

**What corrects a cell.** Real runs already emit the signals: rounds to
acceptance, stage-limit hits, rejected verdicts, rework, and accepted-result
cost. A role that repeatedly needs rework moves up a tier; one that lands
first-try and cheap moves down. Persist an evidenced project-local override;
never silently rewrite the user baseline from one run. The reusable calibrated
base and the full price/limit history belong to the user profile; a project may
retain a bounded anonymous snapshot so it stays portable. Export/import must be
versioned, validated before atomic mutation, and must exclude credentials,
account identity, raw provider responses, transcripts, and precise private
activity history.

Optimize accepted-result efficiency, never token count alone. Charge planning,
research, security, coding, repair, re-review, failed stages, and recovery to
the route being evaluated. Keep API token billing separate from subscription
capacity: on a subscription the comparable quantity is the fraction of that
model's allowance, not the dollars.

**What the eval corpus is for.** `evals/` exercises the harness on adversarial
shapes -- a race across an `await`, two documents that disagree, a constraint
that must survive context eviction. Running it on 2026-09-16 found two product
defects that reading the code did not: a complexity rubric that reached one of
three callers, and a runner that dropped aborted runs so the worst ones vanished
from the sample. That is its job. It is not a model ranking, and a score from it
must not seed or override a routing cell.

**Rules that survive from that work**, because they apply to any measurement
including a public one:

- One run samples a model; it does not measure one. Five runs, judged on the
  worst.
- A failure is data, not an exception. Dropped runs are the bad ones, so
  dropping them flatters the model.
- Never compare models across different tasks.
- Route per role, not per model, and treat effort as part of the selection.
- When several models fail a check identically, read an artifact before
  concluding anything about the models: in this corpus that signal meant the
  check was wrong seven times out of seven.

If the host forcibly ends a turn or process, persist a cold-session handoff
before the boundary: current branch/commit, accepted and rejected evidence,
exact active checkpoint/run IDs, token/cost totals, files changed, verified
commands, blockers, and the exact next command. On the next turn, resume from
that handoff without asking the operator to restate scope.

For this program, do not use LDO. Develop directly or through ad-coder's native
roles, exercising standalone roles, manual workflow stepping, and the fully
automatic pipeline so product failures stay visible. This explicit operator
instruction overrides any generic LDO guidance.

Write durable decisions to `docs/ROADMAP.md`, unresolved implementation to a
GitHub issue under the matching epic, and provider/economic evidence to the
relevant research note. Every research run that can affect routing must leave a
dated, source-linked note in the developed project's `docs/`: verified facts,
unknowns, confidence, and sources, so a later Researcher can compare rather than
start over. Update the existing thematic note instead of scattering equivalent
research. Never leave useful research only in `.ad-coder/` or chat.
## Working-tree and harness notes

- Stop a run with `ad-coder runs stop <runId> --target-dir <dir>` (the run's
  record lives under `<target>/.ad-coder/runs/`); the command signals only a
  pid the record positively ties to that target. When that command is
  unavailable, address the run by the unique `--target-dir <path>` in its
  command line or by its recorded pid. NEVER stop runs by a command-line
  pattern (`pgrep -f "cli.ts role ..."`, `pkill -f`): the pattern matches
  every lane on the machine at once, and on 2026-09-20 it killed another
  lane's run (pids 1650952/1650955/1650958).
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
