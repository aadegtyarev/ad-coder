# Skills contract

Skills are trusted, versioned instruction bundles loaded only when selected for
a role/task. They reduce permanent role-prompt size; they are not a second
unbounded prompt directory.

- A skill has a safe `id`, `version`, concise manifest description, role scope,
  and `instructions.md`. Its selected content and source have a SHA-256 digest.
- Built-in skills ship with ad-coder. A project may add or override a skill at
  `.ad-coder/skills/<id>/`; project skills are trusted operator configuration,
  like project prompt overrides. Package/remote skills require an explicit later
  plugin installation path.
- V1 resolves a default set (the catalogue a role loads from with `load_skill`),
  explicit pinned IDs, and the explicit off (`--no-skills`, or the profile
  setting). Selected manifests and instructions load under separate finite
  count/byte limits, identical for every layer. Pinned or loaded, unknown,
  malformed, duplicate, escaping, or oversized skills fail loudly before
  provider dispatch. Bounded manifest discovery is a separately tracked v2
  capability; the per-role catalogue's bounded discovery is not a scan claim --
  it enumerates trusted directories that operator configuration owns.
- Selection is programmatic and visible: the default set is the catalog a role
  loads from, a `--skills` value pins exactly those ids pasted into the prompt,
  and the resolved set -- ids, versions, source tiers, digests -- is reported by
  the resolver and visible in `config show`. Version, source tier and digest
  are always exposed. Durable pipeline snapshots are a separately tracked v2
  boundary; v1 never claims resume-stable skill selection. Future discovery may
  let the orchestrator recommend skills from manifest descriptions, and the
  2026-09-16 catalogue rule below is that recommendation -- but full
  instructions still reach a prompt only through an explicit load or a pin,
  never silently.
- Built-in `architecture-recon`, `task-slicing`, `acceptance-review`,
  `delivery-calibration`, `repository-navigation`, `role-selection`,
  `documentation-writing`, `change-implementation`, `change-verification`,
  `threat-modelling`, `external-research`, `tracker-work` and
  `overload-response` are the shipped skills.
- 2026-09-16: A skill carries what a role prompt has no room for: the specific
  technique, the failure it prevents, and the rule for stopping. A skill that
  restates its role prompt in one sentence costs a load and teaches nothing --
  the first four shipped at 19-26 words each against a 16 KiB ceiling, which is
  why a reviewer holding `acceptance-review` behaved exactly as one without it.
- 2026-09-16: A role prompt carries the CATALOGUE -- each available skill's id,
  version and one-line description -- and a role loads a skill's instructions
  with `load_skill` once it has read the task. Which methodology a task needs is
  knowledge the model has and the operator does not, but only after reading the
  task, which is when a tool call can still happen and a prompt can no longer
  change. Selecting every skill and pasting it was tried for one afternoon and
  reached 2106 words of appendix for the orchestrator regardless of the task.
  `--skills` remains a pin -- "use exactly these", pasted as before -- for when
  the operator does know better.
- 2026-09-17: `--no-skills` is the explicit off for the skill capability,
  declared once in the shared pipeline options for every command that runs a
  role: no catalogue in any prompt, no loader tool registered, no appended
  instructions. It cannot be combined with `--skills` -- exactly one of pin,
  off, or default resolves. Background workers inherit the off like they
  inherit a pin.
- 2026-09-17: A persistent setting lives in the user profile at
  `~/.config/ad-coder/profile.json`: `"capabilities": {"skills": false}` turns
  the skill capability off for every run; the field absent or `true` is the
  built-in enabled default. This is an optional field accepted by the v1
  profile parser -- not a v2 bump -- so existing exports and stored profiles
  stay valid; the field is carried through export/import verbatim and omitted
  when unset. Layer order: explicit launch parameter beats the setting beats
  the default. `--no-skills` and `--skills` are both explicit, so a `--skills`
  pin disables the setting in its own direction too.
- 2026-09-17: `role-selection` is a shipped skill, scoped to the orchestrator: the
  three execution paths (direct editing, roles only, roles plus pipeline) with
  their tool markers, what each delegable worker role does and returns, and the
  conditions under which delegation is the wrong call. The orchestrator prompt
  keeps only one line per delegation surface and points at this skill and at the
  `run_role` tool description for the live half; duplicating either in the
  unconditional prompt is the defect issue #232 diagnosed, and a role
  description that restates the role's own prompt teaches nothing by the
  2026-09-16 rule.
- 2026-09-17: The resolved skill set is visible in `config show`: a `skills`
  row carries every skill a run can reach as id, version, source tier
  (`builtin`/`project`), and the SHA-256 digest of the loaded content, plus the
  winning layer (`cli`, `profile`, or `built-in-default`). A pin reports
  exactly the pinned ids; the default enumerates the catalogue across all
  roles and, like a per-role catalogue, skips an entry that fails to resolve
  rather than failing the default path -- the count an operator sees is the
  count a role can load.
- 2026-09-17: A manifest may declare two optional fields beyond the catalogue.
  `always` is a boolean, default false, and `requires` is
  `{workflows: [names]}` and/or `{plugins: [names]}`. `always: true` pastes the
  skill's instructions into the prompt of every role in its `roles` list, in
  catalogue AND pin mode, without the role asking -- so it is justified only
  where a role cannot understand its own situation without the text, never
  where the text is merely useful. The cost rule is beside it: pasting what is
  merely useful is how the orchestrator reached 2106 words of appendix
  regardless of task, and the session measurements behind the catalogue found
  93% of input tokens served from cache precisely because a prompt is re-read
  every turn. `--no-skills` -- and a profile with `capabilities.skills: false`
  -- still suppresses an always skill entirely: off is off. `requires` names
  what the session must actually have for the skill to exist at all: plugins
  are matched against really registered tool names (`explore_project`,
  `search_project`, `read_project`; `web_search`, `web_read`; `inspect_image`),
  workflows against the workflow modules the run resolved. A skill whose
  dependency the session does not satisfy appears in neither the catalogue, nor
  the paste, nor `config show`'s skill row; an undefined composition is treated
  as having nothing and fails closed. Because an always skill's text is already
  in the prompt, it is never listed in the catalogue -- `load_skill` for it
  answers `skill_not_available`.
- 2026-09-16: Loading obeys every constraint selection obeyed: the id pattern,
  the manifest's role scope, per-turn count and byte ceilings, and a typed
  content-free error carrying its reason. A refusal for a skill outside the
  role's scope says what the catalogue said, so it cannot be used to enumerate
  skills written for other roles.
- 2026-09-17: A skill is written for a TASK, and its `roles` list names every
  role that can perform that task -- not the one role whose title matches it.
  Any role can be switched off, and so can the pipeline, so knowledge that lives
  only in one role's prompt leaves the harness when that role does. The
  technique for editing code, verifying a change, modelling threats, researching
  outside the repository, mapping a surface and responding to overload are
  therefore skills, and a role prompt states what the role owns and points at
  them.
  The rule this replaces produced its own contradictions: `architecture-recon`
  was granted to the researcher, whose prompt said "Do not survey the
  repository", and withheld from the reviewer and auditor, whose prompts order
  exactly that work.
- 2026-09-17: A role prompt must not name a tool the role was not granted.
  Teaching the planner to batch `rg` and `git` reads when it has no `bash`, or
  the coder to call `explore_project` when that tool is filtered out of its
  grant, spends a turn on a call that cannot succeed and reads as a defect in
  the role. A skill shared across roles states which tool answers which question
  without assuming any particular grant. Enforced by a test over every built-in
  plugin combination.
- 2026-09-17: The summarizer's system prompt is `prompts/summarizer.md`,
  resolved through the same loader as every other role prompt and overridable at
  `.ad-coder/prompts/summarizer.md`. It was a string constant in
  `src/context/compactor.ts` -- the one role contract an operator could not
  change without rebuilding the package, governing what every later turn still
  knows.
- 2026-09-18: **The prompt carries the obligation; the skill carries the
  technique.** A rule that lives only in a skill a model may skip is advice, not
  a rule: the orchestrator had `delivery-calibration` granted and never loaded
  it, and dispatched a decomposed ticket ten seconds after reading it. So an
  obligation the role must produce -- size the work before dispatching it,
  delegate unfamiliar ground instead of reading it into the context that still
  has a run to carry, claim the issue, name the files before a coder sees the
  task -- is stated in that role's own prompt, while the skill keeps how to do
  it (issues #307, #330, #316, #293). This is the boundary against the
  2026-09-17 duplicate-the-prompt defect: restating the prompt is duplication,
  and an obligation the prompt never stated is not.
- 2026-09-18: **A skill's description says when the skill applies, not only what
  it contains.** The catalogue is everything a model sees before deciding to
  load a file, so "Estimate accepted-result cost" does not fire before a
  dispatch while "Size a ticket before dispatching it" does. Descriptions are
  the only always-read surface a skill has, which is why they are contract text
  and why a version bump is warranted when the wording changes.
- 2026-09-18: **A rule conditioned on something the dispatcher often does not do
  licenses the common case.** `coder.md` said "when the plan names affected
  files, do not run broad exploration", and the coder explored: with no file
  list the condition was simply false, so exploration was permitted and the
  budget went there instead of into code. A condition that is meant to gate the
  exception must be written from the rule's side -- the obligation stands, and
  a dispatcher who cannot name the files owes a planner or researcher pass
  first (issue #316).
- 2026-09-18: **A skill that applies is binding, and the rule that says so names
  no skill.** The obligation is stated in general words on the two surfaces
  every role reads: the catalogue header `formatSkillCatalogue` emits, and the
  role's own prompt ("Your skills catalogue lists the methods for this work:
  where one of them describes what you are doing, loading it and following it is
  mandatory rather than optional, and the technique in it governs over your own
  habit"). Naming a skill in a prompt is wrong twice over: the enumeration
  ("Load `x` when y") is advice a model skims past -- the orchestrator held
  `delivery-calibration`, never loaded it, and dispatched the decomposed ticket
  seconds later -- and with `--no-skills`, a pin, or an unmet `requires` it names
  a capability that session does not have, which the 2026-09-17 tool-grant rule
  already forbade for tools. The seven role prompts' tails were deleted; the
  conditions they carried ("when the surface is elevated and no security stage
  will run") moved into the descriptions, which is where a model reads them
  before deciding. Enforced by a test that no shipped prompt contains a
  backticked skill id, and one that the catalogue header carries the rule.
- 2026-09-18: **Every shipped skill opens by stating that its instruction is
  mandatory.** The first line of every `instructions.md` is the same sentence --
  "**This instruction is mandatory.** Where this skill's description matches the
  work in front of you, the method below is required: an approach that
  contradicts it is a defect to fix, not a preference to keep." -- followed by a
  blank line so it reads as a statement about the skill rather than as the
  technique's opening sentence. The catalogue header binds the set; this binds
  the one skill a role has already loaded, been handed by a pin, or received as
  an `always` paste, which no header reaches. The wording is identical in all
  thirteen because it is a rule about skills, not a habit of each author; a test
  reads the shipped directory and fails on the first skill whose opening line
  differs.
