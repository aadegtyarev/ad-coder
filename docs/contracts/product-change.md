# Product change contract

For planners, implementers, reviewers, and orchestrators, this contract answers:
what must be understood and proved before a product change is considered done?

## Define the outcome before the mechanism

- Name the intended user or machine consumer, the job they are trying to do, and
  the observable outcome that means the change helped them.
- Map every affected surface before implementation: library API, CLI/UI,
  configuration, persistence, provider/network, security, documentation,
  compatibility, testing, operations, and release. Mark a surface not applicable
  explicitly rather than silently omitting it.
- Find the enforceable contract for every affected surface. If one is missing,
  stop design of that surface, gather evidence and relevant standards, and propose
  a contract for operator approval. Tests cannot substitute for a missing product
  decision.
- Identify the happy path, waiting state, failure paths, recovery action, and
  machine-observable result. A feature that works only when nothing goes wrong is
  incomplete.

## Build from evidence

Record whether the motivating problem is measured, reported, inspected, or merely
asserted. Define an acceptance observation that can disprove the implementation.
Research an unfamiliar or current external contour before selecting an interface
or dependency; preserve useful findings in the project's canonical research note.

Keep the smallest coherent change. Apply the decomposition contract when the work
crosses responsibilities or no longer fits one safely reviewable pass. Separate
structural moves from behavior changes.

## Close the loop

A change is complete only when its applicable contracts pass, happy and failure
paths are tested, user-facing behavior and recovery are documented, compatibility
effects are explicit, release metadata is current, and a cold Reviewer has checked
the result against the original user outcome. Record unresolved work in the
canonical backlog instead of hiding it in a completion summary.
