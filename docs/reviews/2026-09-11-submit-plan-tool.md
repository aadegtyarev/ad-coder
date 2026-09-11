# Submit Plan Tool — Structured Complexity Signal

**Date:** 2026-09-11  
**Verdict:** APPROVED  
**Complexity:** medium  
**Security surface:** none  
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| types.ts: OrchestrationErrorCode includes 'malformed_plan'; PipelineResult.complexity optional Complexity; exports Complexity, Plan | passed | `grep -A5 "export type Complexity" src/orchestration/types.ts` shows `type Complexity = 'trivial' \| 'medium' \| 'complex'`; `grep "complexity?" src/orchestration/types.ts` shows optional field; `bun run typecheck` (tsc --noEmit) exits clean |
| parsePlan strict validation; buildSubmitPlanTool signature | passed | Test run: `'parsePlan accepts well-formed and rejects bad complexity...'` passes; parsePlan({complexity:'medium',summary:'s'},'id') returns {complexity:'medium',summary:'s'}; parsePlan({complexity:'huge',summary:'s'},'id') throws OrchestrationError code 'malformed_plan'; buildSubmitPlanTool(...).name === 'submit_plan' confirmed |
| Planner calling submit_plan surfaces complexity; text-only planner leaves undefined; malformed throws; existing tests pass | passed | bun test: 97 pass, 0 fail (up from baseline 93; 4 new tests added matching diff). Pre-existing verdict/loop/ledger scenarios unchanged. Confirmed via revert-and-restore proof: deleted plan.ts + reverted types/pipeline/index diffs, both orchestration.test.ts and package-exports.test.ts failed at import ("Cannot find module '../src/orchestration/plan'"), then restored via git apply + restored plan.ts, all 97 pass and tsc clean |
| Exports from src/index.ts resolve; package-exports test covers all new names | passed | `import { buildSubmitPlanTool, SUBMIT_PLAN_TOOL_NAME } from 'ad-coder'` resolves; `import type { PlanCapture, Complexity, Plan } from 'ad-coder'` resolves; test/package-exports.test.ts asserts typeof for value exports and erased-type references for type imports, all matching pre-existing verdict.ts pattern; bun test passes 97/97 |
| Docs: ARCHITECTURE names plan.ts and soft/hard split; README documents result.complexity as optional signal; ROADMAP marks submit_plan DONE, routing OPEN; CLAUDE.md drift log updated | passed | Read full diffs: ARCHITECTURE orchestration bullet describes plan.ts exports and "SOFT planner semantics: absent submit_plan -> complexity undefined, proceeds; malformed -> hard malformed_plan"; README pipeline section notes result.complexity is optional submit_plan signal; ROADMAP: "submit_plan DONE" with checkbox, complexity-aware routing as next follow-on (states clearly this unit does NOT wire routing); CLAUDE.md drift log has new line "2026-09-11: Implement submit_plan tool for structured complexity signal" |

## Attacks

| Vector | Outcome | Evidence |
|---------|---------|----------|
| Prototype pollution via __proto__ key | held | parsePlan(JSON.parse('{"complexity":"medium","summary":"s","__proto__":{"polluted":true}}'), 'id') accepted normally; Object.prototype.polluted remained undefined |
| Boxed String, numeric, case-variant ('Medium'), whitespace-padded (' medium') complexity | held | All four rejected: malformed_plan. Typeof and literal-match checks caught each variant correctly |
| Array as top-level value, function as summary | held | Both rejected with malformed_plan (Array.isArray and typeof checks caught them) |
| Oversized (1MB) and emoji-heavy summary | held | Both accepted as valid plans; no crash, no truncation. Matches verdict.ts pre-existing lack of summary size cap (documented as intentional, not a defect) |
| Two submit_plan calls in one turn: valid then malformed (tests last-wins doesn't silently keep earlier good plan) | held | Scripted fauxToolCall('medium','first') + fauxToolCall('huge','second') + text; runPipeline threw OrchestrationError malformed_plan. Second call correctly overwrote first rather than silently retaining it |
| Two submit_plan calls in one turn: malformed then valid (tests recovery to final good submission) | held | Scripted fauxToolCall('huge','first') + fauxToolCall('trivial','second') + text; result.complexity === 'trivial'. Last-wins behavior correctly recovers to final valid submission |

## Issues found and fixed

None. No defects identified during review or attack phase.

## Issues left unfixed (advisory)

None.

## Security findings (if any)

None. No network calls, no crypto, no untrusted input parsing beyond the documented strict schema gate.

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 46576
- coder (Code): 19948
- reviewer (Review): 26628
