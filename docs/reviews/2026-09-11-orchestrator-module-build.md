# Build the ORCHESTRATOR module (ad-coder critical-path step 5)

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** complex
**Security surface:** elevated
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Headless core reachable without chat front | passed | `test/orchestrator.test.ts`: capability reachable without chat front test passes; `createOrchestrator().runPipeline` drives a scripted plan/code/review scenario to a verdict (result.approved===true, rounds===1, perStep phases: plan, code, review). Zero startConversation/tool involvement. |
| Unoffered transition rejected at core layer | passed | `test/orchestrator.test.ts`: core-layer test passes; `chooseTransition` with an unoffered kind (including SQL-injection and path-traversal-shaped strings) throws DriveError('transition_not_offered') carrying only the kind, never fabricated toPhase/toRound. Verified by ad-hoc script testing the rejection with garbage/injection-style kind strings. |
| Unoffered transition rejected at tool layer | passed | `test/orchestrator.test.ts`: tool-layer test passes; `choose_transition` tool with an unoffered kind returns safe error text 'error: transition_not_offered (...)' with no execution. |
| Per-step costs sum to totalCost | passed | `test/orchestrator.test.ts`: showCost test passes; totalCost equals sum of perStep costs in the core-only scenario (the test only covers this case; see minor issue below for conversational-front scenario divergence). |
| Transition guard relocated, re-exported byte-for-byte | passed | grep shows no definition of assertTransitionOffered/DriveError in src/cli/drive.ts (only import + re-export); `bun test test/cli-drive.test.ts` passes unchanged; src/index.ts re-export resolves existing importers without edit. |
| All new exports pinned in package-exports.test.ts | passed | `bun test test/package-exports.test.ts` passes; type-only import block extended with every new type (Orchestrator, OrchestratorDeps, OrchestratorConfig, RunPipelineResult, StepView, CostReport, OrchestratorError); value assertions added for createOrchestrator, buildOrchestratorTools, startOrchestrator. |
| Full test suite green | passed | `bun test` (all 186 tests): 186 pass, 0 fail. Matches Coder's claimed baseline+new. |
| Biome (format + lint) clean | passed | `bun run check` produces zero errors; no formatting or linting violations. |
| TypeScript clean | passed | `bun run typecheck` (tsc --noEmit) produces zero errors; no type violations. |
| Revert-and-restore proof | passed | Reverted src/orchestration/orchestrator.ts, transition-guard.ts, src/index.ts, src/cli/drive.ts (kept test/orchestrator.test.ts and test/package-exports.test.ts untouched) -> `bun test test/orchestrator.test.ts && bun test test/package-exports.test.ts` failed red with "Cannot find module" and "Export named ... not found" -> Restored byte-for-byte (diff-confirmed identical to pre-revert) -> Same commands passed green (10 test pass, 0 fail + package-exports tests pass). Proves the new code is genuinely exercised and tests fail without it. |
| Docs updated accurately | passed | ARCHITECTURE.md: third-driver split and guard relocation documented; ROADMAP.md: core delivered marked with named follow-ons and workflow-execution-model requirements added; AGENTS.md: workflow-vs-pipeline taxonomy recorded; CLAUDE.md: drift-log line appended. All claims cross-checked against actual code. |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| choose_transition with garbage/injection-shaped kind string | held | Tool executed `execute()` and returned safe error text 'error: transition_not_offered (...)' — no execution, no crash, no path/stack leakage. Tested with SQL-injection-shaped ('DROP TABLE') and path-traversal-shaped ('../../etc/passwd') kind strings. |
| run_step called with a different task mid-stepping run (task injection) | held | Second call's task was silently ignored; core.isStepping() returned true so beginStepping was skipped, run continued to the code phase rather than restarting on the injected task. Stepping run remained locked to its original task. |
| chooseTransition called with no pending step (call-order misuse) | held | Threw OrchestratorError with code 'no_pending_transition'. Caught and asserted in ad-hoc test — no crash, error is typed and handled safely. |
| run_step after run settles without submit_verdict (underlying OrchestrationError) | held | run_step tool returned 'error: missing_verdict (<runId>)' with no stack trace, absolute path, or ledger content exposure. Tool's catch-all projected only error code+detail. |
| Transition kind resolved off model input without fabrication | held | chooseTransition receives only a KIND string from the model; it resolves that kind via `find()` against the engine-authored AvailableTransition[] (by kind property match), throws DriveError if not found (kind only, never fabricated toPhase/toRound), and only then asserts the resolved transition. Core enforces the invariant; tool layer mirrors it. Never trusts model toPhase/toRound directly. |

## Issues found and fixed

- [high] `src/orchestration/orchestrator.ts` (input_validation): The model authors only a transition KIND, but a naive implementation could accept model-supplied toPhase/toRound directly via applyTransition. This would allow a model to jump the run to any phase including 'done', settling it and deriving `approved` from the last verdict WITHOUT re-checking state. → **FIXED:** In `chooseTransition`, resolve kind via `transitions.find(t => t.kind === kind)`; if undefined, throw `DriveError('transition_not_offered', kind)` immediately (do not fabricate toPhase/toRound). Only then call `assertTransitionOffered(resolved, offered)` and `applyTransition(state, resolved)`. Tool schema exposes ONLY {kind, rationale?} — never toPhase/toRound. Covered by mandatory unoffered-transition-rejected tests at both core and tool layer.

## Issues left unfixed (advisory)

- [minor] `src/orchestration/orchestrator.ts`: CostReport.totalCost sums every ledger record on the shared MemoryLedgerSink, while CostReport.perStep only reflects steps run through runPipeline/stepOnce. In a real startOrchestrator conversation (where non-step chat turns also share the same sink), totalCost will exceed the sum of perStep once the orchestrator model has any back-and-forth turns of its own. The test covering the perStep/totalCost relationship (showCost perStep sums to totalCost) only exercises the core in isolation with no startConversation turns, so it cannot catch this divergence. The JSDoc correctly documents that totalCost sums every record, but one additional sentence making explicit that it can exceed perStep's sum in a multi-turn conversational scenario would clarify the design. No behavioral bug — this is documentation clarity only; the distinction is already in the JSDoc but worth one line to foreground it.

## Security findings

1. [high] input_validation: The model authors only a transition KIND, but applyTransition (session.ts:390) commits chosen.toPhase/toRound verbatim — including a jump to phase 'done', which settles the run and derives `approved` from the last verdict WITHOUT re-checking state. chooseTransition must resolve the model-supplied kind by find-by-kind against the exact stored offered AvailableTransition[] (whose toPhase/toRound are engine-authored) and pass it through assertTransitionOffered; it must NEVER fabricate or accept a model-supplied toPhase/toRound. A kind not present in the offered set must throw DriveError('transition_not_offered') carrying only the kind. → **CONFIRMED FIXED:** In chooseTransition, resolve kind via transitions.find(t => t.kind === kind); if undefined, throw DriveError('transition_not_offered', kind) immediately. Only then call assertTransitionOffered(resolved, offered) and applyTransition(state, resolved). Keep the tool schema exposing ONLY {kind, rationale?} — never toPhase/toRound. Covered by the mandatory unoffered-transition-rejected tests.

2. [low] data_exposure: The tool handlers marshal core results/errors into text returned to the model and captured in the conversation transcript/ledger. buildConfig (resolvePipelineConfig) can throw RegistryError('missing_credential', <VAR-NAME>), and core methods throw DriveError/OrchestrationError. A naive `catch (e) { return String(e) }` would surface raw Error messages and stack traces (which can carry absolute paths) rather than safe code+detail tokens. → **CONFIRMED FIXED:** In each handler, caught typed errors are projected ONLY via their safe fields (error.code, error.detail) into returned text — mirrors the DriveError/OrchestrationError house style. Never return String(error) or error.stack. StepView/CostReport limited to phase/runId/cost and offered transition kinds (no raw LedgerRecord[], no full OperationResultRecord), matching the ConversationTurnResult narrowing. Tested: `choose_transition` with garbage kind returned 'error: transition_not_offered (...)' with no stack or path.

3. [low] config: run_pipeline lets the orchestrator MODEL trigger a full autonomous pipeline whose coder holds bash/write/edit rooted at targetDir, using a model-authored `task` string. This is the intended capability, but the trust boundary depends on (a) targetDir being fixed by the operator's startOrchestrator config and closed over by buildConfig — NOT a tool parameter — and (b) `task` being threaded as prompt DATA via PipelineConfig.task with no shell/path/URL interpolation. → **CONFIRMED:** Keep the tool schemas exposing only {task} / {task?} / {kind, rationale?} / {} — no targetDir, no path, no registry/provider override. buildConfig closes over the operator-supplied targetDir and only accepts task. Thread task solely via PipelineConfig.task (as session.ts already does for planner/coder prompts); never interpolate into shell/path/URL. Credentials resolve only through resolvePipelineConfig's injected env accessor (default process.env), never targetDir/.env. Documented that run_pipeline is code-execution-capable within targetDir (a starting cwd, not a sandbox).

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 270669
- planner (Plan): 51796
- security (Security): 25741
- coder (Code): 119446
- reviewer (Review): 73686
