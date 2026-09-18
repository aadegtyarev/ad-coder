# Skill authoring contract

For anyone authoring or editing a skill under `prompts/skills/` or overriding one at
`.ad-coder/skills/<id>/`, this contract answers: what shape must a skill have, and which
of its properties are enforceable rather than preferred? A skill that violates this
contract is a defect to fix, not a preference to keep; the enforcement map at the end
says which check owns each rule.

## Scope

`docs/contracts/skills.md` is the skills contract: its dated entries decide selection,
trust, `--no-skills`/pins, and what the catalogue must not cost. This file carries only
the shape an individual skill must have. Resolver mechanics -- how a skill is found,
validated, digested, shadowed, or hidden -- are out of scope: they are implementation an
author cannot change and does not need.

Terms, defined once and used with these meanings throughout:

- **catalogue** -- the list of ids, versions and one-line descriptions a role sees in
  its prompt before any skill is loaded. The only surface of a skill a model always
  reads.
- **trigger** -- a model's decision to load a skill because its catalogue description
  matched the work in front of it.
- **paste** -- instructions placed into a role's prompt without a load (`always`, or a
  `--skills` pin).

## Manifest shape

A skill is a directory `prompts/skills/<id>/` (or `.ad-coder/skills/<id>/`) holding
`skill.json` and `instructions.md`. Required fields: `id` (matches the directory name),
`version`, `description` (the trigger surface, next section), `roles` (every role that
can perform the skill's task -- the 2026-09-17 task rule in skills.md, not only the role
whose title matches). Optional fields (issue #233):

- `always` (boolean, default false) -- paste into every role in `roles`, without a load,
  in catalogue and pin mode; justified only where the role cannot understand its own
  situation without the text. See "Division of labour" for what it must not carry.
- `requires` (`{workflows: [...]}` and/or `{plugins: [...]}`) -- dependencies on session
  composition, matched against what the run actually resolved, never against a claim in
  the manifest. A skill whose `requires` the session does not satisfy appears in neither
  the catalogue, nor any paste, nor the `config show` skill row the operator reads. An
  unwired composition counts as having nothing and fails closed. An `always` skill is
  never a catalogue row: its text is already in the prompt.

Design within the ceilings a skill must fit: manifest ≤ 4 KiB, instructions ≤ 16 KiB,
and at most 4 skills loaded per role per turn. A skill past a ceiling fails loudly at
selection or load; a skill against one has no room for the next rule that needs a line.

`instructions.md` opens with the mandatory statement, its own paragraph -- the pinned
sentence and its test live in skills.md (2026-09-18), not here.

## The catalogue entry is the trigger surface

The description is where a model decides whether the skill ever exists for it. Under
this contract it is written as a trigger, in three parts:

1. What it is -- the capability, named.
2. An explicit "Use when..." -- the situation, stated from the side of the work, not
   the side of the skill.
3. Example phrases in the operator's own vocabulary -- the words a task is likely to
   actually be written in.

For illustration only, not shipped text: "Overload response. Use when the work does not
fit one run -- a stage paused on its ceiling, a review failing on scope. Phrases to
expect: 'too big', 'split it', 'overloaded'."

Budget: a description may not exceed **1,536 characters**, the point where the vendor's
skill listing truncates a description (vendor-documented for Claude Code). Text past the
truncation point is written but never shown; keep the trigger inside what is displayed.

Evidence the budget earns its place:

- Operator-reported incident, 2026-09-18: four behaviour-bearing skills --
  `delivery-calibration`, `task-slicing`, `role-selection`, `overload-response` -- never
  triggered from one-line catalogue entries. Corroborated in-repo for
  `delivery-calibration`: granted, never loaded, dispatched anyway (skills.md
  2026-09-18), and by release 0.64.0 rewriting ten shipped descriptions into
  situation-first wording for exactly this reason.
- Vendor practice treats triggering itself as a measurable failure mode: "skill not
  triggering" and "triggers too often" are both documented failure modes.

Both directions are defects under this contract. A description too vague or too short to
trigger is a defect: the skill exists, is budgeted, and is never used. A description so
broad it triggers on unrelated work is a defect too: it spends one of the four loads a
turn allows, and the per-turn cost of the next section, on a skill the task did not
need.

Transition: shipped descriptions written as `<situation>: <what it carries>` (release
0.64.0) are grandfathered until their next wording change. That change must carry the
full three-part shape -- and is already a version bump by the 2026-09-18 rule.

## Division of labour

The boundary -- the prompt carries the obligation, the skill carries the technique --
is decided in skills.md (2026-09-18) and not restated here. This contract fixes where a
non-negotiable obligation lives when it is bound to a lifecycle event:

- **Prompt-carried**: an obligation the role must always produce (size before
  dispatching, claim before starting) lives in the role's own prompt.
- **Hook-carried**: a non-negotiable rule bound to a lifecycle event is injected by the
  harness at that event rather than carried in any prompt or skill. The live examples
  are budget-exhaustion triage at a stage-limit pause -- the closeout instruction the
  harness attaches when a stage reaches its limit
  (`src/orchestration/stage-limits.ts`) -- and the review retry that keeps a verdict
  from being lost (issue #278).
- **Skill-carried**: the technique. Optional to carry, mandatory once the description
  matches (skills.md, 2026-09-18).

It is never always-on and never a catalogue guess. Operator decision, 2026-09-18:
nothing loads unconditionally; the context window is finite. A rule that must be stated
at the event cannot depend on a model having loaded the right file earlier, and cannot
tax every run for the one run that needs it.

The decision is recorded here scoped to obligation placement. Whether it retires the
`always` field for every use is flagged to the operator for adjudication; until decided,
`always` keeps its issue-#233 semantics and must not be used to carry an obligation.

## Cost: the load is paid on every turn

A loaded skill's instructions recur in context on every subsequent turn of the session
-- vendor-documented behaviour of chat-model harnesses -- and corroborated in-repo: the
session measurement behind the catalogue found 93% of input tokens served from cache
precisely because a prompt is re-read every turn (skills.md 2026-09-17). A word loaded
once is paid for on every turn.

Write for progressive disclosure. The catalogue entry is the cheap surface, browsed
every turn at a few hundred bytes for the whole set; the instructions are the expensive
surface, recurring every turn once loaded, up to the ceilings above. This prices two
existing rules: a skill that restates its role prompt costs a load and teaches nothing
(skills.md 2026-09-16), and padding instructions past the technique is spend on every
turn that follows.

## Verification

A skill's triggering claim is eval-gated where the evals system supports it (scored
runs over recorded prompts, `evals/`). What must be measured:

- **Target prompts trigger the right skill**: for prompts the skill is written for, the
  per-role/turn tool ledger (`src/observability/tool-activity.ts`) records `load_skill`
  firing for it.
- **Non-target prompts do not trigger it**: for prompts outside the skill's situation,
  the same ledger records no load of it.

Current gap: `evals/scorers/` has no skill-trigger scorer, so triggering is reviewed
under this contract but not yet measured. Writing each "Use when..." against concrete
target and non-target prompts is required now; measuring them is tracked follow-up
work.

## Enforcement

- Manifest fields, ceilings, unmet-`requires` hiding -- the resolver plus its tests:
  loud failure at selection or load.
- Mandatory opening line -- test over the shipped directory: the identical sentence,
  its own paragraph.
- Description budget -- test over every shipped `skill.json`: ≤ 1,536 characters.
- Description trigger shape -- review under this contract; eval-gated once a trigger
  scorer exists (the gap above).
- Obligations stay out of skills; prompts name no skill id -- prompt tests (skills.md,
  2026-09-18).
