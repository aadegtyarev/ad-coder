# Architecture contract

Structural rules the operator declared for ad-coder. A violation is always blocking.

- 2026-09-11: Headless-first. Capabilities live in a programmatic core (a library);
  the TUI, CLI and any API are thin fronts. No logic lives in a front.
- 2026-09-11: Every capability is reachable programmatically — a library API and a
  machine-mode CLI (--json / --auto / non-interactive), never interactive/TUI-only.
  A machine (script, CI, external orchestrator, Telegram bridge) can do all a human can.
- 2026-09-12: Conversational workflow capabilities register through a named
  module registry and can be enabled or disabled independently. A disabled module
  exposes none of its tools. General file, exploration, web, and media plugins do
  not depend on the built-in pipeline; its direct headless API remains available
  to callers that explicitly select it.
- 2026-09-12: The Orchestrator may invoke any shipped worker role independently,
  whether or not a workflow module is enabled. Role delegation is a general
  orchestration capability; a pipeline is an optional composition of roles, not
  the gate through which all work must pass.
- 2026-09-17: Every name in any role's `activeToolNames` must have a registered
  tool object in the process that will serve the request. A listed name with no
  registered object is not a narrower role -- the provider rejects the whole
  turn (`configured_tools_unavailable`), as #236 did for delegated roles that
  inherited workflow submission tools by name. A delegated invocation delivers
  by assistant text, so workflow submission tools are never listed for one.
