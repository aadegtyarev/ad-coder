# Revise session turn-count and cost-limit feature plan

**Date:** 2026-09-12
**Verdict:** APPROVED
**Complexity:** complex
**Security surface:** elevated
**Coder passes:** 0 (plan-only run)

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Numeric user-configurable limits are optional, default to `0`, and use `0` as disabled | passed | Plan requires the configuration contract update and applies the rule to session turn-count and cost limits, with context-window enforcement and summarization percentage explicitly excepted |
| Turn counting is defined at the headless `Models` boundary | passed | Plan defines one turn as one admitted model-generation call through `stream`, `complete`, `streamSimple`, `completeSimple`, `streamDeferred`, or `fetchDeferred`, including tool follow-ups |
| Programmatic and console overrides share authoritative enforcement | passed | Plan adds a shared headless limiter/controller and keeps console behavior as a thin override front |
| Cost semantics are exact and concurrency-safe | passed | Plan reserves concurrent cost before dispatch, uses trusted provider `usage.cost.total`, documents one-request pre-check overshoot, and fails closed on unknown accounting |
| Tests and documentation are included without changing the headless-core/thin-front boundary | passed | Plan includes primitive, Models-adapter, conversation, console, concurrency, rejection, and docs/contract tests; review found the architecture preserved |
| Baseline test suite | not run | `bun` unavailable (exit 127); command was `bun test test/context.test.ts test/conversation.test.ts test/orchestrator.test.ts test/cli-console.test.ts test/cli.test.ts test/package-exports.test.ts` |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Concurrent admissions bypass the cost cap | addressed in plan | Shared controller reserves in-flight cost before dispatch and rejects later admissions when the reservation would exceed the positive limit |
| Provider retries after an admitted rejection with no usage | addressed in plan | Security mitigation marks cost accounting terminally unknown and rejects every later admission with a safe typed `SessionLimitError`; trusted usage on an error is accounted for |
| Tool follow-ups evade turn limits | addressed in plan | The `Models` boundary definition explicitly includes tool follow-up generations |
| Deliberate one-request cost overshoot is mistaken for an absolute spend cap | documented | Plan defines a pre-request threshold and records the deliberate overshoot semantics; provider-internal retries remain outside harness visibility |

## Issues found and fixed

- [high] session cost accounting: an admitted generation that rejects without a settled usage-bearing message could be released without cost or a terminal state → plan now requires fail-closed terminal unknown accounting and retry-blocking tests.

## Cost

Cost was not measured. Total: not measured.

- Planner: not measured
- Security reviewer: not measured
- Reviewer: not measured
- Coder: not measured (not run; plan-only)
