# Session titles contract

This contract owns managed-session display names.

## Guarantees

- A managed session has a stable project-derived id and a display name marked
  generated or manual. It begins as `New session`; after the first user message
  settles, an asynchronous title-only generation uses the cheapest admitted
  route. A manual name is never replaced by a generated one.
- Generated output and manual input are untrusted opaque display strings. They
  are code-point length-capped, strip terminal controls, receive secret screening,
  and are never identifiers, slugs, or path components.
- A malformed, unterminated, assignment-hiding, or empty sanitized sequence
  falls back to `New session`. Secret screening sees removed characters deleted,
  so control stripping cannot split a sensitive token and hide it.

## Verification

Test generated and manual precedence, admission, ANSI/C1 control variants,
unterminated escapes, assignment sequences, secret-screen projection, and
identifier/path non-use.

## Related surfaces

- [Session manager](session-manager.md) owns durable session state.
- [Provider admission](provider-admission.md) owns title generation admission.
