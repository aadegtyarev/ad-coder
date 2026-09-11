# Implement ad-coder drive subcommand (part 2 of human-CLI)

**Date:** 2026-09-11  
**Verdict:** APPROVED  
**Complexity:** medium  
**Security surface:** none  
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| parseArgs returns --auto as boolean; USAGE includes drive line; run/role unaffected | passed | `bun run src/cli.ts` (no args) printed USAGE including 'ad-coder drive "<task>" --target-dir <dir> [--auto]' and exited 2; full suite (incl. cli.test.ts) 177/177 pass |
| driveWorkflow auto walks to done; assertTransitionOffered throws DriveError for unoffered transition; silentNoopWarning per spec | passed | `bun test test/cli-drive.test.ts test/package-exports.test.ts` → 9 pass, 0 fail, covering all four scenarios plus boundary-guard test |
| ad-coder drive fails loud on missing --target-dir/task; role's silent-no-op warning added | passed | `bun run src/cli.ts drive` → 'missing <task>' exit 2; `bun run src/cli.ts drive "task"` → '--target-dir is required' exit 2, both with full USAGE printed |
| Append-only exports resolve; existing exports unchanged | passed | test/package-exports.test.ts asserts driveWorkflow/DriveError/silentNoopWarning (values) and DriveErrorCode (type); tsc --noEmit clean across the whole tree |
| test/cli-drive.test.ts passes all four scenarios | passed | 9 tests (4 main scenarios + 2 extra: direct assertTransitionOffered test + boundary test); all pass |
| test/package-exports.test.ts passes with new symbols | passed | Included in the 9-pass run; all new exports asserted present |
| CHANGELOG/README/CLAUDE.md docs updated and accurate | passed | CHANGELOG [Unreleased] lists drive subcommand + silent-no-op signal; README replaces 'follow-on' with interactive/--auto usage + injected streams note; CLAUDE.md drift log has one new 2026-09-11 line |
| Tests genuinely catch the defect (revert-and-restore proof) | passed | Reverted src/cli.ts, src/index.ts and removed src/cli/drive.ts (kept test files) → both test files failed with 'Cannot find module' and 'Export named driveWorkflow not found'; restored via `git apply` (diff verified IDENTICAL) → `bun test` → 177 pass again |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Interactive drive loop fed emoji, 200KB garbage line, and EOF at a step with no matching offered kind | held | Independent attack script piped '🎉emoji\n' + 200000-char line + EOF into driveWorkflow(auto:false) against faux coder/reviewer session; output showed repeated 'unrecognized choice' re-prompts then correct fallback to default transition at stream exhaustion, returned approved:true, no hang/crash |
| Forged AvailableTransition (kind/toPhase/toRound not offered) submitted to assertTransitionOffered | held | test/cli-drive.test.ts 'transition not offered' + 'forged transition' tests pass; DriveError thrown with code 'transition_not_offered', detail matches rejected kind only |

## Issues found and fixed

- None in this pass

## Issues left unfixed (advisory)

- [minor] src/cli.ts: `driveCommand` duplicates `roleCommand`'s block (~15 lines) parsing --provider/--max-rounds/--default-complexity, resolving target dir, and building resolvePipelineConfig options. → Extract a shared helper (e.g. `buildPipelineConfig(task, targetDirArg, flags): PipelineConfig`) used by both, preventing drift as new flags are added.

## Security findings (if any)

- none

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 83315
- planner (Plan): 22222
- coder (Code): 31099
- reviewer (Review): 29994
