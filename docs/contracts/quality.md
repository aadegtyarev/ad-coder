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

## Sources

The install smoke runs without lifecycle scripts or ambient release credentials,
uses locked inputs and restricted network access, and cleans its temporary state.
