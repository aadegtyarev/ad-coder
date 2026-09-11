# Runner tool-injection seam

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Step 1: Tool type alias and defineTool helper compile and preserve generics | passed | bun run typecheck (tsc --noEmit) with no errors; defineTool import resolves; identity behavior confirmed |
| Step 2: assertUniqueToolNames detects tool_name_collision with .path set correctly | passed | Coder test (c) passed; custom-vs-custom attack test independently confirmed RunnerError with code 'tool_name_collision' and path === 'dup' |
| Step 3: runRole integrates custom tools, combines with built-ins, validates uniqueness before harness | passed | Test (e) regression (droppedRecords===0); test (a,b) custom tool invoked and args captured; test (c) collision detected pre-harness |
| Step 4: RoleRunner threads tools per-call via exactOptionalPropertyTypes conditional spread | passed | tsc --noEmit clean under strict flags; conditional spread pattern matches existing idiom exactly |
| Step 5: defineTool/Tool re-exported from 'ad-coder' barrel | passed | test/package-exports.test.ts assertions for typeof defineTool==='function' and Tool type-only const passed |
| Step 6: Full test suite passes with case (a)-(e) coverage | passed | bun test: 93 pass, 0 fail, 409 expect() calls across 11 files |
| Step 7: Documentation updated (ARCHITECTURE, README, ROADMAP, BACKLOG, CLAUDE) | passed | Diff shows BACKLOG line-20 followup marked [done]; ARCHITECTURE/README/ROADMAP describe seam; CLAUDE.md has exactly one new drift-log entry; no fabrication |
| Step 8: Tests are load-bearing (not decorative) | passed | Reverted non-test files while keeping test files -> both failed (module-not-found); restored -> all 93 green again; diff byte-identical before/after |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Two custom tools sharing the same name (custom-vs-custom collision) | held | Added test with two defineTool() objects both named 'dup' passed in tools[]; runRole threw RunnerError code 'tool_name_collision' with path 'dup' |
| Empty tools: [] array vs. omitting tools entirely | held | runRole({..., tools: []}) completed with status 'completed', identical to omitting tools; behavior consistent |
| Empty activeToolNames combined with supplied custom tool | held | Role with activeToolNames: [] and custom tool 'sneaky' supplied via tools[]; tool side-effect array stayed empty — uniform filter blocked it same as built-in |

## Issues found and fixed

- None

## Issues left unfixed (advisory)

- None

## Security findings (if any)

- None

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.
- Total: 45004
- coder (Code): 33763
- reviewer (Review): 11241
- Your own Record phase is NOT in these figures: this block was composed before you were called, so nothing here could include it. The run log and the returned result carry a later total that does.

https://claude.ai/code/session_01MH774C1JtVy2CNbv5Dnb1n
