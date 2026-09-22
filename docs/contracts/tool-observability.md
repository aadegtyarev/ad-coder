# Tool observability contract

This contract governs safe, truthful progress information for an active role.

## Guarantees

- The headless core emits structured tool lifecycle events. CLI, TUI, JSON, and
  external fronts render or transport them without inventing lifecycle state.
- Long-running work reports semantic activity such as `Read`, `Search`, `Edit`,
  `Run`, `Web`, `Inspect image`, and `Skill`; a heartbeat is the fallback.
- Requested, started, completed, failed, cancelled, and timed-out states remain
  distinct. Missing or dropped instrumentation never fabricates completion.
- Machine output has a stable event schema and leaves final-result stdout clean.
  Events correlate to role, run, turn, tool call, and parent operation.
- Human output groups repeated events into compact incremental summaries rather
  than printing every low-level event or hiding that work is active.

## Safe projections

- A projection identifies the tool subject: a path, command, URL, query, line
  count, or skill identifier. It never contains returned file bodies, command
  output, response bodies, prompts, task text, or tool arguments.
- Credential-shaped values in a projected command or URL are redacted while its
  useful shape remains readable.
- A `load_skill` projection carries the raw accepted `skillId`, including a
  versioned catalogue address. Consumers normalize only when comparing it.
- A rendered activity line names the useful subject. Once several roles work it
  also names role and model; when known it shows current stage spend and capacity.

## Configuration

- Grouping, refresh, retention, and output limits have efficient defaults and
  remain configurable.

## Related surfaces

- [Role and tool wiring](role-tools.md).
- [Durable wake delivery](wake-delivery.md).
- [Settings](config.md).
