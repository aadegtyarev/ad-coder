# Compatibility and release contract

For maintainers and reviewers, this contract answers: what may change without
surprising existing users, and what evidence makes an installable release valid?

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
- Every installable release has a new version, matching dated changelog entry,
  reproducible locked install, and a bounded smoke of the packed artifact. The
  binary must report that exact version. Never reuse a version already offered as
  an install target.
- Before publication, inspect the exact tracked and packed file sets for credentials,
  private keys, local runtime state, unexpected generated data, and licensing
  mistakes. Publication stops on uncertainty; absence of an optional external
  scanner is not evidence that the artifact is safe.
