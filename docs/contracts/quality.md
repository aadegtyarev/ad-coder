# Quality contract

Rules for the project's own code quality. A violation is always blocking.

- 2026-09-17: **A review stamp the gate checks: no stamp, no merge (issue
  #239, closed with #240).** The stamp certifies that a review round happened
  and names what it reviewed: the working-tree digest of the tree at review
  time, the base, the studied verdict, the reviewer role's provider/model,
  the local ISO time, the run ids, and where findings live. It is APPENDED to
  `docs/reviews/stamps.log` by the run-finish hook in `runPipeline`'s settle
  path -- not by a model deciding to mention it -- and it is a no-op unless
  the target carries the committed marker `ad-coder.stamps.json`, because
  stamp writing stays THIS repository's own bookkeeping (see
  `product-change.md`, 2026-09-17). The gate `bun run stamp:check` runs as
  this project's PRE-MERGE gate, between a settled run and a merge -- never
  as an in-run gate (issue #271): its property, "the newest stamp digests
  this exact tree", only exists once the settle path has written the stamp,
  so inside a run it is red by construction on a moved tree and its assigned
  fix is work only the run itself can perform at settle. At the pre-merge
  boundary the same failures block the merge:
  no stamp,
  a malformed newest stamp, a `changes_requested` verdict, or a stamp whose
  digest no longer matches the current tree fails exactly like a red `bun run
  check`. Stale means the reviewed tree moved; the recovery is a fresh review
  round via a settled run, which appends a fresh stamp before the merge. The
  stamp log itself is excluded from its own digest: appending one line cannot
  count as the tree moving.
- 2026-09-19: **A review dispatched through the orchestrator's `run_role` tool is
  advisory: it cannot satisfy `bun run stamp:check` (issue #376).** A review run
  as a bare role through `run_role` settles as prose with no structured verdict
  -- the delegated conversation delivers by assistant text and its handler
  registers no submission tools (issue #236) -- so neither caller of
  `recordReviewStampFromResult` (the CLI standalone path, the pipeline settle
  path) is reached and no stamp is written. The stamp is derived only from
  structured settled verdicts through the one writer,
  `recordReviewStampFromResult`; no path transcribes a verdict out of prose --
  writing one from `run_role` text would forge the gate's evidence, and giving
  the delegated reviewer a structured verdict lifecycle would duplicate the CLI's
  submission machinery inside a handler that stays a thin marshaller. The surface
  says so plainly: both `run_role` description variants and a reviewer
  delegation's result text (normal and stage-closeout) name the advisory status
  and point gate-satisfying review rounds at the pipeline review stage or the
  standalone `ad-coder role reviewer` CLI. Delegations of other roles keep their
  result text unchanged.
- 2026-09-17: **The pipeline's checks are DECLARED as data, not left to a model's
  own judgment (issue #227).** A declared `QualityGate` list carries real argv and
  is executed by the existing `GateRunner` after the coder and before any
  reviewer round, with zero path arguments appended for `project` gates: the
  argv decides over the whole working directory exactly as an operator would
  type it. A RED gate returns to the coder with the captured output verbatim as
  blocking evidence and is re-run before any review; a run never reaches review
  -- and never settles `approved` -- while the gate report is red, even through
  a driver rework that follows an earlier approval. This is why a gate is
  declared in-run only when the run can act on its red: a check whose writer
  belongs to a LATER stage of the same run (the stamp's settle-path writer, issue
  #271) is a pre-merge gate instead. The settled result names
  WHICH blocker fired: the gate report versus the verdict, plus `reviewRan`, so
  a run that settled without any review round is never rendered like "reviewed,
  no findings". A review stage that could not run to a verdict is its own red
  pause (`review_not_run`), resumable only by an explicit operator act.
- 2026-09-11: Every change passes `bun run check` (Biome format + lint, config in
  `biome.json`) with zero errors before it is considered done; CI runs it on push
  and PR. The Coder runs `bun run check:fix` as part of finishing; the Reviewer
  treats a non-clean `bun run check` as a blocker, evidenced by the captured
  output, not by assertion.
- 2026-09-11: The formatter/linter is Biome. Its rules are configurable (per
  `config.md`): tune `biome.json` — including a scoped `overrides` entry with a
  stated reason — rather than sprinkling inline `biome-ignore` suppressions. A
  suppression that must be inline carries a one-line reason.
- 2026-09-12: Install and release claims require a bounded temporary smoke of
  the produced artifact, with integrity checked and no global installation mutation.
- 2026-09-12: Every user-visible change updates `CHANGELOG.md`. Every shipped
  release or installable release candidate increments `package.json` according
  to Semantic Versioning; its exact version has a dated changelog heading, passes
  `bun run check:release`, and is the version reported by `ad-coder about`. A
  version already merged as an install target is never silently reused.
- 2026-09-17: **The delivery signature is a ledger projection (issue #240,
  closed with #239).** `ad-coder stamp delivery` renders the PR block straight
  from `.ad-coder/ledger/*.jsonl` -- run ids, total calls, provider-reported
  cost, fresh/cached/output tokens, then one compact row per declared role
  (orchestrator/planner/researcher/security/coder/reviewer) with its dominant
  model, calls, and cost; a role with no rows says "did not run" instead of
  vanishing. A model summarising its own cost can be wrong about it, so the
  numbers are never retyped by hand; re-run the command to refresh the block.
- 2026-09-18: **Every lane that spent money has a row, so the rows sum to the
  header (issue #336).** The orchestrator lane drives the whole run and was
  missing from the signature, which left the per-role rows adding up to less
  than the total above them and invited a reader to conclude the run cost less
  than it did. It leads the block -- first row, same shape as the others -- so
  the sum is checkable by eye in the order the roles are named.
- 2026-09-12: Project health is reviewed beyond the current diff. Before a public
  release, after a drift signal (oversized or high-churn module, repeated
  cross-boundary edits, or eight accumulated drift observations), and on an
  operator-requested audit, run a cold whole-project audit covering cohesion,
  dependency direction, duplication, testability, dead paths, and human-readable
  documentation. The Auditor records evidenced decomposition candidates in the
  backlog and never refactors them itself.
- 2026-09-12: A decomposition refactor begins with characterization tests, keeps
  each move behavior-preserving and green, and reports every test expectation
  that had to change. Prefer AST/LSP moves over regenerating working code.
- 2026-09-12: Gate output, project reconnaissance, web responses, and image bytes
  have mandatory positive safety ceilings because their content enters model or
  report contexts. Defaults live in exported typed config objects and every
  ceiling is overridable; zero is not accepted for these denial-of-service guards.
- 2026-09-12: Auditor and Reviewer assess function, class, module, and file size
  together with cohesion, responsibility count, dependency fan-in/fan-out,
  churn, and test seams. No raw line threshold alone authorizes a refactor.
  Comments must explain rationale, contract, provenance, risk, or a non-obvious
  invariant; narration of syntax, duplicated types, stale history, and generated
  verbosity are quality defects when clearer code can carry the meaning.
- 2026-09-17: **A quantity that changes behavior is not a constant in the
  source.** If it is needed, it is a setting with a default. The exceptions are
  the safety ceilings this contract and `config.md` enumerate explicitly, which
  bound runaway behavior and are named rather than discovered. The existing rule
  ("any behavior a reasonable user may want to change is configurable",
  `config.md`) states the obligation from the side of the user's wishes, and the
  person deciding what a user will want is the person writing the constant -- a
  compiled-in default is invisible, so nobody asks for it to become a setting.
  Stated as a prohibition the check is mechanical: is this number in the source?
  (issue #308)

## Sources

The install smoke runs without lifecycle scripts or ambient release credentials,
uses locked inputs and restricted network access, and cleans its temporary state.
