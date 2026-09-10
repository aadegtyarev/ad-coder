<!-- BEGIN ldo -->
<!-- ldo:version 2.42.0 -->
## LDO — development workflow

This project uses LDO. Match the work to its size; don't invoke the pipeline for
what doesn't need it, and don't hand-edit around it for what does.

- **Trivial** (typo, one-liner, config value, obvious bug): just do it inline.
- **Real change** (feature, refactor, bug fix, multi-file): run the pipeline —
  `Workflow({ name: "ldo:ldo", args: { task: "<the task>" } })`. It plans, implements,
  reviews, and proves the result. For a change touching auth, secrets, user input,
  or crypto, add `security: true`. For one needing outside knowledge, `research: true`.
- **New project** is a conversation first: `/ldo-bootstrap "idea"`.

**Track every pipeline call in `.claude/ldo-runs.json`** so an interrupted run can
resume instead of restarting cold — see `/ldo-resume` for the exact protocol
(write the full `args` object to `.claude/ldo-args/<runId>.json` right after
calling, then record the `runId`, the `transcriptDir` the tool result hands
back, and that reference in the tracking entry, and update its status when the
result comes back; resuming needs both the run id and the real args, and the
tracking entry alone doesn't carry them). At the start of this session, before
anything else, check that file for any entry whose status is not one of
`approved`, `changes_requested`, `planned`, `error`, `abandoned`, `shipped`,
`completed` or `failed` — `running`, `interrupted` and anything unrecognised all
mean an earlier session may have been interrupted mid-run. If any exist, follow
`/ldo-resume`'s recovery steps rather than leaving them unmentioned.

When working inline, keep the discipline: read before editing, write or update a
test for any behavior change, and update README/CHANGELOG for user-facing changes.

For any report or handoff: verdict first, evidence not assertion, name what you're
unsure of. See `/ldo-agent-ux`.

Models route automatically, the same at every tier: Opus plans, writes and
threat-models; Sonnet reviews. A weak Coder buys review rounds, and a round
costs a full Coder and Reviewer pass — so the strong model goes where the work
is. To change that, pass the routing on the call —
`Workflow({ name: "ldo:ldo", args: { task: "...", config: { models: { complex: {
reviewer: "opus" } } } } })`. Keep any project-specific routing in this block so
it's applied on every run.

**Project routing:** the recorder runs on `haiku` at every tier — pass
`config: { models: { trivial: { recorder: "haiku" }, medium: { recorder: "haiku" }, complex: { recorder: "haiku" } } }`
on every run.

A single-task run edits the working tree directly by default — no commit, no
branch. Pass `isolate: true` on the call to run it in a separate worktree instead
and leave your tree untouched.

**When the approach isn't settled, make the first call with `planOnly: true`** —
a task that reframes a problem, touches a contract, or spans layers. The run
stops after Plan and hands the plan back instead of implementing it; correct
the approach there, then re-issue the same task without the flag. Four restarts
of one task, every restart a design correction, is what this replaces.

**This block is a snapshot of the LDO version that wrote it.** The
`<!-- ldo:version -->` stamp on its first line says which, and every pipeline
run logs its own version. When the two disagree the block is stale — re-run
`/ldo-init` after updating or reinstalling the LDO plugin; it replaces the
block in place and carries the drift log below over unchanged. The stamp is a
hint for you, not a check: nothing in the pipeline reads it.

**Docs drift log.** Append a line here after each user-facing change. When the
list reaches roughly eight, offer to run `/ldo-docs-audit` and `/ldo-code-audit`
— full cold reads that catch documentation drift and code accretion (bloated
files, comment sprawl, duplicated logic) no single diff reveals — then clear
the list. Offer; don't run either unasked.

<!-- ldo:features -->
<!-- /ldo:features -->
<!-- END ldo -->
