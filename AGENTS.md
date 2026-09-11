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
- A tool-local memory may hold at most lightweight pointers to the above and
  genuinely cross-project facts about the operator — never project content.

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
