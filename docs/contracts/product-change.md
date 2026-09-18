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
- 2026-09-18: **A working tree has one writer at a time.** A pipeline run, a
  background worker, a console session and a developer all mutate the same
  checkout, and a branch switch, a stash or a commit made under another writer
  corrupts work in flight. Independent mutable work gets its own worktree
  (`git worktree add <path> -b <branch> origin/main`); the shared tree keeps
  the branch its owner left it on. Enforcing the branch rule itself is issue
  #334.
- 2026-09-18: **An issue is claimed before it is worked and closed when the
  change lands.** The tracker is the only place a second developer can see what
  is already taken: an assignee plus the `in-progress` label, and one comment
  naming who took it and the run id, before the first edit or dispatch -- and
  the assignee and label are read before anything is picked up. `Fixes #N` in
  the pull request body closes it with the merge; when the link is missing,
  close it by hand the moment it merges. A board where merged work still reads
  as open is a board nobody trusts (issue #293).
- 2026-09-18: **The PR body carries the generated stamp, never a composed cost
  line.** On PR #333 the cost breakdown was simply absent; on #329 it was a
  hand-written sentence a model happened to remember. `ad-coder stamp delivery`
  renders per-role models and provider-reported cost from the ledger, and
  `product-change.md` already said the signature is generated -- what was
  missing was an obligation and a gate (issues #335, and #336 for the
  orchestrator lane the block's own rows leave out).
- 2026-09-18: **The carried block is checked, not trusted (#335).** After
  #336 the block sums; the gate `ad-coder stamp body-check <body.md>
  [ledger...]` reads a pull-request body and fails when the freshly rendered
  block is absent from it or no longer equals it (stale = the ledger moved).
  The rendered block is pasted verbatim, so the check is a plain substring
  match. CI runs this the way #295's stamp gate will -- not today: the same
  dependency on a reviewer stamp being obtainable at merge time now. The
  repository-opt-in rule above (`ad-coder.stamps.json`) governs in targets;
  this gate reads ad-coder's own ledger files for its own pull request.

## Close the loop

A change is complete only when its applicable contracts pass, happy and failure
paths are tested, user-facing behavior and recovery are documented, compatibility
effects are explicit, release metadata is current, and a cold Reviewer has checked
the result against the original user outcome. Record unresolved work in the
canonical backlog instead of hiding it in a completion summary.
