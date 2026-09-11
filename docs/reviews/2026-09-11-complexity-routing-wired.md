# Complexity-aware profile routing wired into runPipeline

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| PipelineRouting interface added with type-only imports, no circular-import errors | passed | bunx tsc --noEmit: no output (clean). |
| Routing-absent path byte-for-byte identical; existing tests + examples/pipeline.ts unaffected | passed | bun test (full suite): 145 pass, 0 fail. bun run examples/pipeline.ts: approved:true, rounds:1, unchanged cost breakdown. |
| PipelineRouting exported from ad-coder and pinned in package-exports test | passed | src/index.ts adds PipelineRouting to type-export block alphabetically; test/package-exports.test.ts imports and asserts it; bun test test/package-exports.test.ts -> 2 pass, 0 fail. |
| Five routing tests (a)-(e) pass, asserting on recorded model.id | passed | bun test test/orchestration.test.ts test/package-exports.test.ts -> 22 pass, 0 fail (includes routing (a)-(e)). |
| Docs name the routing wiring as built, not pending | passed | Verified CHANGELOG.md [Unreleased]/Added, docs/ARCHITECTURE.md config layers note, CLAUDE.md drift log, and README.md all describe CONSUMED/live behavior (defaultComplexity fallback, override precedence, unwrapped ProfileError). |
| Revert-and-restore proof: routing tests fail on old code, pass on new code | passed | After git checkout -- on 7 non-test files (tests kept): routing (a)/(b)/(c)/(d) failed with mismatched model ids; routing (e) still passed. After git apply restoring patch: 22 pass, 0 fail; git diff --stat byte-identical pre-revert. |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| config.routing.profile missing the (coder, complex) mapping cell mid-pipeline | held | Built profile filtered to remove coder:complex entry, ran runPipeline with routing set to it. Result: THROWN ProfileError missing_mapping with message "profile has no entry for (role, complexity) "coder:complex"" -- propagates unwrapped as documented, no silent fallback. |
| config.routing.overrides.coder pointing at unregistered model name | held | Verified resolveProfile rethrows RegistryError as ProfileError('unknown_model', name) when registry.getModel throws; pipeline.ts does not wrap or swallow, propagates through pickModel uncaught. |
| Full existing suite + examples/pipeline.ts on routing-absent path (regression risk from runTurn signature refactor) | held | bun test (full suite): 145 pass, 0 fail. bun run examples/pipeline.ts: approved:true, rounds:1, cost breakdown intact -- byte-for-byte unchanged. |

## Issues found and fixed

- [nit] test/package-exports.test.ts: `expect(_pipelineRouting).toBeUndefined()` is placed inline immediately after the `_pipelineRouting` declaration (line 145), breaking the file's own pattern of declaring a whole block of `_xyz` consts first and then asserting all of them together afterward (lines 122-144 declare, 161-197 assert). Functionally harmless, does not block approval. Recommendation: move `expect(_pipelineRouting).toBeUndefined()` down into the batched assertion block next to other config/result assertions, matching the rest of the file.

## Security findings

none

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 64108
- planner (Plan): 20788
- coder (Code): 30422
- reviewer (Review): 12898
