# Orchestrator run observation contract

This contract owns delivery of manually and externally launched run outcomes to
the orchestrator.

## Guarantees

- Every role, ad-hoc agent, pipeline, and other workflow records durable state
  changes and a settled or paused result. The orchestrator receives those events
  with result references and bounded safe result data, regardless of who launched
  the work.
- `orchestrator.observeRunResults` is enabled by default. When enabled, a
  relevant state change schedules the normal durable wake path; a result is never
  silently available only to its launching front.
- Disabling observation suppresses only orchestrator delivery. It does not hide
  run state, ledger data, user notifications, cancellation, or explicit status.
- Observation is idempotent by run and state transition. Reconnect, replay, or
  duplicate delivery never makes the orchestrator act twice on the same outcome.
- Local TUI or machine help commands are not work and do not produce an observed
  event.

## Configuration

`orchestrator.observeRunResults` follows standard settings precedence and defaults
to enabled.

## Verification

Test result delivery for manual role, ad-hoc agent, pipeline, and custom workflow;
restart and replay de-duplication; disabled observation; and the absence of events
for local command help.

## Related surfaces

- [Wake delivery](wake-delivery.md) owns durable wake transport.
- [Agent dispatch](agent-dispatch.md) owns agent outcomes.
- [Terminal UI](terminal-ui.md) owns operator-side projection.
