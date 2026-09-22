# Skills contract

This contract owns discovery, selection, loading, and role/subagent composition
of portable skill bundles.

## Guarantees

- The core resolves bundled, profile, project, and enabled external skill sources
  through one bounded registry. Each entry exposes source identity, address,
  digest, standard name/description, trust state, and availability; duplicate
  names remain distinguishable by address rather than silently overriding.
- A session chooses one discovery mode: `manual`, `catalog`, `ranked`, or
  `adaptive`. `manual` exposes no optional skill until explicitly selected;
  `catalog` presents all reachable metadata and lets the model load any entry;
  `ranked` presents a bounded declared-scoring shortlist while retaining a tool to
  list and load the full reachable registry; `adaptive` selects catalog or ranked
  from configured context budget and registry size. An operator may override the
  effective mode for a session.
- Metadata is the only always-present skill context. Full `SKILL.md` instructions
  load only through explicit operator/orchestrator selection, role-required policy,
  or model/tool activation. Resources load on demand. The core never eagerly pastes
  every instruction bundle merely because a model has a large context window.
- A role policy independently declares reachable, default-selected, required, and
  denied skills. Required skills load before the turn; default-selected skills are
  offered by the selected discovery mode. A fixed role cannot bypass its deny list;
  an ad-hoc agent may receive an explicit allowed subset but never gains tool
  authority from a skill.
- Operator and orchestrator may select skills for a session, one dispatch, an
  ad-hoc subagent, or all eligible child dispatches. Explicit dispatch selection
  records source and inheritance scope, composes with fixed-role policy, and is
  visible before launch. A child receives only its resolved selection, not an
  implicit copy of every parent instruction.
- Every resolved selection is durable across resume: addresses, digests, mode,
  policy source, loaded instructions, and inheritance provenance restore before
  the next turn. A changed or missing source pauses only its affected operation
  with recovery choices; it never substitutes a same-named skill silently.
- Unknown, malformed, escaping, untrusted, unavailable, or over-budget skill
  selection refuses before provider dispatch. Limits apply to metadata catalogue,
  per-turn instructions, resources, and list output independently; an omitted
  entry states the applicable limit rather than looking absent.
- Skill loading and use are ledgered with safe address/digest and token attribution.
  The selector's shortlist, scoring source, and final model/operator choice are
  inspectable; vector or embedding retrieval is an optional selector module, not a
  hidden provider call or a prerequisite for catalog/manual use.

## Configuration

Skill source enablement and precedence, trust, discovery mode, metadata/context
budgets, ranking selector, role allow/default/required/deny policy, subagent
inheritance, and load/resource limits follow standard settings precedence.
`adaptive` is the default: it favours a complete catalogue when its metadata fits
the role's budget and a ranked shortlist otherwise. Manual selection remains
available for constrained local routes.

## Verification

Test standard-source discovery and duplicate addresses, all discovery modes and
budget transitions, full-registry escape from a shortlist, explicit/manual load,
role policy, subagent inheritance, no implicit tool grant, durable resume/digest
mismatch, selector observability, resource containment, and TUI/API/orchestrator
parity.

## Related surfaces

- [Skill authoring](skill-authoring.md) owns one skill's format and content.
- [Role catalog](role-catalog.md) owns fixed role identity.
- [Agent dispatch](agent-dispatch.md) owns child launches.
- [Role tools](role-tools.md) owns tool grants.
- [Resumability](resumability.md) owns durable recovery.
- [Settings interface](settings-interface.md) owns operator controls.
