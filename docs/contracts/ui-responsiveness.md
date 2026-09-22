# UI responsiveness contract

This contract governs responsiveness and interrupt isolation for every
interactive ad-coder front.

## Guarantees

- Model calls, tools, subprocesses, workflow steps, watches, and retries never
  prevent documented interrupt, cancel, status, and exit controls. Long work
  exposes a cancellable handle and bounded progress or stall signals.
- Interrupting an active foreground turn promptly returns control and preserves
  its conversation and unrelated detached work. Cancelling detached work uses
  an explicit run-scoped action. Terminal modes and signal handlers are restored.
- A synchronous watch has configured polling, total-timeout, and stall-timeout
  bounds. It returns on state change, completion, stall, cancellation, or timeout.
- A formatted console serializes a background wake turn with foreground output,
  renders its start and settled result, then restores its prompt without output
  corruption.

## Verification

- Tests use slow and never-completing dependencies to prove available controls,
  finite shutdown, and isolation between operations.

## Related surfaces

- Wake delivery: `wake-delivery.md`.
