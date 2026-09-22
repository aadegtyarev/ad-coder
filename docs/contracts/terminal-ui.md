# Terminal UI contract

This contract owns the interactive `ad-coder tui` front. It is a projection of
headless session state, not a second orchestration or machine interface.

## Guarantees

- `tui` requires an interactive TTY. Non-interactive callers use the documented
  machine commands and JSON protocol; TUI control sequences never enter machine
  stdout.
- The TUI renders durable session, run, wake, activity, and error state through
  the shared core. It does not own routing, queueing, cancellation, provider
  clients, or mutable workflow state.
- A working turn never blocks editing, status, cancellation, exit, or input of a
  later message. Rendering preserves the editor buffer and cursor. Submitted
  messages retain visible FIFO order until accepted or explicitly refused.
- The TUI can launch a role or ad-hoc agent without leaving the editor blocked.
  It immediately renders the durable run identity and later projects shared
  progress and outcome; it does not implement dispatch policy itself.
- The default `plain` presentation is a sparse main-screen interface: scrollback
  remains available while differential rendering prevents progress noise and
  input corruption. Terminal mode, cursor, signal handlers, and bracketed-paste
  state are restored on every exit path.
- `tui.theme` selects a built-in visual theme and defaults to `plain`. Themes
  alter presentation only, never commands, authority, state, or machine output.
  Unknown themes fail loudly. A future richer layout is a separate presentation
  profile, not a change to the underlying interaction contract.
- The interactive renderer remains an optional human-front dependency; the
  headless core and machine commands do not load it.

## Configuration

`tui.theme` is configurable through standard settings precedence. The screen
strategy is independently configurable; `plain` defaults to the main screen and
a richer profile may opt into an alternate screen.

## Verification

Use a virtual terminal to test redraws during input, queued messages, resize,
paste, wake rendering, all exit paths, theme selection, TTY refusal, and the
absence of terminal bytes from JSON output.

## Related surfaces

- [Machine API](machine-api.md) owns the machine command interface.
- [UI responsiveness](ui-responsiveness.md) owns interrupt availability.
- [Session manager](session-manager.md) owns session state and recovery.
- [Tool observability](tool-observability.md) owns activity events.
- [Agent dispatch](agent-dispatch.md) owns background launch semantics.
- [TUI operator commands](tui-commands.md) owns controls and local help.
- [Orchestrator run observation](orchestrator-run-observation.md) owns result delivery.
