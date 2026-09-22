# Review evidence contract

This contract owns independent review evidence and scoped review stamps for a
proposed delivery.

## Guarantees

- Code, configuration, prompts, skills, tests, and contracts require independent
  review when they are included in the project's review scope. Only prose that
  establishes no rule is exempt. A structured verdict from the bundled pipeline
  review stage or an independently dispatched reviewer satisfies this requirement;
  an author or the authoring model family is not independent.
- The bundled pipeline requires a review stamp by default. The project may disable
  that requirement explicitly or apply its own review policy when the bundled
  workflow is disabled. A manual role launch is evidence only when it settles the
  same structured verdict and scope through the shared review operation.
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
- A review stamp is written only from a settled structured verdict. It records
  reviewed path patterns, exact covered-path digest manifest, base, verdict, role
  route, time, and run identifiers, and excludes stamp storage from coverage.
  The default bundled-pipeline scope is source code and `docs/contracts/**`;
  projects extend or replace it with explicit path or glob patterns.
- When the resolved policy requires a stamp, a missing, malformed,
  changes-requested, or coverage-stale newest stamp blocks delivery. A covered-path
  change requires a fresh review. Changes outside coverage do not invalidate it.
- A project may declare a narrow version-metadata reuse policy. CI accepts the
  immediately preceding approved stamp only when every current-tree difference
  from its stamped parent matches an allowed path/glob and no covered path changed.
  The default ad-coder policy permits only `CHANGELOG.md` and `package.json` for
  this final version-resolution step; other projects declare their own paths.
- Stamps exist only in this repository when its committed `ad-coder.stamps.json`
  marker enables them. They are never written into a target project.

## Verification

`bun run stamp:check` is a pre-merge gate, not an in-run review gate: a newly
approved review creates its stamp only when it settles. Test default code/contract
coverage, custom glob scope, scope manifest integrity, stale covered changes,
non-covered changes, the exact parent-only version-metadata exception, and its
refusal for an extra or covered change. Review stages run declared in-run quality
gates before submitting approval.

## Related surfaces

- [Product changes](product-change.md) owns the overall delivery lifecycle.
- [Quality](quality.md) owns declared in-run checks.
- [Errors](errors.md) owns public error representation.
