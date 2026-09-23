# Compatibility contract

This contract governs behaviour that existing users and persisted project state
can observe across a compatible release.

## Guarantees

- Public surfaces include exported library symbols and types, CLI commands,
  options, exit behaviour and machine JSON, configuration keys and defaults,
  persisted schemas, workflow and plugin interfaces, and documented installation
  paths. Name affected public surfaces in every change plan.
- Compatibility and versioning policy are selected by a product or target
  project; the core preserves declared compatibility metadata but does not impose
  SemVer, a forge, or release branches on another project.
- Until ad-coder declares external users supported, maintainers may make an
  intentional incompatible change without a compatibility layer, deprecation
  period, or migration path. They still classify and record it under the release
  policy.
- After that declaration, preserve behaviour within a major version unless a
  breaking change is approved. A removal or incompatible rename needs a migration
  path, a deprecation period where feasible, and an approved major-version
  decision.
- Versioned managed-state locks carry both holder PID and process start-time
  witness. Reclaiming requires that witness; PID alone is insufficient.

## Failures

- Live managed-state lock contention is bounded and ends as typed
  `version_conflict`, not an indefinite wait or unsafe reclaim.

## Related surfaces

- [Release process](release.md).
- [Error behaviour](errors.md).
- [Managed sessions](session-manager.md).
- [Release process](release.md) owns ad-coder's chosen policy.
