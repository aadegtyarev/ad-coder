# What a capable model does on real work, and what that says about the bench

Date: 2026-09-17
Subject: glm-5.3-flash as the ad-coder orchestrator, two sessions, issue #116
Cost: $1.01 total, 410 model calls

Two consecutive sessions gave one model a real feature: make skills behave
identically in every command that runs a role. It produced 533 lines across 13
files in four commits, with the suite green at every commit. This is what the
retired bench could not see, recorded while it is still fresh.

## The headline finding: two of three "model failures" were product defects

Watching the first session, three things looked like the model ignoring
instructions. Only one was.

**It did not produce the plan the brief asked for.** The brief's closing line
said "produce the plan and stop". It never arrived: `ad-coder console` reads
input line by line and dispatches each line as its own turn, so a 30-line brief
became 30 turns and the model received only `Skills must behave identically in
every user-facing command.` as its task. It executed exactly what it was given.
In the second session the model said so itself, four turns running -- "Your
message appears to have been cut off after ..." -- while the operator, watching
the activity stream rather than the replies, read the same behaviour as
stubbornness. Filed as #224.

**It never delegated to a role.** 410 model calls, zero `run_role` or
`run_pipeline`. The cause was not reluctance: without `--workflows`, the enabled
module list resolved to empty, so those tools were never registered. The model
could not call what it did not have. The model found this itself while working,
and fixed it (#216) as part of the same session.

**It preferred `bash` to purpose-built tools.** This one is real, and is
discussed below.

The lesson for measurement is sharp: a role is a model plus a prompt plus a tool
set plus a transport, and a defect anywhere in that chain presents as a model
defect. Any score attributed to a model alone is attributing the whole chain.

## Where the prompt, not the model, set the ceiling

Two instructions in `prompts/orchestrator.md` shaped the behaviour more than any
model property would have.

The prompt says: "The pipeline's Planner determines complexity and affected
surfaces. Do not pre-plan the same work in conversation." Stated absolutely,
with no exception for an explicit operator request. A model that obeys its
prompt will decline to plan when asked -- correct behaviour against a rule that
was written for a different situation.

And the roles the orchestrator is supposed to delegate to are described in one
line: "`run_role` invokes Planner, Researcher, Security, Coder, Reviewer, or
Auditor independently." Six names, nothing about what each does, returns, or
costs. The prompt then says to delegate "when one focused role is sufficient" --
a judgement that six names cannot support. Doing the work directly is the only
decidable option left.

The machine knows what the prompt does not: which roles are configured, on which
models, at which complexity. It prints that as a startup banner for the operator
and never tells the orchestrator.

## What the model did well, unprompted

- **Found the right abstraction.** The task had three call sites where a role's
  prompt is assembled (`cli/resolve-config.ts` twice, `orchestration/session.ts`,
  `orchestration/orchestrator.ts`). It found all of them and factored a single
  `roleSkillKit()` rather than patching each -- the same design a human reviewer
  would have asked for.
- **Found a case the human brief missed.** A role whose catalogue is empty gets
  no loader: "a tool that answers `skill_not_available` to every call is noise,
  not capability."
- **Chose the conservative schema change.** For the user-profile setting it
  picked an optional `capabilities` field the v1 parser accepts over a v2 bump,
  and nested it so later capabilities need no second migration. A version bump
  would have invalidated the operator's existing profile for nothing.
- **Verified empirically rather than by argument.** It built throwaway projects
  under an isolated `XDG_CONFIG_HOME`, wrote real 0600 profiles, and ran the CLI
  against them. It wrote scratch repro tests in `/tmp`.
- **Read the issue itself.** Given a partial brief, it ran `gh issue view 116`
  and worked from the source rather than the fragment.
- **Filtered test output for failures** (`sed -n '/(fail)/p'`) rather than
  tailing it -- which is precisely the mistake the human made in the same
  session, shipping a branch on a truncated `bun test | tail -2` that hid a
  failing test.

## What it did poorly

**bash is the default tool for everything.** Across both sessions: 115 commands
starting with `grep`, 84 with `sed`, against 96 edit-tool calls and almost no
`read_project`. In the second session `read` was called once while `sed -n`
served as the reader. Consequences: file reads are invisible to the activity
stream (so the operator cannot see what was read or how much), and 13 edits were
performed as `sed -i` from bash, bypassing the edit tool entirely.

Contributing cause: `bash` ships with **no description at all**, while every
specialised tool describes its boundaries. The tool with no stated limits reads
as the tool without limits.

**16 of 96 edits failed** -- a 17% miss rate, mostly stale or non-unique match
text. After a failure the model often switched to `sed -i` rather than re-reading
and retrying, which trades a visible edit for an invisible one.

**It verified with the wrong commands.** It ran `npx tsc`, `npx biome lint` and
`npx biome format <files>` and reported "lint and format clean". The project's
own `bun run check` was red (unsorted imports) and `bun run check:docs` was red
(`ARCHITECTURE.md` over its word limit). The model checked honestly and was
wrong about what it had proven. Nothing in any contract it could reach lists the
seven gates as a set, and -- the deeper defect -- `src/gates/` has a working
`GateRunner` that no pipeline stage calls, so nothing re-checks after a coder
(#227).

**`git stash` mid-work.** Eleven times, to compare against a clean tree. The
technique is right; doing it with 155 uncommitted lines in the tree risks the
work on any failure between stash and pop.

**Two `nonexistent-placeholder.ts` edits and a `__placeholder_fixture__.txt`
containing "placeholder removed right after writing"** -- deliberate, numbered
probes of the edit tool, costing a call each.

## Economics

| | session 1 | session 2 |
|---|---|---|
| model calls | 218 | 192 |
| fresh input | 945,675 | 841,657 |
| cached input | 13,523,968 | 9,805,824 |
| output | 47,329 | 40,726 |
| reasoning | 0 | 0 |
| cost | $0.571 | $0.441 |

**93% of input came from cache.** Every word in a role prompt is re-read on every
turn, so prompt size multiplies by turn count -- the direct economic argument for
the skill catalogue replacing pasted instructions, and against loading anything
unconditionally that a task may not need.

**Output is tiny**: 88k tokens produced 533 lines of code and four commit
messages. This model acts rather than narrates, and spends no reasoning tokens.

For scale: the entire nine-model bench round of 2026-09-16 cost $1.49 and
measured noise. One feature, delivered, cost $1.01 and produced findings that
changed four contracts and six issues.

## What this says about building the bench

1. **Measure the role, not the model.** Every finding above depends on prompt,
   tools, transport and contracts. A model score without those names a
   configuration nobody ships.
2. **The cheap signals are already in the ledger.** bash-calls-per-edit,
   failed-edit rate, whether roles were delegated at all, tool mix, cache
   fraction, time to first edit, time to green -- all computable today from
   `.ad-coder/ledger/*.jsonl`, and none of them were being computed.
3. **Validate tasks against observed behaviour.** The bench failed because it
   had no external criterion, so noise and signal looked alike. Live sessions
   supply that criterion: a task whose score predicts what the model does on
   real work earns its place; one that does not is dropped, and that is
   checkable rather than a matter of taste.
4. **Re-run the bench after every prompt or skill change.** The orchestrator
   cells that scored 0.50 were measured before the search-discipline rules, the
   navigation skill, and the catalogue existed. That number describes a
   configuration that has since been replaced twice.
5. **Watch replies, not only activity.** The transport defect was visible in the
   model's own words for four turns and missed because only the tool stream was
   being read.

## Actions filed

#224 console splits a multi-line brief per line · #225 revive the bench as
role-fitness measurement · #226 the activity line lacks role, cost and the point
of a long command · #227 the pipeline never runs the project's gates · #216
capability audit (partly fixed in this session) · #222 the orchestrator cannot
ask the operator a question
