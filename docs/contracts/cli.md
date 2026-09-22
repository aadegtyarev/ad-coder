# CLI contract

This contract owns ad-coder's command-line front and its human/machine boundary.

## Guarantees

- One command and option registry owns dispatch and all help. `--help` succeeds
  on stdout; missing or invalid command syntax prints derived usage to stderr and
  fails. No hand-written usage may drift from the registry.
- The CLI is a thin front over shared headless state. Every front exposes the
  same operator decisions and durable run trail; they differ only in rendering.
  Machine stdout contains only the machine result, never progress or terminal
  control sequences.
- Model-backed operations identify role or stage on stderr, emit configurable
  heartbeat and request timeout status, and make a timeout a visible failure.
  Zero explicitly disables heartbeat or timeout.
- Every model-turn front creates and names its durable ledger before the first
  turn. Readable live sinks mirror that append-only file; ledger rows contain
  identifiers and numbers, never prompts, payloads, or tool arguments.
- A non-TTY stdin stream is one whole message through EOF, preserving internal
  newlines; it is never an interactive-control script. TTY bracketed paste and
  `/task <path>` likewise submit one whole message. `maxInputBytes` bounds the
  complete message, not a line.
- `tui` is the sole interactive human command. `api` is the sole public
  non-interactive command family. `api` owns JSON transport. Neither `api` nor
  its JSON result loads terminal UI code.
- `stamp delivery`, `stamp check`, and `stamp body-check` are read-only fronts
  over the delivery and review evidence contracts. Argument errors are usage
  failures; a stale or missing gate condition is structured `gate_failed` with
  reason and recovery action, never a usage error.

## Verification

Test registry-derived help, TTY and piped input, human and JSON output separation,
ledger creation, timeout, TUI command selection, and stamp command read-only
behaviour.

## Related surfaces

- [Review evidence](review-evidence.md) owns stamp validity.
- [Product changes](product-change.md) owns delivery signature content.
- [Terminal UI](terminal-ui.md) owns interactive terminal rendering.
- [Machine API](machine-api.md) owns API resources and JSON envelopes.
- [Session manager](session-manager.md) owns session resume and background state.
- [Run control](run-control.md) owns targeted process stopping.
