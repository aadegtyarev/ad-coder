# Fix a correctness bug in the Ledger's usage semantics

**Date:** 2026-09-10
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Step 1: UsageAmounts/UsageDelta/LedgerRecord shape in types.ts | passed | Read src/ledger/types.ts: UsageAmounts holds the numeric fields (input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost), UsageDelta extends it with anomaly?, LedgerRecord.usage: UsageAmounts, no delta field |
| Step 2: usageAmounts() allow-list copier with correct fresh-object/omission semantics | passed | bun test test/ledger-delta.test.ts -- 'usageAmounts copies a reading and keeps unreported fields unreported' passed (part of the 37/37 full run); code read confirmed cost is rebuilt field-by-field and cacheWrite1h/reasoning use conditional spread `...(x !== undefined && { x })` |
| Step 3: perResponseUsageFrom + record() drops diffing; tracker/forgetStream/streamKey removed | passed | `grep -n "cumulativeUsageFrom\|UsageDeltaTracker\|forgetStream\|streamKey" src/ledger/ledger.ts` returns nothing; live test 'a sequence of per-response readings sums...' shows records[0..2].usage.input = 100,250,400 (raw readings, not 100,150,150 diffs) and usage is not the same object reference as the input reading |
| Step 4: index.ts exports UsageAmounts/usageAmounts alongside existing exports; typecheck clean | passed | `bun run typecheck`: tsc --noEmit exit 0; src/index.ts diff shows both new exports added in alphabetical order, existing ones (diffUsage, UsageDelta, UsageDeltaTracker, LedgerRecord) preserved |
| Step 5-6: ledger.test.ts updated/added tests pass and prove per-response recording | passed | bun test: 37 pass / 0 fail overall; grep for 'delta\|forgetStream' in test/ledger.test.ts returns nothing; pairwise-difference test renamed and asserts records[0].usage.input === 100, records[1].usage.input === 250; summation test present with three per-response readings, each record.usage deep-equals the corresponding reading (not same object reference), field-wise sum via local addUsage mirror matches the raw sum |
| Step 7: ledger-delta.test.ts keeps all 7 prior tests + new usageAmounts test, reframed comment | passed | Diff shows only additive changes (header comment reframed to state the test covers diffUsage/UsageDeltaTracker for genuinely CUMULATIVE sources like message_update, NOT after_response which is per-response and covered in ledger.test.ts + one new test); full suite includes these tests passing; all seven pre-existing tests still present by name |
| Step 8: docs corrected, no stray 'delta' or cumulativeUsageFrom references | passed | `grep -rn cumulativeUsageFrom README.md docs/ src/ test/` → empty; `grep -n '"delta"' README.md` → empty; README JSON sample parses via node -e and its key set (ts,runId,lane,role,step,provider,model,stopReason,status,usage) matches LedgerRecord exactly; CLAUDE.md drift-log diff is exactly +1 line; docs/pi-capabilities.md (Russian) corrected with verified per-response finding and line-specific 0.85.1 citations |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| after_response event whose message.usage is missing the required cost object (malformed provider payload) | held | Constructed a fake HookInvocation with usage lacking cost and invoked the registered handler directly. Result: records: 0 (record dropped, not written half-formed) and stderr contained warning: true (matches the "/ledger write failed/" message on first drop) -- fails loudly via the existing try/catch + drops counter, consistent with the plan's rewritten catch comment |
| two concurrent after_response events on the same runId/lane (was previously handled by a shared tracker baseline; tracker is now removed) | held | Promise.all of two handler invocations with input 500 and 999 both landed as independent records with their own numbers ('records after concurrency: 2 [999]' for the record after the dropped one) -- no shared mutable baseline to race on since UsageDeltaTracker was removed from the after_response path |

## Issues found and fixed

None. All issues present in the codebase were addressed by the implementation:
- The Ledger was subtracting per-response readings via UsageDeltaTracker (incorrect diffing logic) → now records the per-response reading directly
- LedgerRecord's field was misnamed `delta` (suggesting a difference) → renamed to `usage` (stating the semantics: that response's own numbers)
- The seam `cumulativeUsageFrom` carried a false promise → renamed to `perResponseUsageFrom` with evidence comment citing pi-agent-core 0.85.1 lines
- Tests asserted the wrong behavior (delta subtraction) → updated to assert per-response recording and added summation proof
- Docs described the cumulative (false) behavior → corrected with evidence and contrasted with the genuinely cumulative message_update event

## Issues left unfixed (advisory)

None.

## Security findings (if any)

None.

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.
- Total: 68531
- planner (Plan): 28246
- coder (Code): 23568
- reviewer (Review): 16717
