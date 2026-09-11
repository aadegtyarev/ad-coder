# Documentation handoff restructuring

**Date:** 2026-09-12
**Verdict:** APPROVED — documentation-only handoff restructuring

## Changes reviewed

- Retired the duplicate `docs/CHECKPOINT.md` snapshot after moving its durable
  operating rules and planning-cost evidence to canonical documents.
- Made README the documentation navigator and AGENTS.md the durable handoff
  router; replaced the legacy Claude-specific workflow snapshot with a
  compatibility pointer.
- Recorded the openai-codex pipeline smoke failure separately and added its
  provider-reliability follow-up to the backlog.
- Follow-up correction: preserved the checkpoint's historical delivery-test and
  merge evidence in the matching roadmap/review documents, preserved the live
  DeepSeek cost observations in cost research, linked AGENTS.md from README,
  and verified the architecture's three-way tool-access behavior against source
  and its test.

## Evidence

| Check | Result |
|---|---|
| Stale checkpoint / legacy-feature-log reference audit | passed: `rg -n 'docs/CHECKPOINT.md|CHECKPOINT.md|ldo:version 2\\.42\\.0|ldo:features' --glob '!docs/reviews/**' .` returned no matches |
| Diff whitespace | passed: `git diff --check` exited 0 |
| Runtime tests | passed: with the cached Bun 1.3.0 binary prepended to `PATH`, `bun test` passed 218 tests with 0 failures |
| Required quality check | passed: with the same Bun path, `bun run check` ran `biome check src test` successfully (62 files) |
| Architecture tool-access map | passed: `src/role.ts` and `test/role.test.ts` confirm absent `activeToolNames` omits the option/default-opens, `[]` denies all, and a non-empty array is an exact allow-list |

## Open item

The documentation content findings from the prior review are resolved. The
initial direct `bun test` attempt failed with exit 127 because Bun was not on
the inherited `PATH`; a cached Bun 1.3.0 binary was then located and prepended
to `PATH`, allowing both required commands to pass. No runtime or contract file
was changed by this documentation-only pass.
