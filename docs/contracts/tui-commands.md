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
- `/skills` lists reachable skills with applicability, syntax, and an example.
  `/skills load <id>` and `/skills unload <id>` alter the active session's
  explicit skill selection through the shared resolver and durable session state.
- `/limits` shows effective ceilings and their source; its set action changes
  only the named configurable ceiling after validation. `/profile` shows the
  active profile, reachable models, role/agent mapping, declared prices, and
  effective source without credentials or provider payloads. `/profiles` lists
  selectable profiles with syntax and example; `/profiles select <name>` changes
  the active session profile through the shared routing resolver.
- `/orchestrator <message>` submits a message to the shared orchestrator; its
  status and interruption controls expose the same durable task state as the
  machine interface. The selected profile includes the orchestrator route, so an
  operator can change the orchestrator's model by selecting a profile rather
  than by editing an opaque front-local setting.
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
profile rendering.

## Related surfaces

- [Terminal UI](terminal-ui.md) owns interactive rendering.
- [Machine API](machine-api.md) owns machine resources and JSON envelopes.
- [Agent dispatch](agent-dispatch.md) owns launches.
- [Skills](skills.md) owns selection semantics.
- [Routing configuration](routing-config.md) owns model and price data.
- [Autonomy](autonomy.md) owns delegated authority.
