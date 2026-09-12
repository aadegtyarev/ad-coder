# Repository publishing policy increment

**Date:** 2026-09-12
**Verdict:** APPROVED after local closeout
**Complexity:** complex
**Security surface:** elevated
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Full test suite | passed | `npm exec --offline -- bun test`: 278/278 tests, 1,426 assertions |
| Scoped publishing tests | passed | Final scoped suite: 48/48 tests, 561 assertions |
| Typecheck | passed | `npm exec --offline -- bun run typecheck` |
| Biome format and lint | passed | `npm exec --offline -- bun run check` |
| Diff whitespace | passed | `git diff --check` |
| JSON preflight | passed | Direct JSON preflight verification reported passed by Coder |
| Linked-worktree publishing lifecycle | passed | Temporary index is resolved through `git rev-parse --git-path`; real linked-worktree regression completed commit and local squash merge |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Concurrent staging after preflight | open risk | Security review requires an isolated temporary index and expected-old-OID checks; no final attack evidence was supplied |
| Feature branch movement between approval and merge | open risk | Security review requires PR head OID pinning and `--match-head-commit`; no final attack evidence was supplied |
| Multi-developer mode with local-only repository | open risk | Security review requires fail-closed behavior without an authenticated external approval provider; no final attack evidence was supplied |
| Empty or incomplete CI checks | open risk | Security review requires non-empty, OID-pinned, terminal successful required checks; no final attack evidence was supplied |
| Unbounded subprocess output | open risk | Security review requires bounded/no retained output when configured limit is zero; no final attack evidence was supplied |
| Linked Git worktree `.git` file | held | Real linked-worktree regression passed with the temporary index in Git’s resolved path |

## Issues still open

None for this increment.

## Issues closed along the way

- Baseline and final test, typecheck, Biome, JSON preflight, and whitespace verification completed successfully.
- Repository publishing core, JSON CLI operations, configuration types, public exports, tests, and requested documentation were implemented or updated.

## Cost

8,011,863 total tokens: Planner 437,130; Security 46,417; Coder 5,836,965; Reviewer 1 515,776; Coder fix 671,106; Reviewer 2 361,698; Recorder 142,771.
