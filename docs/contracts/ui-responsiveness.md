# UI responsiveness contract

Rules for every interactive ad-coder front. A violation is always blocking.

- `ui-responsiveness:input-control` — Model calls, tools, subprocesses, workflow
  steps, watches, and retries must never prevent the front from accepting its
  documented interrupt, cancel, status, and exit controls. Long work exposes a
  cancellable handle and bounded progress or stall signals.
- `ui-responsiveness:isolated-interrupt` — Interrupting the active foreground
  turn promptly returns control and preserves the conversation and unrelated
  detached work. Cancelling detached work requires an explicit run-scoped
  action. Terminal modes and signal handlers are restored on every exit path.
- `ui-responsiveness:bounded-watch` — A requested synchronous watch uses a
  configured polling interval, total timeout, and stall timeout. It returns on
  state change, completion, stall, cancellation, or timeout. Waiting may occupy
  the requesting model turn, but the interactive front remains controllable.
  Hand-written sleep/poll loops are not an acceptable UI implementation.

Tests use slow and never-completing dependencies and prove that controls remain
available, shutdown is finite, and one operation cannot cancel another.
