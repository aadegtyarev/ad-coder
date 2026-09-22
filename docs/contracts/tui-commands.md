# TUI operator commands contract

This contract owns commands available to an operator in `ad-coder tui`.

## Guarantees

- Every execution action available to the orchestrator is reachable by an
  operator: start a named role, the universal `generic` role, an ad-hoc agent,
  a workflow, or the built-in pipeline. The TUI invokes the same headless action,
  never a front-specific implementation.
- Every TUI command and status projection has an equivalent machine command with
  the same action, validation, result, and error semantics in stable JSON. No
  TUI-only or machine-only capability is permitted.
- `/roles` lists built-in and custom roles including `generic`, with syntax and
  an example; `/roles <name> <task>` launches that role. `/agent <prompt>`
  launches an ad-hoc agent. `/workflows` lists reachable workflow modules,
  including the pipeline; `/workflows <name> <task>` launches one.
- Role, agent, and workflow launch controls list whether isolated parallel lanes
  are available. Their parallel form requests a mutable scope and follows the
  same shared admission as the machine API; it is refused outside the Git
  workspace adapter rather than running unisolated.
- `/sessions` lists accessible sessions with number, title, target, state, and
  syntax/example; `/sessions select <number>` selects one through the shared
  manager. It queues selection after any active turn and makes later ordinary
  input target the selected session.
- `/status` shows the selected session's bounded state and ledger projection;
  `/about` shows harness name, version, enabled capabilities, and concise help.
  Both are local read-only controls with matching machine API actions.
- `/skills` lists reachable skills with applicability, syntax, and an example.
  `/skills load <id>` and `/skills unload <id>` alter the active session's
  explicit skill selection through the shared resolver and durable session state.
- `/estimates` shows the current full-cycle forecast and relevant aggregated
  planning feedback without mutating work. Its machine-equivalent action is
  equally read-only and presents the same bounded evidence.
- `/quality` shows bootstrap and gate status with syntax/example. Its actions
  propose, approve, decline, inventory, and revalidate a profile through shared
  headless operations; approval is required before an action that installs tools
  or writes quality configuration.
- `/practices` lists selected and available practice bundles with syntax/example.
  Its inspect, preview, enable, disable, update, replace, and remove actions use
  shared headless operations and always show affected assets before mutation.
- `/compact` explicitly compacts the selected session's eligible dialogue using
  its configured strategy. `/clear` explicitly clears that conversation context
  while retaining the durable session and ledger; both show scope and recovery
  consequences before mutation and have matching machine actions.
- `/settings` lists setting groups rather than every key. `/settings <group>`
  lists that group, while its get/set actions expose profile or project scope,
  current value, and effective source through the shared settings registry.
- `/limits` shows effective ceilings and their source; its set action changes
  only the named configurable ceiling after validation. `/profile` shows the
  active profile, reachable models, role/agent mapping, declared prices, and
  effective source without credentials or provider payloads. `/profiles` lists
  selectable profiles with syntax and example; `/profiles select <name>` changes
  the active session profile through the shared routing resolver.
- Ordinary submitted input is a message to the shared orchestrator. Its status
  and interruption controls expose the same durable task state as the machine
  interface; a slash command is never required to begin that conversation.
- `/model` lists every model reachable through the active profile, with its
  number, assigned roles, declared price, and the current orchestrator choice.
  `/model <number>` makes that reachable model an explicit orchestrator-only
  override for the active session. It does not rewrite the profile or alter
  other role routes; an invalid number refuses before dispatch. A documented
  reset restores the profile's orchestrator route.
- A command with no required argument is local contextual help: it lists valid
  choices, syntax, and an example. It creates no provider call, orchestration
  request, run, wake, or event for the orchestrator.
- The operator has three explicit paths: send a request to the orchestrator,
  launch an action directly, or delegate execution-path and model choice to the
  orchestrator. Delegation obeys the current manual/auto mandate.

## Verification

Test TUI/machine command parity, every no-argument help path, local-only help
evidence, role/agent/workflow launch, skill selection durability, ceiling
validation, orchestrator messaging, profile switching, and credential-free
profile rendering; test model listing, override, reset, and read-only estimate
feedback; test session listing and idle/active-turn selection; test parallel-lane
availability and admission parity; test session status and harness-about parity.
Test grouped settings discovery, scoped mutation, source rendering, and API parity.
Test automatic and manual compaction, clear, retry exhaustion, and API parity.
Test practice discovery, no-write preview, selective enablement, modified-asset
removal refusal, and API parity.

## Related surfaces

- [Terminal UI](terminal-ui.md) owns interactive rendering.
- [Machine API](machine-api.md) owns machine resources and JSON envelopes.
- [Agent dispatch](agent-dispatch.md) owns launches.
- [Skills](skills.md) owns selection semantics.
- [Routing configuration](routing-config.md) owns model and price data.
- [Autonomy](autonomy.md) owns delegated authority.
- [Runtime inspection](runtime-inspection.md) owns status and about content.
- [Settings interface](settings-interface.md) owns grouped settings controls.
- [Compaction](compaction.md) owns compact and clear semantics.
- [Project practices](project-practices.md) owns portable guidance lifecycle.
