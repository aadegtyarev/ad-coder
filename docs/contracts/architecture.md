# Architecture contract

This contract governs the product's structural shape: a programmatic core and
the fronts and optional compositions built around it.

## Guarantees

- Every capability lives in a programmatic core. The TUI, CLI, APIs, and other
  fronts adapt that core; they do not own independent product behaviour.
- Every capability is reachable programmatically and through a documented
  non-interactive machine interface. No capability is interactive-front-only.
- Workflow modules register by name and are independently selectable. A disabled
  module exposes none of its tools.
- General file, exploration, web, and media plugins do not depend on the built-in
  pipeline. A caller that selects a plugin can use its headless API directly.
- A worker role is independently delegable whether or not a workflow module is
  enabled. The pipeline is an optional composition of roles, not their gateway.

## Related surfaces

- [Command-line front](cli.md).
- [Machine API](machine-api.md).
- [Role and tool wiring](role-tools.md).
- [Task orchestration](orchestrator.md).
- [Terminal UI](terminal-ui.md).
