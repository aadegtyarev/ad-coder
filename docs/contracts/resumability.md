# Resumability contract

This contract governs recovery of durable ad-coder work after orderly exit or
unexpected process loss.

## Guarantees

- State needed to continue is versioned, bounded, validated, secret-safe, and
  atomically checkpointed before success is reported or a dependent effect
  begins. `ProjectStore` serializes writes and preserves the prior valid state
  on a rejected or malformed update.
- Resume reopens the same durable identities and preserves accepted workflow
  state, task identity/digest, stage accounting, queued work, and observable
  history. It never silently starts a blank replacement or reports a partial
  restoration as complete.
- A settled effect is not replayed. An in-flight or ambiguous effect is
  reconciled only when its durable intent and source-specific witness prove the
  outcome. Otherwise recovery stops with a typed actionable state; it does not
  guess, discard evidence, or silently retry.
- Recovery requests are idempotent: repeating reopen/resume cannot duplicate a
  provider operation, external effect, wake, or terminal report. Terminal
  records remain inspectable.

## Wait-specific recovery

`WaitService.reopen` validates a durable wait without external work. Its
reconciliation operation id is checkpointed before adapter invocation. A record
with that witness but no outcome is `reconcile_uncertain`: it cannot be replayed
by `reconcile`, and the recorded recovery action (`inspect`, `retry`, or
`replace`) directs the host's later explicit handling. See [waiting](waiting.md)
for the durable record and [wake delivery](wake-delivery.md) for notifying the
orchestrator after persisted state changes.

## Related surfaces

- [Architecture](../ARCHITECTURE.md) maps durable coordination and storage.
- [Session manager](session-manager.md) owns shared-session recovery.
- [Configuration](config.md) owns recoverable-state limits and user choices.
- [Errors](errors.md) owns safe typed failure projection.
