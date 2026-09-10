# Capability-Matrix Module Implementation

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| bun run typecheck passes | passed | tsc --noEmit exited clean, no output |
| deriveCapabilities cacheControllable — native-Anthropic (no compat) | passed | test/capabilities.test.ts lines 84-99; bun test returns 18 pass, 0 fail |
| deriveCapabilities cacheControllable — openai-completions+format-anthropic | passed | test/capabilities.test.ts lines 84-99; 18 pass, 0 fail |
| deriveCapabilities cacheControllable — plain openai-completions (no format) | passed | test/capabilities.test.ts lines 84-99; 18 pass, 0 fail |
| breakEvenReads ~1.4 for fable-5 cost (12.5/(10-1)) | passed | test lines 118-125 toBeCloseTo(1.4,1); 18 pass, 0 fail |
| breakEvenReads 'always' when cacheWrite=0 | passed | test lines 118-125 toBe('always'); 18 pass, 0 fail |
| Barrel exports resolve at runtime | passed | git diff src/index.ts shows value+type exports added; test/package-exports.test.ts still passes in 74-pass full suite |
| Barrel exports typecheck | passed | tsc --noEmit clean with new exports in place |
| test/capabilities.test.ts — all branches asserted | passed | bun test test/capabilities.test.ts => 18 pass, 0 fail (costMode, cacheControllable, metrics, reconciliation) |
| Full test suite stays green | passed | bun test (full) => 74 pass, 0 fail, 313 expect() calls, matching Coder baseline-to-current delta (56 -> 74) |
| README capability-matrix section added | passed | git diff shows '## The capability matrix' section with deriveCapabilities, cost modes, corrected predicate, metrics, reconciliation |
| ARCHITECTURE — Components bullet added | passed | git diff shows src/capabilities/ added to Components list |
| ARCHITECTURE — Key decisions citing corrected predicate | passed | git diff shows Key decisions bullet with api-OR-format predicate and false-negative rationale on format-only rule |
| ROADMAP moved to DONE, predicate corrected | passed | git diff shows item moved from 'Next (planned / in flight)' to Status DONE; stale bare `cacheControlFormat === "anthropic"` replaced with corrected api-OR-format wording |
| CLAUDE.md drift-log bullet added inside ldo:features block | passed | grep confirms `<!-- ldo:features -->` at line 69, new '- 2026-09-11: Capability-matrix module...' immediately before closing delimiter at line 75 |
| Scoped revert-and-restore proof — test fails without implementation | passed | Deleted src/capabilities/capabilities.ts; bun test 'test/capabilities.test.ts' => module-not-found error, 0 pass/1 fail |
| Scoped revert-and-restore proof — test passes after restore | passed | Restored src/capabilities/capabilities.ts from backup; 18 pass, 0 fail; git status confirmed tree returned to exact original state |
| pi-ai citation accuracy — types.d.ts:468 is OpenAICompletionsCompat | passed | Read node_modules; types.d.ts line 468 is `export interface OpenAICompletionsCompat` |
| pi-ai citation accuracy — types.d.ts:516 is cacheControlFormat field | passed | Read node_modules; types.d.ts line 516 is `cacheControlFormat?: "anthropic";` on OpenAICompletionsCompat |
| pi-ai citation accuracy — anthropic-messages.js:29 is getCacheControl | passed | Read node_modules; line 29 is `function getCacheControl(model, cacheRetention, env) {` |
| pi-ai citation accuracy — openai-completions.js:808 cache-format check | passed | Read node_modules; ~line 807 is the compat.cacheControlFormat !== "anthropic" gate |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| IPv6 loopback in bracket form (http://[::1]:1234/v1) | broke | bun -e 'console.log(new URL("http://[::1]:1234/v1").hostname)' => "[::1]" (brackets included); LOOPBACK_HOSTS only contains unbracketed "::1"; deriveCapabilities returns costMode "prepaid" not "local". Unbracketed form "http://::1/v1" throws (URL parse error), so bracketed form is the only syntactically valid way to express IPv6 loopback and is currently misclassified. |
| 10.example.com — public hostname with "10." string prefix | held | deriveCapabilities returns costMode 'local' for http://10.example.com/v1 (false positive on naive "10.*" check); this matches the plan's exact verbatim specification ("10.*" string form) and JSDoc already documents it as best-effort/overridable, so not treated as a coding defect, only as a design limitation already acknowledged. |
| Negative cost fields (cost.input = -5) | held | costMode correctly computes 'per-token' (nonzero check flags the -5); no crash, value propagates visibly. |
| NaN cost fields (cost.input = NaN) | held | costMode correctly computes 'per-token' (NaN !== 0 is truthy); breakEvenReads returns NaN rather than throwing or silently misclassifying; invalid input is propagated visibly, not masked. |

## Issues found and fixed

None — all plan acceptance criteria met without blocking issues.

## Issues left unfixed (advisory)

- [minor] `src/capabilities/capabilities.ts`: isLocalHost LOOPBACK_HOSTS contains bare string "::1", but `new URL(...).hostname` for any syntactically valid IPv6-loopback URL always returns the bracketed form "[::1]" (confirmed: unbracketed "http://::1/v1" throws 'cannot be parsed as a URL'). So the "::1" entry can never match any real input; a legitimate baseUrl like "http://[::1]:11434/v1" is silently misclassified as prepaid instead of local, defeating one of the four explicitly-named loopback forms. → Fix: strip surrounding brackets before the lookup, e.g. `const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;` then check LOOPBACK_HOSTS.has(bare), or add "[::1]" itself to the set. One-line change; verify with bun -e check after applying.

## Security findings

none

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 51947
- planner (Plan): 23198
- coder (Code): 16247
- reviewer (Review): 12502
