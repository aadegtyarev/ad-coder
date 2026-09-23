# Durable pause causes contract

This contract governs safe failure evidence persisted with a paused operation.
An operation can be a role, agent, workflow, wake, or recovery action; a pause
never makes its containing session unavailable.

## Guarantees

- A paused failure records a typed cause when available; an unclassified failure
  records `untyped_error` with its bounded, redacted diagnostic identity and
  a link to the full safe diagnostic report.
- Durable actions name stable codes and never interpolate uncontrolled messages.
- Cause comparison distinguishes different concrete failures; recurrence is not
  inferred from a shared generic code alone.
- A pause record names the operation identity, durable-state revision, preserved
  progress, retry safety, and recovery choices. It is atomically associated with
  the core state store, so resume never needs a workflow-private file to explain
  or recover a pause.
- A background wake drain contains an unreadable record as one bounded attributed
  diagnostic and leaves the wake pending. Explicit record readers still fail loudly;
  either outcome leaves the session input and other operations usable.

## Related surfaces

- [Public error behaviour](errors.md).
- [Wake delivery](wake-delivery.md).
- [Task orchestration](orchestrator.md).
- [Resumability](resumability.md).
