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
  `delivery-calibration` and `repository-navigation` are the shipped skills.
  Their outputs respectively bound exploration, define a minimal
  acceptance-tested slice, verify delivery independently, estimate
  accepted-result cost before bounded dispatch, and keep repository questions to
  one call each.
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
- 2026-09-16: Loading obeys every constraint selection obeyed: the id pattern,
  the manifest's role scope, per-turn count and byte ceilings, and a typed
  content-free error carrying its reason. A refusal for a skill outside the
  role's scope says what the catalogue said, so it cannot be used to enumerate
  skills written for other roles.
