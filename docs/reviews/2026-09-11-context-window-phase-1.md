# Phase 1: Context-Window Management In-House

**Date:** 2026-09-11  
**Verdict:** APPROVED  
**Complexity:** complex  
**Security surface:** none  
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| validateContextBudget rejects non-integer/zero/negative fields, maxTokens>contextWindow (both numbers in message), reserve+keepRecent>=maxTokens; accepts valid | passed | bun test test/role.test.ts and test/context.test.ts all green; manual: defineRole with NaN maxTokens threw 'maxTokens must be a positive integer' |
| defineRole(input, model) signature change; validates budget via validateContextBudget; toHarnessOptions still emits compaction:{enabled:false,reserveTokens:0,keepRecentTokens:0} | passed | src/role.ts diff confirmed; test 'toHarnessOptions passes the system prompt...disables compaction' passed; bun run typecheck clean |
| ContextCompactor selectRecentTail suffix logic preserves tail within keepRecentTokens budget; never returns empty tail for non-empty input; handler measures and conditionally summarizes | passed | bun test test/context.test.ts: 'over-budget...summarized once with only the evicted head' passed; revert-and-restore proof (patched threshold to `if(true)`) caused both 'summarized once' and 'summarizer throws' tests to fail, restored and full 47-test suite green |
| ContextCompactor handler invokes summarizer exactly once with ONLY the evicted head; on throw, counts compactionFailures and warns once to stderr, does not rethrow | passed | test 'a summarizer that throws...bumps compactionFailures' passed; attack script: 3 concurrent handler calls with throwing summarizer -> compactionFailures===3, summarizer called 3x, stderr warning printed exactly once |
| assertTurnFitsBudget throws typed ContextBudgetError when irreducible tail+reserve exceeds ceiling; accepts valid under-budget turns; works with caller-supplied non-catalog Model | passed | test 'assertTurnFitsBudget throws a typed ContextBudgetError on an impossible turn' passed; manual: localModel (contextWindow:1000) with role (maxTokens:100000) correctly threw via effective ceiling=min(100000,1000) |
| New surface exported from src/index.ts; importable via package name | passed | test/package-exports.test.ts passed; src/index.ts diff: ContextBudgetError, ContextCompactor, SUMMARIZATION_PROMPT, assertTurnFitsBudget, ContextBudget, Summarizer all exported |
| Full test suite green; zero network/API keys in tests | passed | bun test: 47 pass, 0 fail (37 baseline + 10 new); grep -rn 'fetch(\|http://\|https://\|apiKey\|API_KEY\|process.env' test/ found only unrelated CLI test rejecting a URL specifier, no live calls |
| README/ARCHITECTURE/CLAUDE.md describe shipped context subsystem and caller-supplied-model rationale; drift log updated | passed | git diff README.md docs/ARCHITECTURE.md CLAUDE.md read in full; content matches actual code (defineRole(role, model), ContextCompactor hook id 'ad-coder/context-compactor', SUMMARIZATION_PROMPT, assertTurnFitsBudget); CLAUDE.md has one new dated drift-log entry |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Concurrent transform_context invocations (3 parallel calls) racing on compactionFailures counter and 'warn once' guard | held | attack script: 3 concurrent handler() calls each with throwing summarizer -> compactionFailures===3, summarizer called 3 times, stderr warning printed exactly once (guarded by `this.failures === 1`) |
| Scale: selectRecentTail over 50,000 tiny messages | held | ran in 1ms, head/tail split correct (49950/50), no quadratic blowup |
| NaN/non-finite budget field into defineRole | held | defineRole({...contextBudget:{maxTokens:NaN,...}}, model) threw 'defineRole(x): maxTokens must be a positive integer' |
| Empty messages array into selectRecentTail | held | selectRecentTail([], 1000) -> {head:[],tail:[]}, no throw |
| Unicode/emoji/newline-heavy message content through selectRecentTail | held | handled without error, content preserved verbatim in tail |
| assertTurnFitsBudget called with runtime Model smaller than the model the role was defined against (window mismatch) | held | role defined against 200000-window model with maxTokens=100000, called with 1000-window model and ~1000-token tail -> correctly threw ContextBudgetError via effective ceiling = min(maxTokens, model.contextWindow) |

## Issues still open (advisory)

- [minor] `src/context/budget.ts`: ContextBudgetError's message text says "measured N tokens against maxTokens M" but the actual determining threshold (per preflight.ts deviation) is `ceiling = min(maxTokens, model.contextWindow)`, which the error does not surface. When a role defined against a 200000-window model is invoked with a 1000-window model, the throw displays "maxTokens 100000" even though the real ceiling was 1000 — a reader debugging from the message alone sees numbers that shouldn't have failed. Consider adding the effective ceiling (or model's contextWindow) to ContextBudgetError fields and message text for self-consistency. This is cosmetic/debugging-clarity only; pass/fail behavior is correct in all cases.

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 70021
- coder (Code): 52763
- reviewer (Review): 17258
