# Provider failures contract

This contract governs classification, provider diagnostics, and safe recovery
advice for failed model generation.

## Guarantees

- Capacity/concurrency limit, request-rate limit, monetary credit or spending
  exhaustion, and subscription allowance exhaustion are distinct typed outcomes.
  A subscription outcome names its known daily, weekly, monthly, or other reset
  period and reset time; unavailable limit metadata remains explicitly unknown.
- Invalid credentials, expired login requiring reauthentication, insufficient
  model permission, unavailable model/provider, transport failure, malformed
  provider response, and provider rejection remain distinct typed outcomes.
  A generation that returns neither answer text nor tool call and no
  authenticated provider status is its own retryable typed outcome,
  `provider_unavailable`, not a credential or transport classification.
- A failure retains bounded HTTP status, provider-code token, retry/reset hint,
  capacity hint, and a bounded sanitized provider message. It never exposes
  credentials, account identity, provider payloads, prompts, tool arguments, or
  uncontrolled response bodies. If the provider text cannot be made safe, the UI
  names that redaction and still shows the actual classification and diagnostics.
- A generation with neither answer text nor tool call is a failure, not success.
  Raising output budget or reducing thinking is its recovery; blind retry is not.
- Advice matches classification: queue/cool down for capacity, wait or use an
  allowed ladder rung for rate limits, add funds or change budget for credit,
  wait for/reset a subscription allowance, reauthenticate for expired login, or
  inspect permissions/provider status as appropriate. It never claims
  authentication failed when observable status disproves that.
- Each classified provider event is durable and delivered equivalently to the
  operator UI and orchestrator: code, safe provider text, affected route, current
  operation state, retry safety, and recovery action. It is visible immediately
  and included in the session summary; no consumer has to infer an account or
  subscription problem from a generic failed run.

## Verification

Test every classification and recovery action, daily/weekly/monthly and unknown
subscription reset metadata, bounded safe provider-message rendering, redaction,
operator/orchestrator event parity, durable resume, and session-summary inclusion.

## Related surfaces

- [Public error behaviour](errors.md).
- [Provider capacity](provider-admission.md).
- [Routing configuration](routing-config.md) owns allowed route ladders.
- [Wake delivery](wake-delivery.md) owns durable event delivery.
