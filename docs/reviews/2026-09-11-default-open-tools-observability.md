# Default-open tools & tool-usage observability

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** none
**Coder passes:** 2

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| toolCallCounts correctly and safely counts ANY tool name, not just happy-path names | passed | bun test test/ledger.test.ts: 'tool names colliding with Object.prototype members are counted, not corrupted' passes; hasOwnProperty:2, toString:1, __proto__:1 all own keys with correct integer counts; manual attack with constructor/toLocaleString also held |
| Tool call named hasOwnProperty (or toString, valueOf, propertyIsEnumerable, toLocaleString) does not corrupt ledger field with string instead of number | passed | sink.records()[0].toolCalls.hasOwnProperty === 2 (a real number, not function string); revert-and-restore proof shows pre-fix code produced corrupted string, confirming both fix and test work |
| Tool call named __proto__ does not vanish from count via prototype reassignment | passed | sink.records()[0].toolCalls.__proto__ === 1 as own property (confirmed via Object.fromEntries comparison and direct node inspection of Object.keys/JSON.stringify); Map-derived result has correct own properties |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Tool call named `hasOwnProperty` (x2), `toString`, and `__proto__` fed through full ledger record path | held | bun test test/ledger.test.ts (post-fix): 'tool names colliding with Object.prototype members are counted, not corrupted' passes; sink.records()[0].toolCalls equals {hasOwnProperty:2, toString:1, __proto__:1} via Object.fromEntries own-key comparison |
| Manual attack with `constructor`, `__proto__`, `toLocaleString` tool names directly against toolCallCounts() | held | bun run ad-hoc script: JSON.stringify(counts) => {"constructor":2,"__proto__":1,"toLocaleString":1}; Object.keys(counts).length === 3, all own properties, no corruption |
| Revert only src/ledger/usage.ts's toolCallCounts to pre-fix plain-object+`?? 0` implementation, keep new regression test and run | held | Manually restored buggy object-literal version and ran bun test test/ledger.test.ts: new prototype-collision test FAILED exactly as predicted with hasOwnProperty corrupted to function-string concatenation; restored fix afterward; full scoped suite (28 tests) green again, git diff byte-identical to pre-revert state |

## Issues found and fixed

- [high] `src/ledger/usage.ts`: toolCallCounts() used plain object tally vulnerable to prototype-collision bugs (hasOwnProperty/toString inherited-member read-through and __proto__ bracket-assignment special case) → replaced with Map<string,number> materialized via Object.fromEntries at return time; eliminated entire class of bugs because Map has no prototype chain and fromEntries always creates own properties

## Issues left unfixed (advisory)

- None

## Security findings (if any)

- None

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.
- Total: 93935
- planner (Plan): 18574
- coder (Code): 27607
- reviewer (Review): 26601
- coder-fix-1 (Code): 6827
- reviewer-1 (Review): 14326
