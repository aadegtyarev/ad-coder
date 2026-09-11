# Submit verdict tool rewire (filesystem artifact to tool call)

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Step 1 (types.ts): error codes unchanged, JSDoc updated | passed | tsc --noEmit clean; OrchestrationErrorCode union unchanged (missing_verdict/malformed_verdict/invalid_max_rounds/empty_task); JSDoc rewritten to describe tool-call submission not filesystem artifact |
| Step 2 (verdict.ts): fs/path removed, new exports present, parseVerdict still validates | passed | git diff shows fs/path imports removed, VERDICT_BASE_DIR/verdictArtifactPath/readVerdict gone; SUBMIT_VERDICT_TOOL_NAME/VerdictCapture/buildSubmitVerdictTool exported; parseVerdict unit test passes on bad status → OrchestrationError('malformed_verdict') |
| Step 3 (pipeline.ts): verdict flow rewired to tool call with proper error handling | passed | bun test test/orchestration.test.ts: all 6 scenarios green (1-round approve; 2-round changes→approve with round-1 issue threaded to coder round-2; maxRounds exhausted → approved:false un-thrown; no tool call → missing_verdict; malformed submission → malformed_verdict; MemoryLedgerSink shows distinct role/step per round); tsc --noEmit clean |
| Step 4/5: barrel + package-exports exports/asserts new names | passed | bun test test/package-exports.test.ts passes; buildSubmitVerdictTool asserted as function, SUBMIT_VERDICT_TOOL_NAME as string, VerdictCapture as type |
| Step 6: orchestration.test.ts covers all scenarios, no file written to .ad-coder/verdict/ | passed | bun test: 93 pass, 0 fail, 412 expect() calls across 11 files; grep confirms no file under .ad-coder/verdict/ post-change (scheme fully retired) |
| Step 7: docs (README/ARCHITECTURE/ROADMAP/CLAUDE.md) updated consistently | passed | Full diff review: README tool example and verdict paragraph rewritten to describe submit_verdict tool call; ARCHITECTURE runner/orchestration/filesystem-bus paragraphs updated; ROADMAP marks submit_verdict DONE and notes submit_plan/rate_complexity as next follow-on; CLAUDE.md drift log line added |
| Tests catch the defect (not decorative) | passed | Revert-and-restore proof: reverted src/orchestration/*.ts + src/index.ts while keeping new tests → test/orchestration.test.ts fails with module-resolution error (SUBMIT_VERDICT_TOOL_NAME not found); restored via git apply → 93/93 green, diff byte-identical to original |
| TypeBox schema permissive at enum leaves (pi-agent-core fact #1: pre-execute validation) | passed | schema is Type.String() for status/severity (not Union-of-Literal), so malformed values pass schema but are caught by parseVerdict's strict validation inside execute's try/catch, held in capture.error, and re-thrown by pipeline |
| Execute throw handling (pi-agent-core fact #2: swallowed throws) | passed | execute wraps parseVerdict in try/catch, recording OrchestrationError to capture.error rather than throwing; pipeline reads capture after turn and re-throws if present; confirmed with ad-hoc malformed-then-valid double-call test |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| submit_verdict called with structurally-required 'summary' field omitted | held | Pre-execute TypeBox validation rejects (field presence is strict), capture holder stays empty, pipeline throws OrchestrationError('missing_verdict') — scope correct: permissive only at enum leaves, not field presence |
| submit_verdict called twice in one round: first malformed (status:'bogus'), then valid approved | held | Result: {approved:true, ...} — second call's execute cleared capture.error, set capture.verdict; last-wins correctly recovers from earlier malformed call in same round |
| submit_verdict called twice in one round: first valid approved, then malformed (status:'bogus') | held | console: 'result code: malformed_verdict' — second call's caught OrchestrationError overwrote earlier valid capture; last-wins makes final call authoritative in both directions |
| Reviewer role omits 'submit_verdict' from activeToolNames (tool registered but filtered by role.ts gate) | held | console: 'result code: missing_verdict', instanceof OrchestrationError true — run fails loud with documented error code (plan's own flagged, accepted exposure-coupling risk), no crash/hang |

## Issues found and fixed

None — all implementation details specified in the plan were executed as designed. The two verified pi-agent-core facts (pre-execute schema validation and swallowed execute throws) drove the design's reconciliation points (permissive schema + capture-holder bridge), and both are correctly implemented.

## Issues left unfixed (advisory)

None.

## Security findings

None.

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 57706
- coder (Code): 37387
- reviewer (Review): 20319
