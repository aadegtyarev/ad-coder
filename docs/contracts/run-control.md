# Run control contract

This contract owns run-scoped cancellation: stopping one recorded role, agent,
workflow, tool, or subprocess without stopping its session or unrelated work.

## Guarantees

- TUI, machine API, and orchestrator use one headless run-control operation. It
  lists a run's state and offers graceful cancel; an explicit force action appears
  only when its configured authority and safety checks permit it. The former
  standalone `runs stop` CLI mode is not a public interface.
- A cancellation intent records initiator, reason, run identity, state revision,
  and requested strength durably before any cancellation signal or provider/tool
  request. Repeated cancel is idempotent and reports the already-settled outcome.
- Graceful cancellation asks the owned role/workflow/tool to stop at its next safe
  boundary, preserves checkpointed WIP, ledger, queued session input, and recovery
  controls, then emits a durable cancellation outcome and orchestrator wake.
- A process signal is a last-mile implementation of cancellation, never identity
  discovery. Before SIGTERM or configured escalation, the durable record proves a
  live non-zombie PID, matching start time, run witness, exact owned target, and
  safe process-group ownership. Any missing or ambiguous proof refuses without a
  signal.
- Force cancellation is visibly distinct, waits the configured grace period, and
  uses only the verified owned process or proven owned group. It preserves the
  recoverable pre-cancellation checkpoint and leaves ambiguous external effects
  paused for explicit recovery rather than claiming they were undone.
- Cancelling a run never cancels its containing session, other runs, or accepted
  input. The operator may immediately submit new input, inspect the cancelled
  run, retry/resume where safe, or start independent work.

## Configuration

Grace period, escalation signal, force-cancel authority, process-group control,
and cancellation retention are independently configurable. Force cancellation is
off by default.

## Verification

Test TUI/API/orchestrator parity, running and settled records, graceful and forced
cancellation, durable intent ordering, dead/reused PID, path/process-group refusal,
repeated cancel, preserved WIP and input queue, wake delivery, resume/retry, and
unrelated-session isolation.

## Related surfaces

- [Agent dispatch](agent-dispatch.md) owns role and agent lifecycle.
- [Resumability](resumability.md) owns preserved state and recovery.
- [UI responsiveness](ui-responsiveness.md) owns available controls.
- [Errors](errors.md) owns cancellation failure projection.
- [Security](security.md) owns external-effect authority.
