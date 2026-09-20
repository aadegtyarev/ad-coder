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
  when no ledger exists, and never writes anything. Since issue #435 it prints
  the published form the PR body carries: a prose lead-in followed by ONE
  fenced block whose first line starts with `runs=<count>`. `ad-coder stamp
  check`
  is the review-stamp gate (issue #239): the newest stamp in the marker-
  configured log must parse, carry an approved verdict, and name the current
  working-tree digest — anything else fails loudly with the reason. Both
  surfaces are read-only by construction; the stamp WRITER is the run-finish
  hook (`src/stamp/record-review-stamp.ts`), not a CLI hand-write path.
- 2026-09-18: `ad-coder stamp body-check <body.md> [files...]` is the stamp
  family's third surface and the pull-request-body gate (issue #335). The FIRST
  positional is the body file and the rest are ledger paths, read exactly as
  `stamp delivery` reads them; the body must carry the generated form -- the
  prose lead-in plus the fenced `runs=` block (#435) -- as the current ledger
  renders it, verbatim, and presence is that substring. A stale paste is
  recognized by shape, whitespace-tolerantly: any `runs=`-headed line or the
  prose lead-in that is not the fresh rendering fails as stale. A form that is
  absent or stale fails with the body file named and the render command to
  re-run; a matching body passes and nothing is written. It is read-only like
  its siblings, `ad-coder
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
- 2026-09-19 (issue #412): a resumed session SETTLES the operation that was in
  flight when the process died, before it dispatches the operator's next prompt.
  The durable session still records that operation as `running`, and the lane
  refuses any new prompt while it stands -- `LaneBusy`, an untyped harness error
  raised before the first provider call -- so every turn after `--resume` used to
  fail the same way, in milliseconds, leaving no ledger row to explain it: the
  session was unresumable in practice, however many times it was restarted. Four
  rules follow. (1) Settlement is AUTOMATIC and comes FIRST: finding an installed
  operation, the conversation drives it to a settled record (`lane.resume`) and
  only then sends the operator's input. This is the rule the single-turn runner
  already applies to a resumed stage (`resumeActiveOperation`,
  src/runner/runner.ts), reached here through the multi-turn conversation that is
  its counterpart. There is no flag, no confirmation prompt and no separate
  repair command: `--resume` followed by a prompt is the whole recovery, and a
  settlement that fails surfaces as that turn's own failure rather than as a
  silent refusal to work. (2) The rules are KIND-AGNOSTIC: a provider call, a
  tool call, and an operation whose cancellation was requested all settle through
  that one call, and the conversation never second-guesses the harness's own
  reconciliation -- an operation the harness reconciles to aborted or to an
  interrupted (not re-executed) tool settles as such. (3) A settlement that
  leaves a DEFERRED run (`status` "suspended") raises the existing typed
  `SuspendedRunError`; a record the caller would read as settled hides a run
  still pending, so no prompt is sent into the occupied lane. (4) The recovered
  operation's answer belongs to THAT operation: it stays in the durable history
  and in the ledger, and is never returned as the answer to the input the
  operator just sent -- a front rendering it as the reply to a new question would
  attribute an old answer to a new prompt. Recovery is attributed rather than
  silent: the settlement runs inside the turn's own ledger bridge, so its tokens
  land on the turn that performed it -- the row carries the `turn:N` step the
  conversation always writes, and its `runId` is the RECOVERED operation's own id
  (the id installed when the process died, which `lane.resume` continues rather
  than replacing), so the settlement's cost is distinguishable from the cost of
  the prompt that follows it. The cost is neither dropped nor merged into an
  unidentified row.
- 2026-09-19 (issue #425): a stamp-gate failure is a FACT with an action, and
  its fronts say both instead of shorthand-ing into a usage error. `ad-coder
  stamp check` and `stamp body-check` route gate failures (stale digest,
  changes_requested verdict, absent or stale delivery block, malformed or
  missing newest stamp) through their own `failGate` path: the human front
  prints the reason then the recovery action on stderr with NO derived-help
  render, and the machine front (`--json`) prints the structured shape
  `{ error: { code: "gate_failed", text, retryable: false, nextAction } }`
  -- never the `usage` code, because a stale stamp is not a commandline
  mistake. The reason names what failed AND why (the reviewed tree moved;
  any later commit, dependency bumps and the CHANGELOG heading included,
  makes the stamp stale), the action names the recovery (a fresh review
  round over the CURRENT tree via a settled run, whose run-finish hook
  `recordReviewStampFromResult` appends the stamp; the stamp is never
  written by hand). Argument errors -- unknown flag, unknown action, extra
  positional -- stay on the `fail()` path: derived help on the human front,
  `usage` code on the machine front, unchanged.
- 2026-09-20 (issue #452): a dispatch (typed line or `/task`) submitted while
  a turn is active keeps its place and runs once the active step settles;
  a refusal never silently drops a dispatched payload. When the payload
  cannot be delivered — the retry cap is exhausted or the session closes — it
  is reported as a typed failure that says the task was NOT accepted and names
  the source (the task path for `/task`, otherwise that the queued line was
  not accepted), so a fifo dispatcher can retry it. A dispatch waits for the
  active step only up to the console's settle budget; past it the failure is
  the typed not-accepted outcome that names the source, so the dispatcher
  retries it — and shutdown stays finite (ui-responsiveness.md). This restores
  the promise from issue #397 that a dispatched line's queue position is
  exactly where it was typed.
- 2026-09-20 (issue #479): `ad-coder runs stop <run-id> --target-dir <dir>`
  stops ONE run through the process identity the run's own record carries
  (`<target>/.ad-coder/runs/standalone-<runId>.json` for a standalone role
  run, `background/<runId>.json` for a background worker). It exists because
  the machine-wide spelling of "stop my run" -- a command-line pattern match
  -- matches every lane on the machine at once and killed another lane's run
  (measured 2026-09-20). Options: `--target-dir <dir>` (required; spelled as
  the run was started, because the identity check compares exact argv
  tokens), `--json` (stable JSON result on stdout; misses and refusals as
  the structured error shape on stderr with every check inside it), `--kill`
  (bounded wait after SIGTERM, then SIGKILL), `--kill-after-ms <n>` (default
  2000, requires `--kill`), `--group` (signal the run's process group;
  refused unless the record proves the run leads that group, so a lane's
  shared group is never signalled). Exit codes: 0 a signal was delivered to
  the verified pid (escalated when `--kill`); 1 nothing to stop -- no record
  names the id, or the run is already gone; 2 usage error; 3 refusal, with
  nothing signalled. The refusal is an INVARIANT, not a heuristic: NOTHING
  is signalled unless the pid is positively tied to that run and that target
  -- the record must be readable (a corrupt record is a refusal, never a
  crash and never a licence to signal anything), must carry a pid, that pid
  must be alive and not an unreaped zombie, its `/proc` start time must
  match the recorded one (a reused pid fails here), and its command line
  must carry BOTH the stopper's `--target-dir` spelling and the run's own
  witness tokens; a directory that is merely a PREFIX of the real one is a
  refusal, not a near-hit. Every miss prints exactly what was checked. The
  one miss that is not a refusal is a dead pid: the run reads as already
  gone (exit 1), not as a crash and not as a stop. A stop writes its
  stop-request witness (`stop-<runId>.json`) BEFORE the first signal
  leaves, so a victim that dies before it can record anything is still
  distinguishable from one that fell over.
