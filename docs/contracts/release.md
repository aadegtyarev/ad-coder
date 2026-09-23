# Release contract

This contract governs the evidence and metadata required for a version merged
or published as an ad-coder release.

## Guarantees

- Classify a release by observable compatibility: incompatible public change is
  major, compatible capability is minor, and compatible correction is patch.
- ad-coder follows Semantic Versioning 2.0.0 strictly. Its release branch carries
  only final `MAJOR.MINOR.PATCH` versions; its `dev` branch carries a SemVer
  prerelease of the next intended final version, `MAJOR.MINOR.PATCH-dev.N`.
  Release and dev are distinct channels, and a published version is never reused.
- Every change merged into either ad-coder release channel, including
  documentation-only work, has a new matching dated changelog entry and version
  valid under that channel's SemVer form.
- Until ad-coder supports external users, maintainers may deliberately make a
  breaking change without a transition path; its SemVer classification and the
  changelog name it plainly. Once external support is declared, the fuller
  compatibility obligations also apply.
- The shipped binary reports the exact release version.
- An installable release has a reproducible locked install and a bounded smoke
  test of the packed artifact.
- Before publication, inspect the tracked and packed file sets for credentials,
  private keys, local runtime state, unexpected generated data, and licensing
  mistakes. Uncertainty blocks publication.
- Publication readiness is proven before a release is claimed available: the
  workflow publishes each channel exactly once, then a bounded read loop must
  confirm the registry serves that exact version and its dist-tag before the
  release reports success. Registry acknowledgement alone is not success, and
  readiness never retries publishing.

## Verification

- `bun run check:release` validates release metadata.
- The release workflow verifies the packed artifact without global installation
  mutation.

## Related surfaces

- [Public compatibility](compatibility.md).
- [Project quality gates](quality.md).
