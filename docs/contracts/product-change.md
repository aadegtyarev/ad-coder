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
- A working tree has one writer. Concurrent mutable work uses separate
  worktrees; `--target-dir` is not isolation (see [security](security.md)).
- Claim an issue before work starts using an assignee, `in-progress` label, and
  identifying comment. Link the pull request to close it on merge, or close it
  immediately afterwards.
- This repository's pull request carries the generated delivery signature, not
  hand-written cost data. The signature is a compact ledger projection with run
  count, role routes, and provider-reported totals; detailed call data remains
  in the ledger. Its fixed renderer and body check reject a missing or stale
  block. These delivery hooks are enabled only by this repository's committed
  `ad-coder.stamps.json` marker and never write ad-coder bookkeeping into a
  target project.
- Completion requires applicable contracts, happy and failure evidence,
  documented recovery and compatibility effects, current release metadata, and
  independently reviewed work where [review evidence](review-evidence.md)
  requires it. File unresolved work in the tracker.

## Verification

The plan and pull request identify affected contracts, acceptance evidence, and
the issue. Use the checks and review path required by the linked contracts.

## Related surfaces

- [Quality](quality.md) owns engineering checks and criteria.
- [Review evidence](review-evidence.md) owns reviewer verdicts and stamps.
- [Release](release.md) owns version and publication evidence.
