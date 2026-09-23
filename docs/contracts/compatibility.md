# Compatibility and release contract

For maintainers and reviewers, this contract answers: what may change without
surprising existing users, and what evidence makes an installable release valid?

- 2026-09-21: Versioned managed-state lock files carry the holder pid and its
  process start-time witness. Readers must require that witness before reclaiming
  a lock; pid alone is not evidence because pid reuse can identify another live
  process. Live contention remains bounded and ends in the existing typed
  `version_conflict` refusal.

- Public surfaces include exported library symbols and types, CLI commands,
  options, exit behavior and machine JSON, configuration keys and defaults,
  persisted schemas, workflow/plugin interfaces, and documented installation
  paths. Name affected public surfaces in every change plan.
- Preserve compatible behavior within a major version unless the operator approves
  a breaking change. A removal or incompatible rename requires a migration path,
  a visible deprecation period when feasible, and a major-version decision.
- Classify the release with Semantic Versioning from observable compatibility, not
  implementation size: incompatible public change is major, compatible capability
  is minor, compatible correction is patch.
- Every change merged into `main`, including documentation-only changes, has a
  new Semantic Version and matching dated changelog entry. A PR that leaves the
  version unchanged is blocking. Installable changes additionally require a
  reproducible locked install and bounded packed-artifact smoke. The binary must
  report the exact version; never reuse a version previously offered from `main`.
- **2026-09-23: Npm publication is not release-ready until a bounded registry check proves
  both the exact `package@version` lookup and that channel's `latest` dist-tag
  resolve to the expected version.** The check accepts exactly one complete JSON
  string per successful lookup, allowing surrounding npm warning lines but never
  a partial, ambiguous, or non-string JSON value. A propagation timeout names that
  state and performs no second publish; immutable package versions make
  republishing an error, not a recovery.
- Before publication, inspect the exact tracked and packed file sets for credentials,
  private keys, local runtime state, unexpected generated data, and licensing
  mistakes. Publication stops on uncertainty; absence of an optional external
  scanner is not evidence that the artifact is safe.
