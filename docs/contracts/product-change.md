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
  per-stage model, and run ids. `ad-coder stamp delivery` prints the PR form;
  its published shape is fixed by one constant set in the renderer (#435,
  2026-09-19): a prose lead-in, a blank line, then ONE fenced block whose
  first line is `runs=<count>` of unique runs and whose role rows are
  unchanged. The body gate's similarity rule recognizes that shape (a
  `runs=`-headed line or the lead-in) and its reasons name it, so gate and
  render cannot drift apart. The stamp is written by the mechanism that
  already knows the run
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
  match. CI still skips this gate for now; the reviewer-stamp obtainability it
  shared with #295's gate is lifted as of 2026-09-19 -- CI now runs
  `bun run stamp:check` on pull requests and pushes (issue #295) -- while this
  body gate stays an operator-side step. The
  repository-opt-in rule above (`ad-coder.stamps.json`) governs in targets;
  this gate reads ad-coder's own ledger files for its own pull request.

## Close the loop

A change is complete only when its applicable contracts pass, happy and failure
paths are tested, user-facing behavior and recovery are documented, compatibility
effects are explicit, release metadata is current, and a cold Reviewer has checked
the result against the original user outcome. Record unresolved work in the
canonical backlog instead of hiding it in a completion summary.

- 2026-09-18: **Every change is reviewed by a reviewer that did not write it, and
  only documentation is exempt** (the operator's rule, stated in their own words
  on 2026-09-18; it was implied by "a cold Reviewer" above and applied unevenly).
  Code, configuration, prompts, skills, tests and CONTRACTS all need an
  independent review round before the merge. A contract is not documentation for
  this purpose: it is the text every later reviewer enforces, so changing it
  changes what "reviewed" means and needs a reviewer of its own. The exemption is
  narrow -- a documentation-only change, i.e. prose that states no rule: a
  README section, a guide, a dated note under `docs/reviews/`. A change produced
  by a pipeline run is already covered: its review stage IS the independent
  review, and the stamp that stage appends is the evidence that it happened.
  Outside a pipeline the review is a standalone reviewer run against the branch
  tree, which appends the same stamp through the same writer (issue #283) --
  `bun run src/cli.ts role reviewer ... --target-dir <branch worktree>` and the
  verdict is recorded by `submit_verdict`, never transcribed from prose. A
  review by the author, or by the model family that wrote the change, is not an
  independent review; that half of the rule is what issue #203 asks to make
  checkable, and the paper half is what issue #265 names as self-satisfiable.
  The enforcement is `bun run stamp:check` (quality.md, 2026-09-17) -- no stamp,
  no merge -- and since 2026-09-19 (issue #295) CI runs it on every pull request
  and push to main. On a pull request GitHub checks out the merge ref, so the
  gate verifies the digest against the tree that would land: a rebase after
  review without a fresh re-review is red.
- 2026-09-20: **A review retry carries the review it is retrying (#525).** The
  second submission attempt runs under a FRESH run id, and a turn is keyed by run
  id in the session store, so it opens with no history at all. The retry prompt
  told that session "Your review stands; submit it now" -- a premise the session
  could not check, because the review it referred to was in the previous
  attempt's context and nowhere in this one. Measured 2026-09-20 on a lane whose
  first review run had reproduced a blocker: the retry submitted `approved`
  after two model turns and sixteen seconds, with a summary reporting six gates
  it never ran and a test count it never measured -- and the stamp, the merge
  gate and every later reader treat the submitted verdict as the review.
  Resolving a false premise is the one thing a model cannot decline to do, so the
  retry is now built from the attempt text: `reviewRetryTask(task, priorText)`
  hands the session the review-so-far verbatim and only then asks for the
  submission, which makes the sentence true instead of unverifiable. An attempt
  that produced no prose (a truncation, an empty turn) has nothing to carry, so
  it gets the one requirement that is true of the session reading it: review the
  work, then submit -- `REVIEW_SUBMISSION_RESTART`. The bare retry is NOT that
  requirement: "your review stands" told to a session holding none is the same
  unverifiable premise this entry exists to remove, merely moved to the empty
  case, and the retry resolves it the same way. NO requirement names a response
  the session never made: "your preceding response did not call submit_verdict"
  is the same unverifiable premise in a third costume, and it was removed from
  the non-empty branch too. This holds on all three surfaces that retry a
  submission: the standalone `role reviewer` CLI (src/cli.ts), the pipeline's
  review round (src/orchestration/session.ts) and the trivial-edit cover review
  (src/orchestration/orchestrator.ts). It holds on the planner's handoff retry
  as well, the other place a decision is re-asked under a fresh run id
  (`plannerRetryTask`, src/orchestration/plan.ts): the plan-so-far travels with
  the task, and the requirement -- the restart, or the validator's own
  correction -- is phrased about what the new session holds.
- 2026-09-23: **An accepted structured reviewer verdict is terminal, even when
  a later closeout or host failure interrupts the role.** The front persists
  the validated verdict before `submit_verdict` reports success. A resumed
  standalone review settles and stamps that same outcome without another
  provider call or a second verdict submission; replaying the same reviewer
  run id is stamp-idempotent. A verdict accepted before a ceiling is not a
  missing verdict merely because the closing prose was not produced.
