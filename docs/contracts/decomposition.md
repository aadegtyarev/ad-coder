# Decomposition contract

This contract governs behaviour-preserving separation of code into clearer
responsibilities. It does not govern a feature, bug fix, or intentional public
behaviour change that happens to touch the same files.

## Guarantees

- Split only for an evidenced structural problem: low cohesion, unstable coupling,
  dependency direction, isolation difficulty, duplicated policy, or unrelated API.
- Do not split merely for line count or create pass-through units, single-use
  abstractions, cycles, or a larger public API without a specific benefit.
- Group code that changes for the same reason. Keep policy, orchestration, I/O,
  and domain behaviour independent where they vary independently.
- State ownership of state, errors, configuration, and side effects at every new
  boundary. Preserve the smallest compatible public surface.
- A structural step preserves observable results, failures, ordering, and relevant
  timing or concurrency behaviour. A planned behaviour change is a separate,
  explicitly named product-change step with its own expectations.
- When external state prevents repeatable coverage, first introduce the smallest
  behaviour-neutral seam or test double needed to make the observation
  deterministic. Keep the seam only when it is a justified long-term boundary.
- Use an available semantics-aware rename, move, or extract operation when it
  can prove or check the transformation; otherwise narrow the manual move further.

## Verification

- Establish a green baseline and covering tests for observable behaviour,
  failures, and boundary cases before moving code. Prefer tests through public
  contracts over tests coupled to private structure.
- Make one behaviour-preserving move at a time, run focused checks after it, and
  run applicable project gates before settlement. A newly red check stops the
  structural sequence until the cause is understood.
- Compare before and after responsibility, dependency direction, test seams,
  duplication, public API, and change locality. Stop when evidence is inconclusive.
- Record any changed test expectation as an intentional product change, not as
  proof that an otherwise structural move was safe.

## Related surfaces

- [Product changes](product-change.md).
- [Public compatibility](compatibility.md).
- [Quality](quality.md) owns required project checks.
