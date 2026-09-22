# Release contract

This contract governs the evidence and metadata required for a version merged
or published as an ad-coder release.

## Guarantees

- Classify a release by observable compatibility: incompatible public change is
  major, compatible capability is minor, and compatible correction is patch.
- Every change merged into `main`, including documentation-only work, has a new
  Semantic Version and matching dated changelog entry. A merged version is never
  reused.
- The shipped binary reports the exact release version.
- An installable release has a reproducible locked install and a bounded smoke
  test of the packed artifact.
- Before publication, inspect the tracked and packed file sets for credentials,
  private keys, local runtime state, unexpected generated data, and licensing
  mistakes. Uncertainty blocks publication.

## Verification

- `bun run check:release` validates release metadata.
- The release workflow verifies the packed artifact without global installation
  mutation.

## Related surfaces

- [Public compatibility](compatibility.md).
- [Project quality gates](quality.md).
