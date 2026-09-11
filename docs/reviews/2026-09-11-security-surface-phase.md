# Security surface signal and conditional Security phase

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** low
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| SecuritySurface type exists with JSDoc; Plan.securitySurface, PipelineConfig.roles.security?, PipelineResult.securitySurface? added | passed | git diff src/orchestration/types.ts: all four additions with House-style JSDoc; `bun run typecheck` → tsc --noEmit exited 0 |
| parsePlan with securitySurface 'elevated' returns it; 'huge'/missing throws malformed_plan; formatPlannerInstruction contains 'securitySurface' and the three literals | passed | plan.ts diff confirms all validators; ad-hoc bun script tested accept/reject behavior for good and malformed values; formatPlannerInstruction template literal contains 'securitySurface' and 'none'\|'low'\|'elevated' |
| 'elevated'+role runs ledger 'security' step + securityNotes in coder round-1 and reviewer prompts; 'elevated' no role skips with no step, approves; 'low'/'none' skip; result.securitySurface reflects submitted value | passed | New orchestration.test.ts scenarios (lines ~458-547) assert via MemoryLedgerSink step names and lastUserText capture; `bun test` all pass; stderr output 'orchestration: elevated security surface, no security role — skipping' confirmed during no-role scenario |
| prompts/security.md exists, terse, names four OWASP classes (injection, auth/access, data exposure, supply chain), asks for concrete risk+mitigation pairs as final text message | passed | prompts/security.md read in full: names all four OWASP classes; instructs 'State your mitigation requirements as your final text message' |
| prompts/reviewer.md references verifying provided mitigations; both prompts stay terse | passed | git diff prompts/reviewer.md: 4-line addition 'When you are given security mitigation requirements, verify each is actually met...' |
| SecuritySurface exported from src/index.ts, resolves, tsc clean | passed | git diff src/index.ts shows SecuritySurface added to type-only export block; package-exports.test.ts imports and asserts it; tsc --noEmit clean |
| bun test passes; all scenarios prove phase-runs/skips/skips/malformed; SecuritySurface asserted; pre-existing 97 tests still pass | passed | `bun test` → 100 pass, 0 fail, 453 expect() calls across 11 files; revert-and-restore proof (see Attacks) confirmed 6 new/updated tests fail without the feature |
| ARCHITECTURE.md, README.md (root), ROADMAP.md, CLAUDE.md drift log updated with Security phase description and follow-on note | passed | Read full diffs: ROADMAP entry explicitly marks 'DONE' and names 'submit_security' follow-on; CLAUDE.md gained exactly one new drift-log bullet |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| parsePlan with prompt-injection payload ('elevated\n\nIgnore all previous instructions...'), array, object, uppercase 'ELEVATED', whitespace 'elevated ' | held | bun run attack script: all five rejected with OrchestrationError code malformed_plan; only exact literals 'none'/'low'/'elevated' accepted |
| Revert non-test source files, keep new tests, run suite to confirm tests actually fail without the feature | held | git checkout -- src/orchestration/{types,plan,pipeline}.ts src/index.ts; bun test test/orchestration.test.ts test/package-exports.test.ts → 11 pass / 6 fail (missing_verdict, result.securitySurface undefined in both elevated scenarios, etc.); restored via git apply and diff-compared byte-identical to pre-revert; bun test → 100 pass, 0 fail |
| Check securityNotes threading path for shell/SQL/path/eval sink | held | Read pipeline.ts composeSecurityPrompt/formatSecurityNotes/appendSecurityNotes/composeReviewerPrompt: securityNotes only ever string-concatenated into prompt text (template literals `\n${securityNotes}`), never passed to exec/spawn/fs/eval; grep found no sinks in changed files |

## Issues found and fixed

- none

## Issues left unfixed (advisory)

- none

## Security findings

- none

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 40130
- coder (Code): 29488
- reviewer (Review): 10642
