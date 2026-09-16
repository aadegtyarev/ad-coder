# CLI contract

Rules for ad-coder's command-line front. A violation is always blocking.

- 2026-09-11: The CLI is a THIN front over the programmatic core (see
  `architecture.md`). Its whole command surface — every command, every option,
  every positional argument, each with a one-line description — is declared in
  ONE place, a single command/option registry. Both dispatch AND help render
  from that one declaration; there is no second source of truth.
- 2026-09-11: `ad-coder --help` and `ad-coder -h` print the full command list;
  `ad-coder <command> --help` prints that command's options and arguments. All
  help text is DERIVED from the registry — never a hand-maintained usage string.
  A run with no command, or an unknown command or flag, prints that same derived
  usage (to stderr, non-zero exit); `--help` is a success (stdout, exit 0).
- 2026-09-11: Adding or changing a command, option, or argument means updating
  its registry entry — description included — so help stays correct
  automatically. A hand-written usage/help string that can drift from the actual
  commands is exactly the violation this contract exists to prevent. This is the
  human half of architecture.md's "friendly to humans AND machines".
- 2026-09-12: A model-backed CLI operation immediately identifies its role or
  stage on stderr, emits a configurable periodic heartbeat while no result is
  available, and applies a configurable provider-request timeout. Zero disables
  heartbeat or timeout explicitly. Machine-result stdout stays free of progress
  text, and timeout is a visible non-success rather than an empty completion.
- 2026-09-14: In a TTY, `Escape` interrupts only the active orchestrator turn;
  the conversation session and detached background runs remain alive.
  Console-local background start/list/events/status/result/cancel commands
  execute through the headless manager and never dispatch a model turn.
- 2026-09-15: A command that starts background work is available wherever the
  session can host it: a console that admits background runs also carries the
  launcher and owner scope needed to start one, and the background run options
  are declared once for every command that builds a manager. Console controls
  render in the order they were typed even when one of them awaits a launch.
- 2026-09-15: Every front — machine JSON, console, and any later TUI — offers the
  SAME capabilities and differs only in rendering. A decision an operator can make
  through one front is reachable through all of them, because the decision itself
  lives in shared headless code (a control registry, a structural control
  interface) that each front renders. A capability available only on one front, or
  a front holding its own copy of state another front mutates, is a violation.
- 2026-09-16: An operator can send a multi-line message through every console
  entry path, and a message boundary is NOT the newline. A piped (non-tty)
  stdin run is read whole until EOF and dispatched as ONE turn, with interior
  newlines preserved; console-command-looking lines inside such a message are
  prompt text, never controls. In a TTY the same paragraph is assembled by a
  paste-aware read: bracketed paste (`ESC[200~` … `ESC[201~`) joins pasted
  lines into the current message, and `/task <path>` dispatches a whole file
  as one turn whose content is also never executed as controls. The formatted
  console requests bracketed paste; the machine JSON front emits no terminal
  control sequences on stdout, so there `/task` is the way to send a whole
  brief. `maxInputBytes` bounds ONE message, not one line.
- 2026-09-16: A piped stdin run that consists of a sequence of newline-separated
  console controls no longer executes them one by one: piped stdin is a brief,
  not a control script (see the entry above).
- 2026-09-15: A front that runs model turns leaves the same durable audit trail
  regardless of which front it is: it writes the run's ledger under
  `.ad-coder/ledger/<runId>.jsonl` and names that path, with the run id, on
  stderr before the first turn. A front needing to read its own numbers back
  (per-step cost, session spend) holds a readable sink that MIRRORS to that
  file; replacing the durable sink with the readable one is a violation. Ledger
  rows stay identifiers and numbers only — never prompts, payloads, or tool
  arguments.
