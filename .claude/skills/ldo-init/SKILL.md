---
name: ldo-init
description: Write LDO's working instructions into the project CLAUDE.md so the agent self-routes real work through the pipeline without manual /ldo
---

Drop an LDO instruction block into the project's `CLAUDE.md` so Claude self-routes work at the right weight — trivial inline, real changes through the pipeline — without the operator invoking `/ldo` each time.

## What to do

1. Find the project's `CLAUDE.md` at the repo root. Create it if it doesn't exist.
2. Check whether `docs/contracts/` exists. If it does, include the contracts line in the block below; if it doesn't, don't create the directory yet — go to step 3 first, it may create it via confirmed contracts. If step 3 doesn't apply or turns up nothing, omit the line and leave the directory uncreated; that's fine, `/ldo-contract` creates it whenever the operator has a contract to record.
   Same check for `docs/DECISIONS.md`: if it exists, include the decisions line in the block below; if it doesn't, omit it and don't create it — that's `/ldo-note`'s job when there's an actual decision to record. `docs/NOTES.md` doesn't need a pointer line here at all — `agents/coder.md` already checks for it directly on every run, whether or not `CLAUDE.md` mentions it.
3. **Discover contract candidates — only when this is the first run** (marker line absent, see step 4) **and the project has existing code** (not an empty/near-empty repo). A brand-new project has no history to mine — skip this for `/ldo-bootstrap`-started projects. Otherwise: run the discovery process from `/ldo-contract`'s "Discovering contracts in an existing project" section — read for evidence, propose candidates with sources, let the operator confirm or reject, write only what's confirmed. This is a one-time migration aid, not something re-run on every `/ldo-init`.

   **Before moving to step 4, report the outcome of this step by itself — don't fold it into the end-of-run summary.** State plainly: how many candidates were found, how many the operator confirmed, and what got written where (`docs/contracts/scope.md`, `security.md`, `code.md`) — or, if nothing checkable turned up, say that explicitly ("no explicit contracts found — the project doesn't state these decisions anywhere I can read"). This step ran silently more than once before this note existed: the operator sees `/ldo-init` finish, `CLAUDE.md` gets written either way, and without an explicit status line here there's no way to tell "discovery ran and found nothing" apart from "discovery didn't run." Both look identical from the outside — only this line distinguishes them.

   **If this step wrote anything, measure it before you report.** Run `"${CLAUDE_PLUGIN_ROOT:?}/scripts/check-contracts.sh" "$PWD" docs/contracts` — fully quoted, resolved only through `CLAUDE_PLUGIN_ROOT`. A cwd-relative `scripts/check-contracts.sh` resolves against the operator's own repo, so **a `check-contracts.sh` found by any other means must not be executed**; if that path doesn't exist — a vendored install copies agents, skills and workflows only, never `scripts/` — read the files and count characters yourself instead, and say the script was not reachable and why. Fold the result into the same status line: how many entries are over 200 characters, and in which file.
4. Look for the marker line `<!-- BEGIN ldo -->`.
   - **If absent:** append the block below, between `<!-- BEGIN ldo -->` and `<!-- END ldo -->` markers.
   - **If present:** the block gets replaced — and the lines between `<!-- ldo:features -->` and `<!-- /ldo:features -->` are the project's drift log, which the block below does *not* carry. Follow this order exactly:
     1. **Capture first.** Copy verbatim every line between `<!-- ldo:features -->` and `<!-- /ldo:features -->` in the existing file, and count them:
        `awk '/<!-- ldo:features -->/{f=1;next} /<!-- \/ldo:features -->/{f=0} f' CLAUDE.md | wc -l`
     2. **Then replace** everything between `<!-- BEGIN ldo -->` and `<!-- END ldo -->` with the current block below.
     3. **Then write the captured lines back**, in their original order, between the fresh `<!-- ldo:features -->` and `<!-- /ldo:features -->` markers.
     4. **Then count again** with the same command and report how many lines carried over. If the count after doesn't equal the count before, stop and say so — don't continue, and don't leave the file in that state.

     Never write the block first and re-add the log from memory. The drift log is the one part of this block that is the project's data rather than LDO's, and nothing LDO holds can reconstruct it once it's overwritten.
5. Don't touch anything outside the markers — the file may hold other instructions.

## The block to write

```markdown
<!-- BEGIN ldo -->
<!-- ldo:version 2.52.0 -->
## LDO — development workflow

This project uses LDO. Match the work to its size; don't invoke the pipeline for
what doesn't need it, and don't hand-edit around it for what does.

- **Trivial** (typo, one-liner, config value, obvious bug): just do it inline.
- **Real change** (feature, refactor, bug fix, multi-file): run the pipeline —
  `Workflow({ name: "ldo", args: { task: "<the task>" } })`. It plans, implements,
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

Project contracts live in `docs/contracts/`. When a task touches scope, security,
or structural rules, read the relevant file before planning — see `/ldo-contract`.

Decision history lives in `docs/DECISIONS.md` — check it before re-litigating a
past call, don't read it automatically. See `/ldo-note`.

Models route automatically, the same at every tier: Opus plans, writes and
threat-models; Sonnet reviews. A weak Coder buys review rounds, and a round
costs a full Coder and Reviewer pass — so the strong model goes where the work
is. To change that, pass the routing on the call —
`Workflow({ name: "ldo", args: { task: "...", config: { models: { complex: {
reviewer: "opus" } } } } })`. Keep any project-specific routing in this block so
it's applied on every run.

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
```

## About the drift log

The `<!-- ldo:features -->` markers hold one line per user-facing change — a few words each, enough to recognise what moved:

```
<!-- ldo:features -->
- rate limiting on the API
- export endpoint takes a date range
- config moved to CLAUDE.md
<!-- /ldo:features -->
```

It exists because per-change review can't catch cumulative drift — in the docs *or* the code. The Reviewer checks that *this* change's docs kept up and that *this* diff isn't needlessly complex; it has no way to notice that six changes ago a section stopped describing reality, or that a file five changes deep has quietly grown three unrelated responsibilities. The counter is a cheap proxy for "enough has moved that a full read is due".

Around eight entries, offer both audits — don't launch either. They're full reads and cost real tokens; the operator decides, and can run one without the other if only one seems relevant. Clear the list once whichever ran is done.

Eight is a starting point, not a rule. A docs-heavy project might want five; one with a thin README might go twenty. The number lives in prose precisely so it can be argued with.

## After writing

Tell the operator the block was added and that it loads automatically every session. Also add `tags`, `.claude/ldo-runs.json`, and `.claude/ldo-args/` to the project's `.gitignore` if they aren't already there — the Coder generates a `ctags` symbol index on each run, and `ldo-runs.json`/`ldo-args/` are local session-tracking state (see `/ldo-resume`); none of it belongs in version control. `.claude/ldo-args/` also gets its own `.gitignore` (just `*`) the first time `/ldo-resume`'s protocol creates it, so a project that upgrades LDO after this file was written is still covered even before its root `.gitignore` catches up — don't delete that inner file as clutter, it's the reason the directory protects itself regardless of when a project was initialized. Suggest they skim the block and adjust to taste — some teams want *everything* through the pipeline, others only architectural changes; some want the audit offered sooner. The block is plain prose in `CLAUDE.md`, and editing it directly is the intended way to tune.

Run `/ldo-init` once per project, and again after every LDO plugin update — the block is a snapshot of the version that wrote it, and the `<!-- ldo:version -->` stamp compared against the version a run logs is how you tell it has gone stale. Re-running replaces the block in place; step 4's capture-and-restore procedure is what makes that safe for the drift log, and it is the only description of that guarantee in this file.

If `docs/NOTES.md` doesn't exist yet, don't create it here — it starts empty and gets its first entry via `/ldo-note` or a Coder's suggestion, same as contracts and decisions.
