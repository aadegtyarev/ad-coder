# Error behaviour contract

This contract governs stable, actionable boundary failures for library, CLI,
workflow, provider, and tool callers.

## Guarantees

- Every expected boundary failure has a stable typed code or discriminated result.
- An expected failure tells the user what happened in domain terms, the affected
  operation and state, whether retry is safe, and the next useful action. It
  never replaces that information with an apology, vague failure, or a retry
  known to fail.
- An unexpected failure carries a stable `internal_error` code, the original
  error class and message, a bounded stack trace, safe state snapshot, and a
  concrete recovery path: retry input, resume/restart the harness, or file a
  prefilled diagnostic report for ad-coder. CLI failures use stderr and non-zero
  exit; machine output keeps a stable error shape and clean result stdout.
- Fronts render every typed error they can raise with the action that clears it.
  They do not fall through to a generic failure or recommend a retry known to fail.
- Translation preserves causal typed detail. An unrecognised error exposes its
  actual bounded diagnostic rather than a generic failure token; an unavailable
  detail is named as unavailable, never invented.
- Errors cross human, model, ledger, and durable-state boundaries with no
  credentials, secret values, prompts, file contents, response bodies, or tool
  arguments. Diagnostic projection redacts those values without replacing the
  rest of the error with a success-shaped or content-free message. Causal errors
  remain available to programmatic callers.
- A catch recovers, adds safe context, translates at a boundary, or releases a
  resource. Silent catches and success-shaped fallbacks are forbidden.
- A failure may refuse or pause only its affected operation; it never makes the
  session unusable. The durable session, accepted input queue, completed results,
  ledger, safe diagnostics, and recovery controls remain available for retry,
  a new request, route change, or harness restart.
- Before reporting a terminal operation failure or process boundary, persist every
  recoverable state transition atomically. A crash, cancellation, malformed
  provider response, or diagnostic-report failure must not discard accepted
  session data or replace it with an empty session.
- A diagnostic report is an operator-controlled bounded artifact containing the
  error code, causal chain, sanitized stack, version, enabled capabilities,
  relevant safe state, and reproducible action. It excludes secrets and private
  task content, and can be attached to a configured tracker without a manual
  transcription step.

## Verification

- Tests cover expected error text, state, retry safety, recovery instructions,
  unexpected-error diagnostic content, redaction, and report generation as
  public behaviour; test failed operations, restart, and resume retain session
  data and leave a new-input path available.
- Timeout, cancellation, and retry behaviour are explicit and configurable;
  retry is never inferred for a potentially non-idempotent operation.

## Related surfaces

- [Provider failures](provider-failures.md).
- [Durable pause causes](pause-causes.md).
- [Context compaction](compaction.md).
- [Public compatibility](compatibility.md).
- [Runtime inspection](runtime-inspection.md).
- [Resumability](resumability.md).
- [Project practices](project-practices.md).
