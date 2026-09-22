# Wake delivery contract

This contract governs durable notices that require an orchestrator turn after a
background run changes state.

## Guarantees

- `paused`, `operator_attention`, `failed`, `timed_out`, `completed`, and
  `stage_changed` initiate a wake turn. Tool activity and other lifecycle notices
  are rendering-only.
- Wake records are durable, coalesced by run and kind, and retain handled state.
- A dedicated durable path drains at most `maxWakesPerTurn` wake windows between
  orchestrator turns. Console rendering callbacks never enqueue a model turn.
- Owner-scoped background notices are content-free, bounded tail hints. Explicit
  cursor polling remains the reconnect path and exposes pending or dropped events.
- For each delivered run or timer wake, the orchestrator writes a short operator
  summary before choosing its next action. It names the event, reports available
  result data or errors without inventing either, and states what it will do next;
  it does not turn a still-WIP task into a completion report.

## Configuration

Wake retention and draining use mandatory positive bounds: maximum retained wake
windows per run and maximum drained per turn. They are configurable but zero does
not disable these safety limits.

## Related surfaces

- [Interactive rendering](ui-responsiveness.md).
- [Tool activity](tool-observability.md).
- [Task orchestration](orchestrator.md).
- [Operator flow](operator-flow.md).
