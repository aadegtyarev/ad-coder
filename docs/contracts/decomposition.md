# Decomposition contract

For planners, auditors, implementers, and reviewers, this contract answers: when
should code be split, where should the boundary go, and how is the change kept
behavior-preserving?

## Diagnose before splitting

A large function or file is a signal, not a verdict. Cite at least one structural
problem: multiple responsibilities, low cohesion, unstable change coupling,
dependency cycles or wrong direction, difficult isolated testing, duplicated
policy, or an interface that exposes unrelated concerns. Record current public
behavior and the callers that constrain it.

Do not split merely to meet a line count. Do not create thin pass-through modules,
single-use abstractions, circular dependencies, or a larger public API without a
specific benefit.

## Choose the boundary

- Group code that changes for the same reason; separate policy, orchestration,
  I/O adapters, and domain behavior when they vary independently.
- Point dependencies toward the stable core. Put provider, filesystem, network,
  CLI, and UI details behind narrow injected boundaries.
- Name the new unit after its responsibility, not its implementation mechanism.
- State ownership of state, errors, configuration, and side effects. A boundary
  is incomplete if these remain implicitly shared.
- Preserve the smallest compatible public surface. Add a temporary compatibility
  adapter only when a named consumer requires migration time.

## Execute safely

1. Add or identify characterization tests for observable behavior, failure paths,
   and boundary cases before moving code.
2. Make one behavior-preserving move at a time. Prefer compiler-, AST-, or
   LSP-assisted rename/extract/move operations to regenerating working code.
3. Run narrow tests after every move and all applicable gates before changing
   behavior or deleting compatibility code.
4. Separate intentional behavior changes from structural moves. Report every
   changed test expectation and obtain authority for that product change.
5. Update imports, exports, architecture maps, and ownership documentation in the
   same step. Remove dead paths only after proving no supported consumer remains.

## Review the result

Compare before and after: responsibilities per unit, dependency direction, test
seams, duplication, public API size, and change locality. The refactor passes only
when behavior is preserved and at least one diagnosed problem is materially
reduced without introducing a worse boundary. If evidence is inconclusive, stop
and retain the tested intermediate state.
