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
  non-empty directories, and has a finite configurable volume limit. It asks the
  selected workspace adapter to initialise the validated realpath: the Git
  adapter uses argv `git init`; a non-Git adapter creates no repository. An
  unavailable selected adapter fails before creation completes.
- Project-store lock retry defaults to delays of 10, 20, 40, and 80 milliseconds:
  acquire immediately, then retry once after each delay. A supplied schedule is
  a non-empty array of positive safe integer milliseconds; invalid keys or values
  fail before acquisition. A proven dead holder is reclaimed without waiting.
- A coordination directory whose owner identity was never published is inert and
  is reclaimed conservatively: only an absent or zero-byte, singly linked
  regular owner with no other entries qualifies. Any other shape is a refusal,
  never a guess.
- Standalone lease detection is read-only. The manager never steals a live
  standalone session; a completed handoff requires both durable handoff events
  and the standalone owner's release before adoption of its session id.
- The API declares list, create, bind, resolve, rename, and handoff. Fronts only
  translate it; no front owns a private copy of manager state or a front-only
  action.
- The manager lists accessible sessions and selects one for a requesting front.
  Selection changes that front's durable binding only after its active turn
  settles, never cancels or reassigns existing work. The selected session's
  identity, title, target, and resumable state are then projected by every front;
  free input and controls route to it until another explicit selection.
- TUI and machine resume actions validate an id before path use and require both its
  session and ledger. Without an id it selects the newest qualifying orchestrator
  ledger. They reconcile an interrupted active operation while accepting new input
  into the durable queue, retain any recovered answer with that operation, and
  attribute recovery cost distinctly in durable ledger data.
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

Test containment and symlink races, invalid bindings, concurrent creation with
Git and non-Git adapters, unavailable-adapter refusal, two-sided handoff, session
list/select during idle and active turns, resume selection and settlement,
immediate idle delivery, FIFO next-turn delivery, and queued-input refusal at
shutdown.

## Related surfaces

- [Session transport](session-transport.md) owns same-user socket access.
- [Resumability](resumability.md) owns checkpoint and recovery semantics.
- [Session titles](session-titles.md) owns display-name generation and sanitizing.
- [CLI](cli.md) owns command rendering; [Telegram](telegram.md) owns its front.
- [TUI operator commands](tui-commands.md) owns interactive selection controls.
