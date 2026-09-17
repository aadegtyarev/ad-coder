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
- 2026-09-16: Event projections are bounded, and they name the SUBJECT a tool is
  acting on: the path read or written, the command run, the URL fetched, the
  query searched, and the line counts an edit moves. The operator needs these to
  see a role going the wrong way before it gets there. A path is not a secret to
  the person whose repository it is, and anyone able to start ad-coder can
  already read every file on the machine -- the former rule replaced such values
  with "unknown", which protected nothing and hid the only thing worth watching.
- Projections never include the CONTENT a tool returns or carries: file bodies,
  command output, response bodies, prompts. That is where a secret the operator
  never asked for actually surfaces. Credential-shaped VALUES inside a projected
  command or URL are replaced (`echo API_KEY=***`) while the shape stays
  readable, because terminal scrollback gets screenshotted and pasted.
- Tool lifecycle reporting is truthful: requested, started, completed, failed,
  cancelled, and timed out are distinct. Missing instrumentation never fabricates
  completion, and dropped events are counted visibly.
- Detached background pipelines may additionally emit owner-scoped,
  content-free bounded lifecycle pages through a headless subscription. These
  notices are tail-only hints, expose pending or dropped events visibly, and
  always preserve explicit cursor polling as reconnect recovery. Console notice
  callbacks are rendering-only: they never enqueue conversational input or call a
  model/session turn, and JSON notices stay on complete stderr lines.
- 2026-09-17: The rendered activity line names the SUBJECT, the WORKER, and the
  PRICE. A compound command is identified by its first meaningful command
  (`git status`, not a 120-character prefix) with a visible `…` marker when
  anything is cut, one call is ONE line that updates in place while it runs
  rather than a `started` line followed by a result line, role and model are
  named once a second role appears and hidden while only one works (never a
  literal `activity`), and every line where tokens or cost are known shows the
  stage spend so far alongside the remaining-capacity projection.
- Every configurable grouping, refresh, retention, and output limit has an
  efficient default and remains overridable under the configuration contract.
