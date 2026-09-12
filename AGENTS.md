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
- An unresolved item and the current product priority → `docs/BACKLOG.md`.
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
`.ad-coder/.gitignore` (`*`), so the project's root `.gitignore` is never touched.

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
update `docs/BACKLOG.md` only for unresolved work and the current priority. Put
decisions in `docs/ROADMAP.md` and research in its relevant research note.
There is no parallel checkpoint file. Do not leave project knowledge only in a
chat transcript or ignored harness runtime state.

## Working-tree and harness notes

- Changes go through a feature branch/worktree and PR; the operator merges. Do
  not push directly to `main`. Historical direct-main commits `958254a` and
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

After every completed pipeline, always print a concise operator report in normal prose; raw pipeline JSON is not the report. Include the task outcome and verdict, changed files, tests, unresolved issues, token totals and per-stage usage, `runCheckpoint` path, and Recorder's `backlog.destination`, `backlog.file`, and `backlog.count`. The Recorder must update `docs/BACKLOG.md` when unresolved items exist. Never silently finish without the operator report or without confirming the terminal checkpoint and backlog outcome. A deliberate `--no-record` run or a trivial run may report that backlog recording was skipped.

If the prompt begins with `You are LDO's` or says `You are an LDO subagent`, you are already a pipeline worker: do not invoke LDO again. Perform only the assigned role and return the requested JSON.

A Planner, Researcher, Security, Coder, Reviewer, or Orchestrator launched by
ad-coder itself is likewise already a pipeline worker, even when its prompt does
not use LDO's wording. Such a role must never invoke LDO recursively; it performs
only its assigned role inside the current workflow.

For a one-file mechanical edit, a direct factual answer, or a request explicitly asking not to orchestrate, work normally without LDO.
<!-- END ldo-codex -->
