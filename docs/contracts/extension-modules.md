# Extension modules contract

This contract owns optional modules around the ad-coder core.

## Guarantees

- The core owns sessions, orchestration, roles, workflows, durable state, and
  machine operations. A front, VCS, forge, transport, or integration module
  adapts those typed core operations; the core does not import or require a
  particular module.
- Modules declare a stable, versioned manifest with their kind, capabilities,
  configuration schema, and headless adapter. Kinds include interactive fronts
  (TUI, API, Telegram, web, Matrix), VCS/workspace adapters, forge adapters
  (GitHub, GitLab, or another host), workflow/tool providers, event transports,
  and lifecycle-hook providers. An enabled module exposes only its declared
  capabilities.
- Module selection is explicit configuration with visible effective source.
  An absent, disabled, invalid, or unavailable module removes only its own
  capabilities and produces a typed recovery action; it never disables core work
  or makes another module a hidden requirement.
- Modules communicate through versioned core contracts and durable identifiers,
  never by importing another module's private state or reproducing orchestration.
  They may subscribe to events and render them, but no front owns a separate task,
  session, or run lifecycle.
- VCS and forge adapters are independent. Git is optional; GitHub is optional;
  GitLab or another forge can be added without changing the core or a front.
  A workspace adapter supplies non-Git operation with its documented reduced
  isolation and delivery capabilities.

## Verification

Test core operation with no optional module, each module's manifest validation,
disabled-module capability refusal, independent VCS/forge combinations, adapter
version rejection, and identical session/run identity across two enabled fronts.

## Related surfaces

- [Architecture](architecture.md) owns core/front shape.
- [Session manager](session-manager.md) owns shared sessions.
- [Machine API](machine-api.md) owns the built-in machine front.
- [Worktree lifecycle](worktree-lifecycle.md) owns Git worktrees.
- [Lifecycle hooks](hooks.md) owns hook-provider semantics.
