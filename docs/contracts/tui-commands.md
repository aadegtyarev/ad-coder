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
- `/estimates` shows the current full-cycle forecast and relevant aggregated
  planning feedback without mutating work. Its machine-equivalent action is
  equally read-only and presents the same bounded evidence.
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
feedback.

## Related surfaces

- [Terminal UI](terminal-ui.md) owns interactive rendering.
- [Machine API](machine-api.md) owns machine resources and JSON envelopes.
- [Agent dispatch](agent-dispatch.md) owns launches.
- [Skills](skills.md) owns selection semantics.
- [Routing configuration](routing-config.md) owns model and price data.
- [Autonomy](autonomy.md) owns delegated authority.
