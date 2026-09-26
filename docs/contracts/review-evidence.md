# Review evidence contract

This contract owns independent review evidence and scoped review stamps for a
proposed delivery.

## Guarantees

- The default review scope of the bundled pipeline covers all executable code,
  including `src/**`, `test/**`, `scripts/**`, and `evals/**`, plus
  `docs/contracts/**`, extended by the role prompts (`prompts/**`), the harness
  entry points (`bin/**`, `examples/**`), the CI workflow
  (`.github/workflows/**`), and the named configuration files (`package.json`,
  `tsconfig.json`, `biome.json`, `bunfig.toml`, `bun.lock`,
  `docs/readability.json`, `ad-coder.stamps.json`, `AGENTS.md`, `CLAUDE.md`,
  `.gitignore`). Tests, fixtures, and check scripts are code: changing them
  requires the same independent review as changing implementation. A project may
  add paths or replace the whole scope explicitly with its own path or glob
  patterns; only prose that establishes no rule is exempt. The extension is
  additive, not accidental: each added path shapes what compiles, runs, or ships
  -- the role prompts are the rules a model executes, the entry points are
  executable code, the workflow is CI itself, and the named configuration gates
  the build, the run, and the stamp policy -- so it is covered under the same
  "only prose that establishes no rule is exempt" test. A structured verdict
  from the bundled pipeline review stage or an independently dispatched reviewer
  satisfies this requirement; an author or the authoring model family is not
  independent.
- The bundled pipeline requires a review stamp by default. The project may disable
  that requirement explicitly or apply its own review policy when the bundled
  workflow is disabled. A manual role launch is evidence only when it settles the
  same structured verdict and scope through the shared review operation.
- A blocker or major finding has a stable identity, bounded location, and
  objective closure criterion. Later verdicts account for every prior identity
  as `closed` with evidence or `remains`; `new` identifies a distinct finding.
  Process bookkeeping -- including external state the round can neither cause
  nor observe from the reviewed tree (an unmerged pull request, an absent merge
  commit, another round's or reviewer's pending action, an unfinished CI run,
  an unpublished release) -- belongs in the summary, never in product findings;
  a tree-side defect that works through such a state (a hook stripping a
  newline from a committed file) stays a product finding, named with its
  file:line.
- When the bounded diff inventory reports removed non-empty test lines, the
  verdict accounts for each exactly once as restored or moved with a concrete
  destination.
- A review retry carries the prior review text into its new session. If no text
  exists, it starts a complete review instead of asserting an unverifiable prior
  action. This applies to reviewer and planner handoff retries.
- A review stamp is written only from a settled structured verdict. It records
  reviewed path patterns, exact covered-path digest manifest, base, verdict, role
  route, time, and run identifiers, and excludes stamp storage from coverage.
  Those patterns are the default review scope declared above, or the explicit
  path or glob patterns a project declares in its place.
- When the resolved policy requires a stamp, a missing, malformed,
  changes-requested, or coverage-stale newest stamp blocks delivery. A covered-path
  change requires a fresh review. Changes outside coverage do not invalidate it.
- A project may declare a narrow version-metadata reuse policy. CI accepts the
  immediately preceding approved stamp only when every current-tree difference
  from its stamped parent matches an allowed path/glob and no covered path changed.
  The default ad-coder policy permits only `CHANGELOG.md` and `package.json` for
  this final version-resolution step; other projects declare their own paths.
- The round that is reviewed OWNS its tree: each review front captures the
  covered-path digest manifest at the START of the round (beside the run
  record, never re-anchored on resume) and the settle that writes the stamp
  refuses to append when any covered path moved since -- the stamp would
  certify a tree that is not the reviewed change. The refusal names the moved
  paths and the recovery: restore the tree and re-run the round. Untracked
  paths and the stamp storage itself stay outside coverage, so settlement
  paperwork never invalidates the gate.
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
