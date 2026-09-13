# Tool observability contract

For users, machine clients, frontends, and tool authors, this contract answers:
how can someone understand what an active role is doing without exposing sensitive
arguments or drowning in implementation noise?

- Tool activity is emitted by the headless core as structured lifecycle events;
  CLI, TUI, JSON, and external frontends only render or transport those events.
- A long-running role reports semantic progress such as `Read`, `Search`, `Edit`,
  `Run`, `Web`, and `Inspect image`, including completion or failure. A heartbeat
  remains the fallback when no new activity is available.
- Human output groups repeated activity into a compact, incrementally updated
  summary. It does not print every low-level event or force the user to infer that
  the process is still alive.
- Machine mode exposes a stable event schema and keeps final-result stdout
  unpolluted. Consumers can correlate events with the role, run, turn, tool call,
  and parent operation without parsing prose.
- Event projections are allowlisted and bounded. They may include safe relative
  paths, operation names, counts, status, duration, and sanitized search labels;
  they never include credentials, environment values, prompts, file contents,
  arbitrary command arguments/output, request bodies, or unrestricted URLs.
- Tool lifecycle reporting is truthful: requested, started, completed, failed,
  cancelled, and timed out are distinct. Missing instrumentation never fabricates
  completion, and dropped events are counted visibly.
- Detached background pipelines may additionally emit owner-scoped,
  content-free bounded lifecycle pages through a headless subscription. These
  notices are tail-only hints, expose pending or dropped events visibly, and
  always preserve explicit cursor polling as reconnect recovery.
- Every configurable grouping, refresh, retention, and output limit has an
  efficient default and remains overridable under the configuration contract.
