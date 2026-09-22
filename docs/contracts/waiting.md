# Waiting contract

This contract owns durable non-blocking waits for an internal or external
condition.

## Guarantees

- One core `WaitService` creates a durable wait identity from a typed source,
  target, condition, timeout, polling/event policy, owner, and recovery action.
  Creation returns immediately; it never holds an orchestrator turn, input editor,
  or provider permit while waiting.
- Built-in sources cover role/agent/workflow run state, an owned tool or subprocess,
  and a timer/alarm. A forge, CI, research, or other extension supplies a versioned
  source adapter for its own status; the core has no GitHub, GitLab, or provider-
  specific polling logic.
- A wait may observe only a durable run identity, a proven owned process handle, or
  an adapter-validated external resource. It never discovers a process by command
  text/PID guess or runs an arbitrary shell predicate repeatedly.
- The core records ownership and a platform-appropriate verifiable identity before
  reporting an owned process as started. On harness restart it reconnects that
  process and its wait when identity, owner, and start-instance evidence agree;
  it never starts a duplicate merely because the harness died. If the process is
  gone or identity cannot be proven, the wait becomes a visible `unavailable` or
  `failed` state with inspect, retry, and explicit replacement actions.
- Source adapters prefer declared event delivery and use configured bounded polling
  only where push is unavailable. They report `satisfied`, `failed`, `unavailable`,
  `timed_out`, `stalled`, or `cancelled` distinctly with safe condition evidence;
  they never manufacture success after lost access or a dropped poll.
- Every transition checkpoints before it is reported. Resume restores a pending
  wait without duplicating an external subscription or command, reconciles an
  uncertain observation, and preserves timeout/deadline semantics.
- `WaitService` publishes its lifecycle changes through the existing versioned
  harness event bus; it creates no parallel notification channel. Durable wakes
  are derived from those persisted transitions, while fronts use the same stream
  for rendering and replay.
- Completion, failure, timeout, and cancellation create the normal durable wake.
  The orchestrator receives a bounded result and states the next action; the
  operator can inspect, cancel, retry, or submit unrelated input throughout.
- TUI, machine API, and the orchestrator expose the same wait list, create,
  inspect, cancel, and supported retry actions. A no-argument wait command is
  local help that lists available source adapters and examples, not a model turn.

## Configuration

Enabled source adapters, polling interval/backoff, timeout/stall limits, event
subscription, concurrency, retention, and retry policy are independently
configurable. Defaults favour adapter events, bounded polling fallback, and no
busy waiting.

## Verification

Test immediate return and continuously available input, every built-in source,
one event-bus lifecycle sequence and durable wake per terminal transition, event
versus polling source, typed terminal states, owned-process refusal, reconnect
after a harness crash, missing or identity-mismatched process, no duplicate
process or external observation, extension-adapter absence, timeout/stall,
durable restart, wake delivery, cancellation/retry, and TUI/API/orchestrator
parity.

## Related surfaces

- [Wake delivery](wake-delivery.md) owns post-wait orchestration turns.
- [Architecture](architecture.md) owns the harness event bus.
- [Resumability](resumability.md) owns durable recovery.
- [Run control](run-control.md) owns owned-process cancellation.
- [Extension modules](extension-modules.md) owns forge and other adapters.
- [UI responsiveness](ui-responsiveness.md) owns continuously available input.
