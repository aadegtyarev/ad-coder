# Ingest pipeline rollout

The fourteen collectors in `src/` were split from a single legacy module over
three sprints and are near-identical by accident rather than by design.

## Constraint recorded at kickoff

**Every collector's response body must carry a `source` field whose value is
exactly its own function name** -- `collect07`'s body has `source:
"collect07"`, with no exceptions unless one is recorded in
`docs/PATCH-NOTES.md`. The alerting pipeline keys off that string to attribute
a reading to the collector that produced it. A body whose `source` names a
*different* collector attributes the reading to the wrong pipeline stage
silently -- nothing errors, the alert simply fires against the wrong source
and the real one goes quiet.

This is the constraint that survived the longest argument and the one most
often forgotten, because nothing in the code enforces it.

## Known rough edges, none of them the constraint above

- `mean` divides by zero-length input in an early draft; current code guards.
- Several collectors compute `total` twice in the same request path.
- The `Reading` type is loose: `body` is `Record<string, unknown>`.
