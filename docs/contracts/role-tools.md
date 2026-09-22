# Role and tool wiring contract

This contract governs the executable relationship between a role's declared
tools and the tool objects registered for the request that serves that role.

## Guarantees

- Every name in `activeToolNames` has a registered tool object in the serving
  process. A declaration that names a missing tool is invalid.
- A delegated role receives its result as assistant text. Workflow submission
  tools are not declared for that independent invocation.

## Verification

- Tests construct every delegated role with the tool registry it receives and
  reject a declared name that is absent from that registry.

## Related surfaces

- Product structure: `architecture.md`.
- Skill selection: `skills.md`.
