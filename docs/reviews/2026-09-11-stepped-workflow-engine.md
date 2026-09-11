# Stepped Workflow Engine Implementation

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** complex
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Step 1: types compile, new types exported, no existing type altered | passed | bunx tsc --noEmit exits 0; git diff shows only additive interfaces/types appended to src/orchestration/types.ts, no existing type body changed |
| Step 2: session.ts compiles, exports createWorkflowSession/applyTransition/autoDriver; parsePlan/parseVerdict remain gate | passed | Read src/orchestration/session.ts: capture.error re-thrown from parsePlan/parseVerdict paths inside stepPlan/stepReview; missing_verdict thrown with runId-only detail; invalid_max_rounds/empty_task thrown with String(number)/'' detail at createWorkflowSession's top |
| Step 3: bun test test/orchestration.test.ts pre-existing cases pass unchanged; runPipeline signature unchanged | passed | bun test 'src/orchestration/...' run: 25 pass, 0 fail; full bun test: 162 pass, 0 fail (159 baseline + 3 new); runPipeline(config: PipelineConfig): Promise<PipelineResult> signature untouched in diff |
| Step 4: new value/type exports resolve from 'ad-coder', existing exports untouched | passed | git diff src/index.ts shows strictly additive lines in existing value/type export blocks; test/package-exports.test.ts passes |
| Step 5: package-exports.test.ts pins pass | passed | Included in 25-pass scoped run and 162-pass full run |
| Step 6: 3 new stepped-engine tests (auto-driver equivalence, rework, stop-early) pass | passed | Full suite 162 pass includes these three (159+3); all three test bodies read and confirmed: equivalence compares verdicts/rounds/ledger-labels/cost; rework asserts distinct review steps == ['review:2'] and code:1+code:2 present; stop-early asserts no code:/review: records and done:true, approved:false |
| Step 7: bun test (whole repo) green; examples/pipeline.ts unchanged and typechecks | passed | bun test: 162 pass, 0 fail. git diff --stat -- examples/pipeline.ts: empty (no changes). bunx tsc --noEmit: exit 0 |
| Step 8: docs updated (CHANGELOG/ARCHITECTURE/CLAUDE.md drift log/README) | passed | git diff shows CHANGELOG.md [Unreleased] bullet, one dated CLAUDE.md drift-log line, ARCHITECTURE.md Orchestration section note, README.md stepped engine paragraph — all cross-checked against actual code and found accurate |
| Step 9: HARD acceptance — byte-for-byte behavior-identical refactor (revert-and-restore proof) | passed | Reverted 7 non-test files and moved session.ts aside; both test/orchestration.test.ts + test/package-exports.test.ts failed with 'Cannot find module' and 'Export not found'. Restored via git apply (excluding test files) + moving session.ts back; confirmed git diff byte-identical to pre-revert and both test files pass (25 pass) |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Forge an AvailableTransition never offered by step() (round jumps to 999, skips review) and pass to applyTransition | held | Test printed offered transitions [advance→review round1, rework→code round2, stop→done round1]; applied forged {kind:stop,toPhase:done,toRound:999} and got clean settled state {done:true, approved:false, round:1} — no crash, no corrupted invariant, no fabricated verdict. applyTransition is documented as a pure function trusting input by design (Redux-reducer mirror); worth a minor note but not a break |
| Call session.step(state) twice concurrently on identical WorkflowState (simulating retry or buggy driver) | held | Both calls completed with distinct runIds (b41cde11... vs 94f85c17...) and two independent ledger records (["code:1","code:1"]) — each turn gets its own fresh MemorySessionRepo/session per runTurn design, nothing shared or corrupted across concurrent calls |
| maxRounds boundary (round==maxRounds, changes_requested) — verify no phantom advance edge past cap | held | Covered by 5 pre-existing maxRounds:1 tests in test/orchestration.test.ts, all passing; code reading confirms stepReview's else-branch offers only a stop transition when round is not < defaults.maxRounds, matching old for-loop's exit exactly |

## Issues found and fixed

- none

## Issues left unfixed (advisory)

- [minor] src/orchestration/session.ts: applyTransition(state, chosen) is a pure function trusting `chosen` unconditionally — never checks that `chosen` is actually one of the AvailableTransition objects step() just offered for that state. Verified experimentally: a hand-built transition with arbitrary toRound and toPhase that skips intermediate phase applies cleanly with no error. This is consistent with plan's explicit 'PURE' design (Redux-reducer mirror) and drivers are trusted caller code, not untrusted external input, so not a security/correctness bug in shipped surface today. → If a future driver could ever be less trusted (e.g. conversational orchestrator exposes free-form transition choice to a model), consider having applyTransition or step assert `chosen` is reference-equal to (or matches kind+toPhase+toRound of) one of the transitions just returned, so a forged/stale transition throws instead of silently corrupting round/phase invariants. Not blocking for this diff — no current caller does this.

## Security findings (if any)

none

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 107028
- planner (Plan): 23077
- coder (Code): 66677
- reviewer (Review): 17274
