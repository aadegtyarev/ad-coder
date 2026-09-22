# Machine API contract

This contract owns the public non-interactive `ad-coder api` command family.
It is the JSON projection of headless operations and TUI controls.

## Guarantees

- `api` is the only public machine interface. Each invocation accepts one
  documented action and produces one stable JSON result on stdout; diagnostics
  go to stderr. It never emits TUI bytes, progress prose, or mixed formats.
- API resources mirror operator controls exactly: `orchestrator` accepts a
  message and reports durable task state; `agents` lists and starts named,
  generic, and ad-hoc agents; `workflows` lists, starts, and drives workflow
  sessions; `skills` lists, inspects, selects, loads, unloads, and sets discovery
  mode; `limits` shows and sets ceilings;
  `profiles` lists, shows, and selects profiles; and `runs` lists, inspects,
  gracefully cancels, or where eligible force-cancels a durable run. `sessions`
  lists, selects, and renames accessible sessions. `settings`
  lists groups, reads effective values, and changes a validated scoped setting.
  `sessions.inspect` projects session/ledger state and
  `harness.about` projects identity/version/capabilities; `quality` exposes
  bootstrap status and its propose/approve/decline/inventory/revalidate actions;
  `sessions.compact` and `sessions.clear` perform explicit context recovery;
  `estimates` returns the current forecast and planning feedback read-only. The
  `practices` resource lists, inspects, previews, enables, disables, updates,
  replaces, and removes portable project practices with the same guarded mutation
  semantics as TUI. `waits` lists, creates, inspects, cancels, and retries
  supported durable condition waits through the same service. The
  public names may be refined only through the compatibility contract, not by
  adding a front-only capability.
- API requests use explicit fields rather than TUI command text. Their success,
  refusal, validation, run identity, durable state, and machine-readable error
  have the same semantics as their TUI counterpart. A read or list action makes
  no provider call or orchestration wake.
- Agent and workflow starts may request an isolated parallel lane with a mutable
  scope. The API returns the same admission, queue, refusal, and lane identity
  as TUI; it never substitutes an unisolated mutable run.
- `orchestrator.send` submits a task message to the project's shared
  orchestrator session. It supports the same current manual/auto mandate,
  profile selection, ceiling settings, interruption, and durable recovery as
  the TUI; it is not a reduced automation-only interface.
- Profile selection is an explicit, validated session or launch choice. It
  changes the selected profile for subsequent dispatch through the standard
  precedence rules, reports the effective routing and declared price view, and
  never exposes credentials or provider response bodies.
- `orchestrator.models` returns the active profile's reachable models, their
  assigned roles, declared prices, and numbered selection view. Its select and
  reset actions make or clear an orchestrator-only session override. They never
  mutate the profile or silently reroute another role.
- Session and run resume actions expose the same recovery outcome as TUI,
  including restored context/state, queued messages, and typed paused ambiguity.
- Internal headless primitives remain implementation details, not CLI
  compatibility promises.

## Verification

Test one-JSON-result output and stderr separation; parity for every TUI action;
orchestrator conversation and recovery; profile selection and route visibility;
model listing and override/reset.

## Related surfaces

- [CLI](cli.md) owns command registry and transport boundary.
- [TUI operator commands](tui-commands.md) owns human controls and parity.
- [Session manager](session-manager.md) owns shared session state.
- [Routing configuration](routing-config.md) owns profile content and routes.
- [Orchestrator](orchestrator.md) owns task lifecycle.
- [Resumability](resumability.md) owns recovery semantics.
- [Task estimation](task-estimation.md) owns forecasts and feedback.
- [Parallel lanes](parallel-lanes.md) owns concurrent-lane semantics.
- [Runtime inspection](runtime-inspection.md) owns status and about projections.
- [Quality bootstrap](quality-bootstrap.md) owns quality setup actions.
- [Settings interface](settings-interface.md) owns grouped settings actions.
- [Compaction](compaction.md) owns explicit context recovery.
- [Project practices](project-practices.md) owns portable guidance lifecycle.
- [Run control](run-control.md) owns run cancellation.
- [Skills](skills.md) owns skill controls.
- [Waiting](waiting.md) owns condition waits.
