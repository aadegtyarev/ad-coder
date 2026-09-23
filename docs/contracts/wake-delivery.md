# Wake delivery contract

This contract governs host delivery of durable state changes that require an
orchestrator turn. It is separate from `WaitService` persistence and from
render-only activity notices.

## Guarantees

- Wake records are durable, owner-scoped, coalesced by run and kind, and retain
  handled/unhandled state. A process restart, busy console, or disconnected
  renderer cannot erase an unhandled wake.
- `paused`, `operator_attention`, `failed`, `timed_out`, `completed`, and
  `stage_changed` are turn-initiating state notices. Tool activity, raw event
  delivery, and renderer callbacks are rendering-only and never enqueue a model
  turn.
- A dedicated durable drain runs between orchestrator turns and consumes no more
  than positive `maxWakesPerTurn`. It marks a wake handled only after its durable
  delivery checkpoint, so a crash cannot report delivery without recovery
  evidence.
- Subscription notices are bounded, content-free tail hints. Cursor polling is
  the reconnect and reconciliation path: consumers expose pending/dropped
  history and do not treat an absent hint as completion.
- A delivered wake produces a short, safe operator summary naming the persisted
  event, known result/error, and next action. It does not invent a result or
  turn WIP into completion.

## Wait integration and configuration

`WaitService` only persists typed lifecycle events; a host derives any wake from
that durable state after it commits. It never gives an adapter, timer, or front
authority to create a model turn. Wake retention and drain bounds are positive,
configurable safety limits (`maxWakeEntriesPerRun`, `maxWakesPerTurn`) described
in [configuration](config.md). See [waiting](waiting.md) for cursor semantics,
[tool observability](tool-observability.md) for render-only notices, and
[architecture](../ARCHITECTURE.md) for the control-plane map.
