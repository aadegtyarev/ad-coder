# Role catalog contract

This contract owns the names and prompt sources of reusable roles.

## Guarantees

- Built-in roles ship with ad-coder and retain their stable names and default
  prompt sources. A project prompt with a built-in name overrides that prompt
  under the existing trusted-project-prompt boundary.
- A prompt file with a new safe role-name stem creates a project-local custom
  role. Removing that file removes the custom role; removing an override restores
  the built-in role rather than deleting it.
- Discovery is bounded, deterministic, and visible in effective configuration.
  Duplicate, malformed, escaping, or oversized role prompts fail before provider
  dispatch. Role names are validated before path construction.
- A prompt alone defines role identity and instruction. Tool grants, model route,
  budgets, and external-effect authority remain separately resolved policy; a
  custom prompt never obtains them implicitly.
- Built-in and custom roles are independently selectable and disableable. A
  removed or disabled role is unavailable to both an operator and orchestrator
  with an actionable typed refusal.

## Configuration

Project role prompts follow the project prompt-root setting and trusted override
rules. Custom-role default grants and enablement use standard settings precedence.

## Verification

Test built-in override and restoration, custom create and removal, deterministic
discovery, invalid-name and escaping refusal, resolved-catalog visibility, and
policy separation from prompt text.

## Related surfaces

- [Role tools](role-tools.md) owns executable grants.
- [Agent dispatch](agent-dispatch.md) owns running roles.
- [Security](security.md) owns trusted project prompt configuration.
