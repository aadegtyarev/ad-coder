# Provider admission contract

This contract governs shared provider-capacity admission for every LLM request.

## Guarantees

- Admission is keyed by provider capacity scope, never by a secret credential.
- Every generation path passes through admission; a front does not create an
  independent provider client that bypasses it.
- One session orders its interactive turns. Independent sessions may run
  concurrently after admission; transport connection reuse does not decide it.
- Per-scope concurrency, queue capacity, fairness, priority, retry, and cooldown
  are configurable. Interactive work outranks background work; title generation
  is deferred behind both.
- A request without a permit is visible as queued and offers supported wait or
  cancel action. Queue saturation is a typed resource-limit failure.
- A provider limit releases its permit and opens one scope-wide cooldown until a
  bounded retry hint or configured delay expires. Queued requests do not probe
  during cooldown and resume fairly afterwards.
- Durable requests retain admission status and terminal outcome across restart.
  An uncertain in-flight request is never silently duplicated.
- Cancelling a queued request removes only that request. Cancellation after
  admission follows durable run cancellation and releases a permit exactly once.

## Related surfaces

- Provider failure classification: `provider-failures.md`.
- Settings: `config.md`.
- Public error behaviour: `errors.md`.
