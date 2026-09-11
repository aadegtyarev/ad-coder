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
