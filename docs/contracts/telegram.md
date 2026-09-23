# Telegram front contract

This contract owns Telegram-specific rooms, routing, rendering, and trust.

## Guarantees

- A room is the addressable endpoint. Its binding maps room to session and kind:
  switchable personal rooms may attach another session; fixed group-topic rooms
  preserve their binding. All handlers use room seams for session resolution,
  authorization, and delivery targets, never a hard-coded chat id.
- A message routes only to explicit room state. Free text needs both selected and
  attached session; missing state reports the corrective affordance rather than
  guessing or dropping content. A pending decision routes its own reply and is
  cleared after resolution; Telegram reply threading never selects a session.
- Free text is an interactive turn; `/run` starts a visibly distinct background
  pipeline. Slash commands and TUI controls share schema, argument validation,
  and help. Missing required arguments never trigger a default mutation.
- `/sessions` and the matching dashboard control list accessible sessions;
  selecting one uses the shared manager and has the same active-turn handoff
  semantics as TUI and machine API. It never creates a Telegram-private session.
- Attaching transfers interactive ownership after the active turn settles; it does
  not cancel submitted work. The dashboard is a pinned state-change-only message.
  Catch-up cards and bounded paginated session/run views show summaries, never raw
  transcripts or per-tool flicker.
- Decision pushes include diagnosis and actionable buttons. Milestones are
  coalesced, deduplicated, informational, and non-blocking; progress is pull-only.
- The bot token comes only from credential storage or an explicit environment
  accessor, never a target project. Bindings are secret-free and outside targets.
  V1 accepts only configured personal-chat allowlist members; it has no webhook,
  public listener, or multi-user policy.
- Telegram is enabled by default but switchable through setting and launch flag.
  Missing token or allowlist causes an explicit typed configuration error, never
  a half-started polling loop.

## Verification

Test room kinds, explicit routing and pending replies, attach and session switch
during a turn, command parity, dashboard update bounds, pagination, notification
coalescing, allowlist refusal, and incomplete configuration.

## Related surfaces

- [Session manager](session-manager.md) owns shared session lifecycle.
- [Operator flow](operator-flow.md) owns general decision and milestone policy.
- [Configuration](config.md) owns capability resolution.
- [Extension modules](extension-modules.md) owns optional-front boundaries.
- [Security](security.md) owns credential and authority rules.
