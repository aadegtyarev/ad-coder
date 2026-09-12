# Quality contract

Rules for the project's own code quality. A violation is always blocking.

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

## Sources

The install smoke runs without lifecycle scripts or ambient release credentials,
uses locked inputs and restricted network access, and cleans its temporary state.
