# Telegram front contract

The Telegram front is a thin driver over the headless SessionManager and its
provider-admission boundary. This contract governs its room model, message
routing, input grammar, views, notification policy, and trust boundary. It is
the front-specific realization of `operator-flow.md` and
`ui-responsiveness.md`; those remain the general product-UX and responsiveness
rules and apply unchanged.

Rules the operator declared for ad-coder. A violation is always blocking.

## Room model

A room is the one addressable endpoint a message arrives on: a personal chat in
v1, and later one group topic. Everything the front does is keyed by room,
never by a hardcoded chat id.

- 2026-09-16: A binding maps `roomId -> sessionId` plus a `kind` that decides
  whether `sessionId` is mutable. `switchable` (personal chat) lets `attach`
  change it; `fixed` (a `(groupChatId, topicId)` room) sets it at creation and
  removes it at deletion. `sessionId: null` means nothing is selected. v1
  implements only `switchable`; the schema already admits `fixed`, so a topic
  mode is a second room kind, not a rewrite.
- 2026-09-16: Message handling, command dispatch, and event delivery depend on
  three room-level seams -- `resolveSession(room)`, `authorize(room, actor)`,
  `deliveryTargets(sessionId)` -- and no handler reads `chatId` directly or
  hardcodes "send to my chat". v1: `authorize` is the chat allowlist and
  `deliveryTargets` returns the personal chat; a topic mode replaces those two
  with membership and the bound topic, leaving the rest untouched.
- 2026-09-16: Session lifecycle is a headless SessionManager operation
  (`createSession(binding)` / `destroySession(binding)`), not a command body. A
  front triggers it (`/new` today, topic create/delete later); it does not own
  it.

## Message routing is deterministic

The bot never infers a destination from message content. Where a text message
goes is explicit state, and it is always legible.

- 2026-09-16: A text message goes to the session the pinned dashboard names.
  The front must not classify "which project this looks like"; a plausible typo
  or a similar-sounding task must not be routed to another project at cost.
- 2026-09-16: Two states decide where a text message may go. `selected` is the
  session the front is looking at, the target of its commands; `attached` is
  which interface owns the interactive turn stream. A text message is an
  interactive turn, so it requires both a selected session and this interface
  attached to it. In the normal path `/attach <session>` sets both at once.
- 2026-09-16: A text message with no selected session, or whose session is not
  attached to this interface, is not dropped and not guessed: the front answers
  with the missing state and the affordance to fix it (`Attach` / `Sessions`),
  fail-loud.
- 2026-09-16: A pending question carries its own session and overrides the pin
  for the reply: answering a decision raised for session B while pinned to A
  routes the answer to B. The pending state is scoped to one question and is
  cleared by its answer, its buttons, or a newer question.
- 2026-09-16: A Telegram `reply` is chat threading, not a routing signal. It
  must not bind a message to the session a replied-to message described.

## Input grammar

Three modalities, one command schema.

- 2026-09-16: Free text is a message to the selected, attached session; slash
  commands and inline buttons control the front. A text message is an
  interactive turn (the answer returns to the chat); a run dispatched with
  `/run` is a background pipeline (acknowledged, then reported by
  notification). The front must keep those two visibly distinct.
- 2026-09-16: Slash commands and console colon commands share one command
  schema. A command with no required argument returns command-specific help
  including syntax and an example; it never infers or executes a default
  mutation. Argument validation and help come from that one source, so the two
  fronts cannot drift.
- 2026-09-16: `attach <session>` moves interactive ownership; the target is
  marked pending and both fronts show progress until the active turn settles,
  at which point the transfer completes. A submitted turn is never cancelled by
  a transfer.

## Views

A view is one bot message; the pinned dashboard is the persistent home.

- 2026-09-16: The dashboard is a pinned message updated by edit, and only on
  state change: selected session, attach/detach, run start or stop, cost
  update. It never edits on per-tool activity, or the pin flickers.
- 2026-09-16: Attaching presents a catch-up card (project, profile, active
  turn, run statuses, cost, last activity) and offers paginated run
  history/status/result commands. It never replays raw transcripts into
  Telegram.
- 2026-09-16: Lists that can exceed one message (sessions, runs) are paginated
  with bounded pages and explicit back/next controls.

## Notification policy

The taxonomy in `operator-flow.md` applies; this front is more specific about
the two push kinds.

- 2026-09-16: A decision push is the only interruption. It reports a diagnosis
  and the available choices as buttons (change model, restate, abandon), never
  an open question.
- 2026-09-16: A milestone push (run started or finished, a cost spike crossing
  a threshold, a transfer settling) is informational and never blocks; it
  carries no required action. Milestones are coalesced within a bounded window
  and deduplicated per (session, kind). Progress -- steps, tool calls, stage
  transitions -- is pull-only via status/summary and is never pushed.

## Trust boundary and configuration

- 2026-09-16: The bot token comes from the credential store or an explicit
  environment accessor, never from a target project. Bindings are secret-free
  and stored outside target projects. v1 is a personal chat gated by an
  explicit chat allowlist; there is no webhook, no public listener, and no
  multi-user policy.
- 2026-09-16: The Telegram front is a switchable capability: enabled by default,
  disableable through a setting and a launch parameter, and visible in the
  effective configuration (see config.md). Its runtime is additionally gated on
  configuration -- with no bot token and no allowlist there is nothing to
  long-poll, and nothing starts. When the operator explicitly starts the front
  without that configuration, the front fails loud with a typed error naming
  exactly what is missing; it never starts a half-configured loop or silently
  does nothing.
