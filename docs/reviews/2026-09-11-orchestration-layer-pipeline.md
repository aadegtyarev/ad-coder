# Implement Orchestration Layer for ad-coder

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** complex
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| tsc --noEmit passes under exactOptionalPropertyTypes/verbatimModuleSyntax | passed | `npx tsc --noEmit` produced no output (clean exit) |
| parseVerdict/readVerdict strict validator behavior | passed | test/orchestration.test.ts unit tests pass: well-formed verdict accepted; bad status, non-array issues, missing what, bad severity, non-string summary, non-object all throw OrchestrationError code malformed_verdict; readVerdict on absent file throws missing_verdict. Independently attacked with extra/prototype-polluting fields (silently dropped, no pollution), directory-as-artifact (folds into missing_verdict), 100k-entry issues array (parses in 10ms) |
| runPipeline: sequential-only, planner at most once, loop terminates at approved or maxRounds | passed | `bun test test/orchestration.test.ts test/package-exports.test.ts` -> 10 pass, 0 fail, 74 expect() calls, covering one-round approve (rounds:1), two-round changes→approve with round-1 issue text threaded into round-2 coder prompt, maxRounds exhausted returning approved:false without throwing, shared MemoryLedgerSink showing planner/plan, coder/code:1\|2, reviewer/review:1\|2, missing-verdict throwing OrchestrationError('missing_verdict') |
| Barrel re-export + package-exports assertions | passed | git diff on src/index.ts shows runPipeline/OrchestrationError value exports plus all 9 new type-only exports; test/package-exports.test.ts asserts typeof runPipeline/OrchestrationError === 'function' and references every new type via undefined-typed local, matching file's existing pattern; full suite green |
| Whole pipeline test with fauxProvider, zero network/keys | passed | Same bun test run; fixture() uses fauxProvider/createModels/models.setProvider with no live credentials |
| Docs updated and accurate | passed | git diff shows ARCHITECTURE.md gains Orchestration component paragraph + How-they-connect note naming filesystem verdict-artifact protocol and deferred tool-call follow-up; ROADMAP.md marks rung 2 delivered and records follow-up; README.md adds 'Running a pipeline' subsection with minimal runPipeline example; CLAUDE.md drift log gains one new dated line (2026-09-11) |
| Test genuinely catches claimed defect | passed | Moved src/orchestration/ aside: `bun test test/orchestration.test.ts` failed with 'Cannot find module ../src/orchestration/types' (1 fail/1 error). Restored directory: `bun test test/orchestration.test.ts test/package-exports.test.ts` returned to 10 pass/0 fail. git status confirmed working tree ended exactly as it started |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Verdict JSON with extra unknown fields and __proto__ key (prototype-pollution) fed to parseVerdict | held | parseVerdict({status:'approved',issues:[],summary:'ok',extra:'...',__proto__:{polluted:true}}) returned exactly {status,issues,summary} -- extra/proto fields silently dropped, no pollution, because validator constructs fresh literal object rather than spreading input |
| Invalid maxRounds (1.5 non-integer, -1 negative) and whitespace-only task to runPipeline | held | maxRounds=1.5 → OrchestrationError invalid_max_rounds; maxRounds=-1 → invalid_max_rounds; task='   ' → OrchestrationError empty_task. All thrown before any role ran |
| 100,000-element issues array through parseVerdict (scale) | held | Parsed all 100k issues in 10ms with no error |
| Directory at exact verdict artifact path (readVerdict against fs.readFileSync EISDIR) | held | readVerdict folded EISDIR read failure into OrchestrationError('missing_verdict', <path>) as documented rather than crashing uncaught or misreporting as malformed |
| Path-traversal-shaped runId ('../../../etc/passwd') to verdictArtifactPath | held | path.join collapsed traversal to confined path; more importantly vector is unreachable since verdictArtifactPath never exported from public barrel and pipeline.ts always generates runId via crypto.randomUUID() |

## Issues found and fixed

None.

## Issues left unfixed (advisory)

The submit_verdict tool-call upgrade (decision 1 follow-up) requires touching src/runner/ and is explicitly deferred. Recorded in ROADMAP.md with the deliverable marked complete.

## Security findings

None.

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 81764
- coder (Code): 63841
- reviewer (Review): 17923
