# Role catalog contract

This contract owns the names and prompt sources of reusable roles.

## Guarantees

- Built-in roles ship with ad-coder and retain their stable names and default
  prompt sources. A project prompt with a built-in name overrides that prompt
  under the existing trusted-project-prompt boundary.
- `generic` is a built-in role for a bounded arbitrary task. It appears beside
  named specialist roles in every operator and orchestrator role catalogue.
- `quality-bootstrapper` is a built-in role that inventories approved project
  tooling, applies an approved quality profile, and validates its gates. Research
  selection remains the researcher's responsibility; installation authority is
  resolved separately.
- `summarizer` is a built-in internal role for context compaction. It has normal
  role configuration but is not a general operator-dispatch target.
- A prompt file with a new safe role-name stem creates a project-local custom
  role. Removing that file removes the custom role; removing an override restores
  the built-in role rather than deleting it.
- Discovery is bounded, deterministic, and visible in effective configuration.
  Duplicate, malformed, escaping, or oversized role prompts fail before provider
  dispatch. Role names are validated before path construction.
- A prompt alone defines role identity and instruction. Tool grants, model route,
  budgets, and external-effect authority remain separately resolved policy; a
  custom prompt never obtains them implicitly.
- Fixed-role skill eligibility and required/default selection are resolved policy,
  not prompt prose. A role may restrict or require named skills; an ad-hoc agent
  receives only the explicitly resolved skill subset.
- A custom role and ad-hoc agent default to every enabled project tool except
  workflow submission tools. `agents.defaultToolGrant` can replace that default;
  a named grant remains visible in effective configuration.
- Built-in and custom roles are independently selectable and disableable. A
  removed or disabled role is unavailable to both an operator and orchestrator
  with an actionable typed refusal.

## Configuration

Project role prompts follow the project prompt-root setting and trusted override
rules. `agents.defaultToolGrant` and enablement use standard settings precedence.

## Verification

Test built-in override and restoration, custom create and removal, deterministic
discovery, invalid-name and escaping refusal, resolved-catalog visibility, and
policy separation from prompt text.

## Related surfaces

- [Role tools](role-tools.md) owns executable grants.
- [Agent dispatch](agent-dispatch.md) owns running roles.
- [Security](security.md) owns trusted project prompt configuration.
- [Quality bootstrap](quality-bootstrap.md) owns setup workflow semantics.
- [Compaction](compaction.md) owns summarizer invocation.
- [Skills](skills.md) owns selection and inheritance.
