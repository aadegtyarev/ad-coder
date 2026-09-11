# Implement session generation-call and cost-threshold plan

**Date:** 2026-09-12
**Verdict:** CHANGES REQUESTED — NOT APPROVED (max fix iterations reached)
**Why this wasn't approved:** Required invalid-settled-usage poisoning and harness-visible retry/deferred coverage remain open; runtime verification and revert/restore proof were blocked because Bun is unavailable.
**Complexity:** complex
**Security surface:** elevated
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| User-configurable numeric limits default to `0`, where `0` disables | passed | Coder changed configuration and session-limit wiring; static typecheck and Biome checks passed |
| One turn is one admitted model-generation call at the `Models` boundary | passed | Coder changed `src/conversation/conversation.ts` and added `src/session-limits.ts`; reviewer did not identify a boundary-counting defect |
| Shared enforcement covers programmatic and console paths | passed | Coder changed conversation, runner, orchestration, and CLI-related tests; reviewer summary records the implementation as present |
| Rejection without usage fails closed and blocks retries | not proven | Reviewer found no harness-visible retry/deferred test and no proof for all required failure paths |
| Invalid settled usage poisons enabled cost accounting | not proven | Reviewer searched `test/session-limits.test.ts` and found no invalid-settled-usage or `cost_unknown` test |
| Typecheck and formatting/lint | passed | `node_modules/.bin/tsc --noEmit` and Biome check passed |
| Runtime suite and required quality command | not run | Bun unavailable (exit 127); scoped tests, full suite, and `bun run check` could not start |
| Diff hygiene | passed | `git diff --check` passed |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Invalid settled usage values bypass the positive cost limit | not proven | Reviewer reports no test for invalid usage poisoning |
| Admitted provider failure followed by harness retry | not proven | Reviewer reports no harness-visible retry test proving the second attempt does not dispatch |
| Deferred failure/retry bypasses accounting | not proven | Reviewer reports required deferred behavior coverage is incomplete |
| Concurrent cost admissions bypass the cap | addressed in implementation | Coder implemented the shared session limiter; runtime proof was unavailable because Bun could not start |

## Issues still open

- [major] `test/session-limits.test.ts`: add faux-provider tests for settled AssistantMessages with invalid `usage.cost.total`, proving the enabled controller becomes terminal and rejects later dispatches.
- [major] `test/session-limits.test.ts` and harness tests: add failed/deferred admitted-call retry coverage proving a subsequent attempt does not dispatch after usage is unavailable; Bun runtime verification and revert/restore proof also remain blocked while Bun is unavailable.
- [contract candidate] Provider-error usage extraction should have one authoritative adapter path if supported by pi-ai error shapes; no corresponding rule exists under `docs/contracts/`, and `/ldo-contract` is the path to make it a contract (suggested file: `scope.md`).

## Issues closed along the way

- [high] Admitted generation failures without trusted usage now have a planned fail-closed terminal accounting mitigation and typed safe rejection behavior.

## Cost

Cost was not measured. Total: not measured.

- Planner: not measured
- Security reviewer: not measured
- Coder: not measured
- Reviewer: not measured
- Recorder: not measured
