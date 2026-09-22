# Settings interface contract

This contract owns human and machine discovery and mutation of behaviour settings.

## Guarantees

- Every parameter, switch, threshold, policy, and flag that changes product
  behaviour is a declared setting. A launch flag is only a temporary override of
  that setting, never a CLI-only behaviour branch. Task input, identifiers, and
  paths are inputs rather than settings when they do not alter policy.
- Each setting has a short unambiguous dotted name, one owning group, type,
  validation, default, description, and effective-value source. Groups describe
  a cohesive surface such as `ui`, `sessions`, `agents`, `workflows`, `quality`,
  `routing`, `modules`, `workspaces`, `security`, or `observability`; a setting
  cannot be duplicated across groups or hidden behind an undocumented alias.
- Profile and project settings files can set every declared setting allowed at
  their scope. Project values override profile values; a validated explicit
  launch override is transient and has its own visible source. Mutation validates
  before atomic write and refuses an unknown, read-only, or unsafe scope.
- `/settings` lists only available groups with concise descriptions, counts, and
  an example. `/settings <group>` lists that group's settings with current value,
  source, and concise description; `/settings get|set <group.key>` reads or
  changes one setting with scope made explicit. These views are bounded and never
  expand every setting into one unreadable screen.
- Machine API `settings.groups`, `settings.list`, `settings.get`, and
  `settings.set` expose the same registry, validation, scopes, values, sources,
  and errors as TUI. Local list/get/help performs no provider call, run, wake, or
  orchestration turn.
- The orchestrator has the same read and set operations through its tool grant.
  A set uses the shared validated mutation path, records the requesting task and
  effective scope, and obeys existing authority for profile or project changes;
  it never edits a settings file directly or receives a front-only setting.

## Verification

Test registry completeness for behaviour-changing flags, unique short names,
grouped bounded listing, profile/project/launch precedence, atomic invalid-write
refusal, source rendering, durable orchestrator mutation, and exact
TUI/API/orchestrator parity for list/get/set/help.

## Related surfaces

- [Configuration](config.md) owns resolution and persistence semantics.
- [Machine API](machine-api.md) owns JSON transport.
- [TUI operator commands](tui-commands.md) owns interactive controls.
- [Role and tool wiring](role-tools.md) owns orchestrator tool registration.
