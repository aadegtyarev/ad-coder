# Provider failures contract

This contract governs classification and safe recovery advice for failed model
generation.

## Guarantees

- Rate and quota limits are distinct typed failures. They retain only bounded
  HTTP status, provider-code token, optional retry delay, and declared safe
  capacity hint; response bodies and message prose never cross the boundary.
- Provider rejection, credential failure, unavailable provider, and empty or
  truncated generation remain distinguishable typed outcomes.
- A generation with neither answer text nor tool call is a failure, not success.
  Raising output budget or reducing thinking is its recovery; blind retry is not.
- Advice matches the classification: wait for a limit, correct credentials, or
  inspect account and plan as appropriate. It never claims authentication failed
  when the observable status disproves that.

## Related surfaces

- [Public error behaviour](errors.md).
- [Provider capacity](provider-admission.md).
