# Quality contract

This contract owns the project's engineering quality checks and review criteria.

## Guarantees

- Every change passes `bun run check` with zero errors before completion. The
  coder runs `bun run check:fix`; a reviewer treats a non-clean result as a
  blocker with captured output. Biome is the formatter and linter.
- Configure Biome in `biome.json`, including reasoned scoped overrides, rather
  than scattered inline suppressions. An unavoidable inline suppression states
  its reason.
- Pipeline quality gates are declared data with real argv and run after coding
  before review. A red gate returns its captured output to the coder and prevents
  review or approved settlement until it is green. A review that cannot submit a
  verdict pauses as `review_not_run` and needs explicit operator action.
- Target-project gate discovery and configuration follow
  [quality bootstrap](quality-bootstrap.md). A configured profile is enabled by
  default; its gates are the project-specific replacement for this repository's
  own `bun run check` requirement.
- A changed project stack, framework, component, or test surface invalidates the
  relevant quality strategy until [quality bootstrap](quality-bootstrap.md)
  revalidates it; existing green results do not waive that check.
- `bun run stamp:check` is deliberately a pre-delivery gate, not a declared in-run
  gate; [review evidence](review-evidence.md) owns its scoped-stamp semantics.
- Installation and release claims use a bounded integrity-checked smoke of the
  produced artifact without global installation mutation.
- Shared temporary-directory cleanup touches only owned `ad-coder-test-` roots,
  never follows symlinks, uses stated age and dead-owner evidence, and contains
  each cleanup failure as a note instead of aborting the run.
- A public release, drift signal, or requested audit receives a cold
  whole-project assessment of cohesion, dependencies, duplication, testability,
  dead paths, and documentation. It records candidates; it does not refactor.
- Decomposition work begins with characterization coverage, keeps each move
  behaviour-preserving and green, and reports changed expectations. Assess size
  with cohesion, responsibilities, dependencies, churn, and test seams; a line
  count alone does not justify a refactor.
- Any quantity that changes behaviour is configuration, except explicit,
  positive, overridable safety ceilings for content entering model or report
  contexts. Comments explain rationale, contract, provenance, risk, or a
  non-obvious invariant rather than narrating syntax or history.

## Verification

- Run `bun run check` for every change and the relevant declared gates before
  review.
- Exercise the produced artifact for installation or release claims.
- Run an audit when a listed audit trigger applies.

## Related surfaces

- [Configuration](config.md) owns configurable defaults and ceilings.
- [Decomposition](decomposition.md) owns module-boundary requirements.
- [Review evidence](review-evidence.md) owns review verdicts and merge stamps.
- [Release](release.md) owns release metadata and publication checks.
- [Quality bootstrap](quality-bootstrap.md) owns project gate setup.
