# UI responsiveness contract

This contract governs responsiveness and interrupt isolation for every
interactive ad-coder front.

## Guarantees

- Model calls, tools, subprocesses, workflow steps, watches, and retries never
  prevent input, documented interrupt, cancel, status, or exit controls. Long
  work exposes a cancellable handle and bounded progress or stall signals.
- The input editor is continuously available. A submitted message enters the
  durable FIFO session queue; if no orchestrator turn is active it starts the
  next turn immediately, otherwise it is delivered to the next turn after the
  active one settles. No front drops, overwrites, or requires the operator to
  retype a queued message.
- Interrupting an active foreground turn promptly returns control and preserves
  its conversation and unrelated detached work. Cancelling detached work uses
  an explicit run-scoped action. Terminal modes and signal handlers are restored.
- A wait/watch has configured polling, total-timeout, and stall-timeout bounds.
  It returns control immediately and later settles as state change, completion,
  stall, cancellation, or timeout through the shared wait service.
- An interactive front serializes background output with foreground output,
  renders each wake's concise orchestrator summary and next action, then restores
  its editor without corruption or loss of typed input.

## Verification

- Tests use slow and never-completing dependencies to prove continuously
  available input and controls, FIFO next-turn delivery, finite shutdown, and
  isolation between operations.

## Related surfaces

- [Wake delivery](wake-delivery.md).
- [Terminal UI](terminal-ui.md).
- [Waiting](waiting.md).
