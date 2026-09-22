# Pipeline diff projection contract

This contract owns the bounded diff projection passed to pipeline consumers.

## Guarantees

- Path count, per-path bytes, and aggregate bytes are positive configurable safety
  ceilings; zero is refused. Untracked content truncates on a UTF-8 boundary and
  reports true measured bytes and capped files beside bounded text.
- A failed tracked-diff measurement is a typed result with measured paths, not an
  empty diff. Path-list truncation, sensitive-path redaction, and measurement
  failure have distinct durable reasons and fields.
- Material-diff escalation uses true measured tracked or untracked size, never
  truncated projection size. Its threshold is configurable and zero disables only
  that escalation.

## Verification

Test path-count, per-file, aggregate, UTF-8 truncation, redaction, git-measurement
failure, durable reason separation, and escalation against true rather than shown
size.

## Related surfaces

- [Configuration](config.md) owns general safety-setting resolution.
- [Errors](errors.md) owns typed failure projection.
- [Quality](quality.md) owns bounded content entering model contexts.
