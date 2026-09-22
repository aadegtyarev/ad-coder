# Review evidence contract

This contract owns independent review evidence for a tree proposed for merge.

## Guarantees

- Code, configuration, prompts, skills, tests, and contracts require independent
  review. Only prose that establishes no rule is exempt. A pipeline review stage
  satisfies this requirement; outside a pipeline, use the standalone reviewer
  CLI and submit a structured verdict. An author or the authoring model family
  is not independent.
- A blocker or major finding has a stable identity, bounded location, and
  objective closure criterion. Later verdicts account for every prior identity
  as `closed` with evidence or `remains`; `new` identifies a distinct finding.
  Process bookkeeping belongs in the summary, never in product findings.
- When the bounded diff inventory reports removed non-empty test lines, the
  verdict accounts for each exactly once as restored or moved with a concrete
  destination.
- A review retry carries the prior review text into its new session. If no text
  exists, it starts a complete review instead of asserting an unverifiable prior
  action. This applies to reviewer and planner handoff retries.
- `run_role` reviewer delegation is advisory prose and cannot satisfy this
  contract. Only a pipeline review stage or standalone reviewer CLI creates a
  structured verdict and review stamp.
- A review stamp is written only from a settled structured verdict, records the
  reviewed tree digest, base, verdict, role route, time, and run identifiers,
  and excludes itself from the digest. It is stale when the reviewed tree moves.
  When the resolved review policy requires a stamp, a missing, malformed,
  changes-requested, or stale newest stamp blocks merge; recovery is a fresh
  review. `require-stamp: on` requires it, `off` writes none and passes this
  gate, and `auto` follows the repository marker.
- Stamps exist only in this repository when its committed `ad-coder.stamps.json`
  marker enables them. They are never written into a target project.

## Verification

`bun run stamp:check` is a pre-merge gate, not an in-run review gate: a newly
approved review creates its stamp only when it settles. A changed tree must pass
a new review and then this gate. Review stages run declared in-run quality gates
before submitting approval.

## Related surfaces

- [Product changes](product-change.md) owns the overall delivery lifecycle.
- [Quality](quality.md) owns declared in-run checks.
- [Errors](errors.md) owns public error representation.
