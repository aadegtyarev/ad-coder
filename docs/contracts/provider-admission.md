# Provider admission contract

This contract governs shared provider-capacity admission for every LLM request.

## Guarantees

- Admission is keyed by a secret-free capacity scope containing provider,
  account-scope identity, and model route. A provider's different models may
  therefore have different queues and effective concurrency; a credential value
  is never a key.
- Every generation path passes through admission; a front does not create an
  independent provider client that bypasses it.
- One session orders its interactive turns. Independent sessions may run
  concurrently after admission; transport connection reuse does not decide it.
- Per-route concurrency, queue capacity, fairness, priority, retry, cooldown,
  learning policy, and probe cadence are configurable. Interactive work outranks
  background work; title generation is deferred behind both.
- A request without a permit is visible as queued and offers supported wait or
  cancel action. Queue saturation is a typed resource-limit failure.
- A provider limit releases its permit and opens one scope-wide cooldown until a
  bounded retry hint or configured delay expires. Queued requests do not probe
  during cooldown and resume fairly afterwards.
- The effective route limit adapts to provider capacity evidence. A declared
  provider limit is adopted exactly; otherwise a confirmed model-specific limit
  response lowers the effective concurrency conservatively, never above the
  configured ceiling. Sustained success may make bounded upward probes under the
  configured learning policy. Each adjustment records whether it is declared or
  estimated, its former/new limit, evidence, and confidence.
- A capacity reduction, cooldown, saturated queue, or failed upward probe is a
  prominent non-blocking session notice and appears in the session summary. It
  does not make the session unavailable or require the operator to tune a value
  before admitted work can continue.
- Admission reports route availability and capacity evidence to routing; it never
  selects a fallback route itself. [Routing configuration](routing-config.md)
  owns an allowed model/provider ladder.
- Durable requests retain admission status and terminal outcome across restart.
  An uncertain in-flight request is never silently duplicated.
- Cancelling a queued request removes only that request. Cancellation after
  admission follows durable run cancellation and releases a permit exactly once.

## Verification

Test independent model scopes at one provider, declared capacity, conservative
reduction after a model-specific limit, cooldown, bounded upward probe, immediate
notice/session summary, durable queue recovery, and routing availability handoff.

## Related surfaces

- [Provider failure classification](provider-failures.md).
- [Settings](config.md).
- [Public error behaviour](errors.md).
