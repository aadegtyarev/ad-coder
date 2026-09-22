# Error behaviour contract

This contract governs stable, actionable boundary failures for library, CLI,
workflow, provider, and tool callers.

## Guarantees

- Every expected boundary failure has a stable typed code or discriminated result.
- A public projection carries safe concise text, `retryable`, and a next action
  whenever recovery exists. CLI failures use stderr and non-zero exit; machine
  output keeps a stable error shape and clean result stdout.
- Fronts render every typed error they can raise with the action that clears it.
  They do not fall through to a generic failure or recommend a retry known to fail.
- Translation preserves causal typed detail. An unrecognised error yields only a
  bounded class token, never message, stack, or uncontrolled fields.
- Errors cross human, model, ledger, and durable-state boundaries with no
  credentials, secret values, prompts, file contents, response bodies, or tool
  arguments. Causal errors remain available to programmatic callers.
- A catch recovers, adds safe context, translates at a boundary, or releases a
  resource. Silent catches and success-shaped fallbacks are forbidden.

## Verification

- Tests cover error output and recovery instructions as public behaviour.
- Timeout, cancellation, and retry behaviour are explicit and configurable;
  retry is never inferred for a potentially non-idempotent operation.

## Related surfaces

- Provider failures: `provider-failures.md`.
- Durable pause causes: `pause-causes.md`.
- Context compaction: `compaction.md`.
- Public compatibility: `compatibility.md`.
