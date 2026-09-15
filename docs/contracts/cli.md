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
