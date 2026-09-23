# Session titles contract

This contract owns managed-session display names.

## Guarantees

- A managed session has a stable project-derived id and a display name marked
  generated or manual. It begins as `New session`; after the first user message,
  the default strategy extracts a short title locally without a model request.
  A manual name is never replaced by an extracted or generated one.
- A project may select semantic title generation. It runs asynchronously through
  the resolved Summarizer role, including its model, effort, budget, and cache
  policy; the Summarizer cache defaults off. A title request is lower priority
  than interactive and background work, never blocks input or session progress,
  and a refusal/failure leaves the extracted or initial title intact.
- Generated output and manual input are untrusted opaque display strings. They
  are code-point length-capped, strip terminal controls, receive secret screening,
  and are never identifiers, slugs, or path components.
- A malformed, unterminated, assignment-hiding, or empty sanitized sequence
  falls back to `New session`. Secret screening sees removed characters deleted,
  so control stripping cannot split a sensitive token and hide it.

## Configuration

Title strategy, extraction limits, semantic-generation enablement, and generation
budget follow standard settings precedence. Semantic generation uses the Summarizer
role rather than an independent title-only route.

## Verification

Test local extraction, generated and manual precedence, Summarizer route/cache
resolution, low-priority admission, non-blocking failure, ANSI/C1 control variants,
unterminated escapes, assignment sequences, secret-screen projection, and
identifier/path non-use.

## Related surfaces

- [Session manager](session-manager.md) owns durable session state.
- [Provider admission](provider-admission.md) owns title generation admission.
- [Compaction](compaction.md) owns Summarizer role resolution.
