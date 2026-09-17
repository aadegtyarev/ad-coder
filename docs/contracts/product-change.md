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

- 2026-09-17: **The deliverable's signature and review stamp are generated,
  not composed (issues #240, #239).** The delivery signature is derived from
  the ledger `src/stamp/delivery-signature.ts` reads back (per-role calls,
  tokens, provider-reported cost; a role that did not run renders "did not
  run", never blank); the review stamp is derived from the settled verdict,
  per-stage model, and run ids. `ad-coder stamp delivery` prints the PR
  block. The stamp is written by the mechanism that already knows the run
  finished -- `runPipeline`'s settle path -- never by a model deciding to
  mention it; the gate (`bun run stamp:check`) is the operator's pre-merge
  check and fails without a fresh stamp,
  which makes forgetting visible. Identifiers and numbers only; task text and
  payloads stay out (`errors.md`), and per-call detail stays in the ledger.
  A stamp whose tree digest no longer matches the working tree is STALE and
  must not pass; a moved tree needs a fresh review, i.e. a fresh stamp.
- 2026-09-17: **Delivery paperwork is a feature of THIS repository only,
  strictly.** Ad-coder operates on other people's repositories; its stamps
  and signatures must never be written into a target's tree or PR -- that
  would be noise at best and a leak of how the operator works at worst. The
  on-switch is the committed marker `ad-coder.stamps.json` in the repository
  root; without it the run-finish hook and the gate surface are absent or
  no-ops, and the default for any other target is OFF. Generalising this to
  harness-wide behavior is NOT an improvement; treat it as a violation of
  this paragraph.
- 2026-09-17: The delivery signature and review stamp live in one compact
  block; per-call detail, tool histograms, and timing belong to the ledger
  report (`ledger-report.md`), not the PR comment.

## Close the loop

A change is complete only when its applicable contracts pass, happy and failure
paths are tested, user-facing behavior and recovery are documented, compatibility
effects are explicit, release metadata is current, and a cold Reviewer has checked
the result against the original user outcome. Record unresolved work in the
canonical backlog instead of hiding it in a completion summary.
