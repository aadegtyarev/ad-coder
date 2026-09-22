# Session manager contract

This contract owns the headless `SessionManager` API for shared durable sessions.

## Guarantees

- Owner state, outside target projects, maps a validated driver key to a project
  key and project record. A project has one shared durable orchestrator session;
  TUI, machine API, Telegram, and future fronts are views of it, not separate
  sessions.
- A project key is one safe slug path component. Allow roots are normalized and
  realpathed at construction; every filesystem use re-realpaths and verifies
  segment-aware containment after the syscall. A symlink swap or outside path
  fails before a binding persists.
- Bindings use a versioned, atomic, secret-free schema and validate on every
  read against current allow roots. An invalid binding is a surfaced failure, not
  a silent deletion or automatic project creation.
- Creation exists only in the core, is exclusive and idempotent, rejects existing
  non-empty directories, has a finite configurable volume limit, and executes
  `git init` as argv against the validated realpath.
- Project-store lock retry defaults to delays of 10, 20, 40, and 80 milliseconds:
  acquire immediately, then retry once after each delay. A supplied schedule is
  a non-empty array of positive safe integer milliseconds; invalid keys or values
  fail before acquisition. A proven dead holder is reclaimed without waiting.
- Standalone lease detection is read-only. The manager never steals a live
  standalone session; a completed handoff requires both durable handoff events
  and the standalone owner's release before adoption of its session id.
- The API declares list, create, bind, resolve, rename, and handoff. Fronts only
  translate it; no front owns a private copy of manager state or a front-only
  action.
- TUI and machine resume actions validate an id before path use and require both its
  session and ledger. Without an id it selects the newest qualifying orchestrator
  ledger. It settles an interrupted active operation before accepting new input,
  retains the recovered answer with that operation, and attributes recovery cost
  distinctly in durable ledger data.
- Input is accepted into a durable FIFO queue regardless of whether an
  orchestrator turn is active. With no active turn, the queue starts delivery
  immediately; otherwise the oldest message is delivered to the next turn after
  settlement. If shutdown prevents delivery, every retained message fails
  explicitly with its source rather than disappearing.

## Failures

Manager failures use a stable typed code, concise safe text, and a next action
when recovery exists. They name keys and field paths, never credentials or raw
provider bodies.

## Verification

Test containment and symlink races, invalid bindings, concurrent creation,
two-sided handoff, resume selection and settlement, immediate idle delivery,
FIFO next-turn delivery, and queued-input refusal at shutdown.

## Related surfaces

- [Session transport](session-transport.md) owns same-user socket access.
- [Session titles](session-titles.md) owns display-name generation and sanitizing.
- [CLI](cli.md) owns command rendering; [Telegram](telegram.md) owns its front.
