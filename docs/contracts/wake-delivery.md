# Wake delivery contract

This contract governs durable notices that require an orchestrator turn after a
background run changes state. It is separate from `WaitService` persistence and
from render-only activity notices.

## Guarantees

- Wake records are durable, owner-scoped, coalesced by run and kind, and retain
  handled/unhandled state. A process restart, busy console, or disconnected
  renderer cannot erase an unhandled wake.
- `paused`, `operator_attention`, `failed`, `timed_out`, `completed`, and
  `stage_changed` initiate a wake turn. Tool activity, raw event delivery, and
  renderer callbacks are rendering-only and never enqueue a model turn.
- A dedicated durable path drains at most positive `maxWakesPerTurn` wake
  windows between orchestrator turns and consumes no more than that bound. It
  marks a wake handled only after its durable delivery checkpoint, so a crash
  cannot report delivery without recovery evidence. Console rendering callbacks
  never enqueue a model turn.
- Owner-scoped background notices are bounded, content-free tail hints. Explicit
  cursor polling remains the reconnect and reconciliation path and exposes
  pending or dropped events; consumers do not treat an absent hint as
  completion.
- For each delivered run or timer wake, the orchestrator writes a short operator
  summary before choosing its next action. It names the persisted event, reports
  available result data or errors without inventing either, and states what it
  will do next; it does not turn a still-WIP task into a completion report.

## Wait integration and configuration

`WaitService` only persists typed lifecycle events; a host derives any wake from
that durable state after it commits. The wait host projects persisted terminal
transitions onto existing kinds below without inventing a new one. Cancellation
is a normal durable wake per the waiting contract: an operator-chosen
cancellation still owes the owning run a decision (retry, replacement, or a
reported outcome), so `cancelled` projects onto `operator_attention` — the
existing window for "a state the orchestrator has to decide on" — exactly like
`unavailable`. Mapping: `satisfied`→`completed`, `failed`→`failed`,
`timed_out`→`timed_out`, `stalled`→`paused`, `cancelled`/`unavailable`→
`operator_attention`. It never gives an adapter, timer, or front
authority to create a model turn. Wake retention and drain bounds are positive,
configurable safety limits (`maxWakeEntriesPerRun`, `maxWakesPerTurn`) described
in [configuration](config.md). They are configurable but zero does not disable
these safety limits.

## Related surfaces

- [Interactive rendering](ui-responsiveness.md).
- [Tool activity](tool-observability.md).
- [Task orchestration](orchestrator.md).
- [Operator flow](operator-flow.md).
- [Waiting](waiting.md) owns cursor semantics and durable wait records.
- [Architecture](../ARCHITECTURE.md) owns the control-plane map.
