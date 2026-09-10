# Quality Gates Module Implementation

**Date:** 2026-09-11  
**Verdict:** APPROVED  
**Complexity:** medium  
**Security surface:** none  
**Coder passes:** 2

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| GateRunner.run() surfaces executor rejection or size-gate read failure as that gate failing, not as an unhandled exception | passed | Live attack script against actual src/gates/runner.ts: rejecting executor and nonexistent file path both returned a normal GateReport with passed:false and the specific gate's output naming the error, no exception thrown. Full suite: bun test => 56 pass, 0 fail; bun run typecheck => clean. |
| New tests actually catch the regression (not decorative) | passed | Reverted only the try/catch in runOne (kept tests): bun test test/gates.test.ts => 7 pass, 2 fail, with the two new tests failing with the exact ENOENT propagation described in the issue. Restored fix (diff showed byte-identical restore): bun test test/gates.test.ts => 9 pass, 0 fail. |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Injected executor that rejects (models a real spawn failing: binary not found, EACCES) | held | bun run /tmp/attack_gates.ts: Attack1 => {"results":[{"name":"lint","kind":"lint","passed":false,"output":"gate lint (kind lint) errored: spawn eslint ENOENT"}],"passed":false} — no exception propagated, gate reported failed. |
| Size gate given a nonexistent file path | held | bun run /tmp/attack_gates.ts: Attack2 => {"results":[{"name":"size","kind":"size","passed":false,"output":"gate size (kind size) errored: ENOENT: no such file or directory, open '/nonexistent/path/xyz.ts'"}],"passed":false} — no exception propagated, gate reported failed. |

## Issues found and fixed

- [critical] `src/gates/runner.ts`: GateRunner.run() propagated unhandled exceptions when a gate's executor rejects or the size gate's readFileSync throws → Added try/catch wrapping both external-gate executor calls and in-process size-gate read in runOne, converting any thrown/rejected error into a failed GateResult naming the gate and carrying the bounded error message. Matches the plan's fail-loud framing and the project's Ledger/Compactor 'return a failing report, don't throw' idiom.

## Security findings

none

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 57990
- coder (Code): 25624
- reviewer (Review): 18606
- coder-fix-1 (Code): 4284
- reviewer-1 (Review): 9476
