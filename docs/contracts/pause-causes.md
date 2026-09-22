# Durable pause causes contract

This contract governs safe failure evidence persisted with a paused workflow.

## Guarantees

- A paused failure records a typed cause when available; an unclassified failure
  records `untyped_error` with a bounded, redacted first-line diagnostic.
- Durable actions name stable codes and never interpolate uncontrolled messages.
- Cause comparison distinguishes different concrete failures; recurrence is not
  inferred from a shared generic code alone.
- A background wake drain contains an unreadable record as one bounded attributed
  diagnostic and leaves the wake pending. Explicit record readers still fail loudly.

## Related surfaces

- [Public error behaviour](errors.md).
- [Wake delivery](wake-delivery.md).
- [Task orchestration](orchestrator.md).
