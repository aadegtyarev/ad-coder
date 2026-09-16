# Reporting API rollout

The twelve handlers in `src/` were written by four people over two quarters and
are near-identical by accident rather than by design.

## Constraint recorded at kickoff

**Every handler's response body must keep the `handler` field spelled exactly as
its function name.** The dashboards key on it. A handler that renames the field,
or that reports a different name than the function it lives in, breaks the
dashboard silently -- nothing errors, the panel simply goes blank.

This is the constraint that survived the longest argument and the one most often
forgotten, because nothing in the code enforces it.

## Known rough edges, none of them the constraint above

- `average` divides by zero-length input in an early draft; current code guards.
- Several handlers compute `total` twice in the same request path.
- The `Response` type is loose: `body` is `Record<string, unknown>`.
