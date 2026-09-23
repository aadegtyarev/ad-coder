# Role and tool wiring contract

This contract governs the executable relationship between a role's declared
tools and the tool objects registered for the request that serves that role.

## Guarantees

- Every name in `activeToolNames` has a registered tool object in the serving
  process. A declaration that names a missing tool is invalid.
- A delegated role receives its result as assistant text. Workflow submission
  tools are not declared for that independent invocation.
- The orchestrator receives the read-only runtime-inspection tools declared by
  [runtime inspection](runtime-inspection.md). Their output remains bounded and
  uses the same redaction as the operator-facing projection.
- The orchestrator receives the settings read/set tools declared by
  [settings interface](settings-interface.md); their authority and mutation path
  are identical to the operator-facing controls.
- The orchestrator receives the wait list/create/inspect/cancel/retry tools
  declared by [waiting](waiting.md). Their source adapters, durable lifecycle,
  and bounds are identical to operator-facing controls.

## Verification

- Tests construct every delegated role with the tool registry it receives and
  reject a declared name that is absent from that registry.

## Related surfaces

- [Product structure](architecture.md).
- [Skill selection](skills.md).
- [Role catalog](role-catalog.md) owns prompt-defined identities.
- [Agent dispatch](agent-dispatch.md) owns invocation and lifecycle.
- [Runtime inspection](runtime-inspection.md) owns inspector semantics.
- [Settings interface](settings-interface.md) owns settings tool semantics.
- [Waiting](waiting.md) owns wait semantics.
