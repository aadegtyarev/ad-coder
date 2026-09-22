# Decomposition contract

This contract governs behaviour-preserving separation of code into clearer
responsibilities.

## Guarantees

- Split only for an evidenced structural problem: low cohesion, unstable coupling,
  dependency direction, isolation difficulty, duplicated policy, or unrelated API.
- Do not split merely for line count or create pass-through units, single-use
  abstractions, cycles, or a larger public API without a specific benefit.
- Group code that changes for the same reason. Keep policy, orchestration, I/O,
  and domain behaviour independent where they vary independently.
- State ownership of state, errors, configuration, and side effects at every new
  boundary. Preserve the smallest compatible public surface.

## Verification

- Characterization tests cover observable behaviour, failures, and boundary cases
  before moving code.
- Make behaviour-preserving moves one at a time, run focused tests after each,
  and applicable gates before changing behaviour or removing compatibility code.
- Compare before and after responsibility, dependency direction, test seams,
  duplication, public API, and change locality. Stop when evidence is inconclusive.

## Related surfaces

- [Product changes](product-change.md).
- [Public compatibility](compatibility.md).
