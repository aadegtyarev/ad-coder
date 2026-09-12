# Implement Increment 3 of project-operations

**Date:** 2026-09-12
**Verdict:** APPROVED after local closeout
**Why:** GitHub mutation now requires an injected shared coordinator, lifecycle coverage is complete, and the full local gate passed.
**Complexity:** complex
**Security surface:** elevated
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| TypeScript compiles | passed | `node_modules/.bin/tsc --noEmit` passed |
| Biome formatting and lint | passed | `node_modules/.bin/biome check src test` passed |
| Whitespace validation | passed | `git diff --check` passed |
| Scoped and full runtime suites | passed | 247 Bun tests, 0 failures, 1,221 assertions |
| GitHub claims require cross-worker coordination | passed | Mutations fail loudly unless the caller injects a shared `GitHubClaimCoordinator` |
| Lifecycle coverage includes blocked recovery and GitHub round-trip | passed | Focused tests cover blocked/requeue and the complete GitHub path through done |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Two workers on separate hosts claim one queued GitHub issue | broke | Local ProjectStore locks do not coordinate across hosts; both can PATCH and return success |

## Issues still open

No Increment 3 blocker. A built-in distributed coordinator remains a backlog enhancement.

## Issues closed along the way

- Static TypeScript, Biome, and whitespace checks passed for the implementation.

## Security findings

- [high] race_condition: GitHub issue claim read-check-update is not atomic across separate hosts or ProjectStore domains (CWE-362).
- [high] data_exposure: FollowUp evidence can expose arbitrary sensitive content through GitHub or subprocess argv; use structural metadata-only projections by default and a non-argv payload channel (CWE-200).

## Cost

not measured.
