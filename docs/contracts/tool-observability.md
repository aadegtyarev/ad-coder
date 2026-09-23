# Tool observability contract

This contract governs safe, truthful progress information for an active role.

## Guarantees

- The headless core emits structured tool lifecycle events. CLI, TUI, JSON, and
  external fronts render or transport them without inventing lifecycle state.
- Every registered tool declares a semantic activity kind, safe subject projector,
  and human renderer before it can run. Long-running work reports actions such as
  `Read`, `Search`, `Edit`, `Run`, `Web`, `Inspect image`, and `Skill`; a heartbeat
  is the fallback only when a declared action has no new progress.
- A generic `Tool`, unknown-tool, object dump, or blank activity line is forbidden.
  A missing descriptor/refusal to render fails tool registration or the attempted
  invocation loudly with the tool id and repair action; it never degrades to a
  meaningless progress placeholder.
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
- Human path rendering preserves the basename and useful trailing directories,
  shortening from the left as `…/parent/file.ext` before removing the filename.
  Structured events retain the complete safe path identity; path-tail width is
  configurable and a renderer never substitutes an ambiguous bare directory.

## Configuration

- Grouping, refresh, retention, output limits, and path-tail width have efficient
  defaults and remain configurable.

## Verification

Test descriptor validation for every tool, refusal of placeholder rendering,
semantic output for a newly registered tool, compact repeated events, basename-
preserving path truncation, structured full-path identity, redaction, lifecycle
states, and human/machine parity.

## Related surfaces

- [Role and tool wiring](role-tools.md).
- [Durable wake delivery](wake-delivery.md).
- [Settings](config.md).
