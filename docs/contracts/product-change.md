# Product change contract

This contract owns how a product change is defined, coordinated, and closed.

## Guarantees

- Before implementation, name the intended consumer, its job, and an observable
  outcome. Map every applicable public surface: API, front, configuration,
  persistence, provider or network, security, documentation, compatibility,
  testing, operations, and release.
- Each affected surface has an owner contract. A missing contract is a design
  stop: gather evidence and propose the decision before building that surface.
  Define happy, waiting, failure, recovery, and machine-observable paths.
- State whether the motivating problem is measured, reported, inspected, or
  asserted, and define an observation that can disprove the proposed result.
  Preserve durable external research in its thematic project document.
- Keep a change coherent and minimal. Apply [decomposition](decomposition.md)
  when responsibility boundaries demand it; separate structural moves from
  behaviour changes.
- A mutable workspace has one writer. A Git worktree adapter may provide separate
  worktrees for concurrent mutable work; without such an adapter, concurrent
  writes are refused rather than claimed isolated. `--target-dir` is not
  isolation (see [security](security.md)).
- An enabled forge or tracker module owns claiming and closing external work
  items. A project may require one through configuration; the core does not
  require GitHub, a pull request, or an external tracker to define a change.
- A forge module may render and verify delivery evidence. Its projection is a
  compact ledger view with run count, role routes, and provider-reported totals;
  detailed call data remains in the ledger. No core delivery path assumes a pull
  request, and a module never writes its bookkeeping into a target project.
- Completion requires applicable contracts, happy and failure evidence,
  documented recovery and compatibility effects, current release metadata, and
  independently reviewed work where [review evidence](review-evidence.md)
  requires it. File unresolved work in the tracker.

## Verification

The plan identifies affected contracts and acceptance evidence. Use the checks,
review path, and enabled-tracker policy required by linked contracts.

## Related surfaces

- [Quality](quality.md) owns engineering checks and criteria.
- [Review evidence](review-evidence.md) owns reviewer verdicts and stamps.
- [Release](release.md) owns version and publication evidence.
- [Extension modules](extension-modules.md) owns forge and VCS boundaries.
