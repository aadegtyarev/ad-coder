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
- 2026-09-17: `ad-coder stamp delivery [files...]` renders the delivery
  signature (issue #240) from the named ledger files, or every
  `.ad-coder/ledger/*.jsonl` when none are named; `--target-dir` selects the
  project whose ledger is read (defaults to the current directory), matching
  `cost status`. The command is a READ: it refuses (usage error, path named)
  when no ledger exists, and never writes anything. `ad-coder stamp check`
  is the review-stamp gate (issue #239): the newest stamp in the marker-
  configured log must parse, carry an approved verdict, and name the current
  working-tree digest — anything else fails loudly with the reason. Both
  surfaces are read-only by construction; the stamp WRITER is the run-finish
  hook (`src/stamp/record-review-stamp.ts`), not a CLI hand-write path.
- 2026-09-18: `ad-coder stamp body-check <body.md> [files...]` is the stamp
  family's third surface and the pull-request-body gate (issue #335). The FIRST
  positional is the body file and the rest are ledger paths, read exactly as
  `stamp delivery` reads them; the body must carry the delivery block as the
  current ledger renders it, verbatim, and presence is that substring. A block
  that is absent, or present but no longer equal to the fresh rendering, fails
  with the body file named and the render command to re-run; a matching body
  passes and nothing is written. It is read-only like its siblings, `ad-coder
  stamp --help` states its arguments, and the shape a body carries is stated by
  `.github/pull_request_template.md`.
- 2026-09-18: `ad-coder console --resume [<run-id>]` continues a previous
  orchestrator session after a restart. The id is validated (`A-Za-z0-9_-`,
  1..64) BEFORE any path is built from it; the explicit form then requires BOTH
  the run's ledger `.ad-coder/ledger/<id>.jsonl` and its durable session under
  `.ad-coder/sessions/` to exist — a resume never creates a session or a ledger
  file, so an unknown or malformed id fails as a typed error naming the id and
  the recovery action. The bare form discovers the most recent ORCHESTRATOR
  session: a ledger qualifies iff it carries at least one record with role
  "orchestrator" AND step `turn:N` — the shape only the conversation front's
  own turns write (a standalone `role` run can write role "orchestrator" but
  with step "run"; drive/pipeline ledgers only ever carry stage roles; and the
  rule is ANY record, not the first, because a delegated `run_role` row can
  settle before the front's first turn row) — and the newest such ledger by
  mtime wins, with role/drive ledgers skipped even when newer. Either form
  seeds the front's readable sink from the resumed ledger so `show_cost` is
  cumulative across the restart; the seed is READ-ONLY on the ledger file and
  never replays rows back onto the append-only mirror (seeding through write()
  would duplicate every row on disk), and rows that cannot be read back
  (truncated, corrupt, oversized) degrade non-fatally with a stderr note. The
  banner still names the same run id and ledger file for a resumed session.
  Without the flag the default flow is byte-identical: a fresh session every
  start.
