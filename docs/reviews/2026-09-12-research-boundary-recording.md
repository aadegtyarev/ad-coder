# Research boundary and recovery closeout

**Date:** 2026-09-12
**Verdict:** CHANGES REQUESTED — NOT APPROVED (max fix iterations reached)
**Complexity:** complex
**Security surface:** elevated
**Coder passes:** 1

**Why this wasn't approved:** Durable research still persists raw provider responses, and required production-flow integration and crash/resume boundary tests remain unproven.

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Surface-analysis limits propagate through production configuration with 0=disabled | not proven | Reviewer found only direct parser coverage; production propagation was not established |
| Research response is normalized before durable persistence | failed | `src/orchestration/session.ts`: `runWorkflowTurn` persists the raw Researcher transcript before `parseResearchResult` |
| Required research integration and recovery coverage | failed | Reviewer found no coverage for malformed/unknown responses, corroboration failure, ceilings, ambiguous dispatch, crash, or concurrent resume boundaries |
| Typecheck, lint, and diff whitespace | passed | Coder reported `bun run typecheck`, `bun run check`, and `git diff --check` passed |
| Scoped/full tests and artifact smoke | not proven | Reviewer reported the read-only sandbox prevented fixture writes to `/tmp` |

## Issues still open

- [critical] `src/orchestration/session.ts`: raw research provider responses are persisted before normalization, violating the security contract and potentially retaining secrets.
- [major] `test/orchestration.test.ts`: add production-flow integration tests for configuration propagation, bounded response validation, corroboration, ceilings, resumable dispatch, crash windows, and concurrent resume.
- [major] `src/orchestration/types.ts`, `src/project-operations/run-coordinator.ts`: raw `ResearchDispatchIntent.query` is duplicated into durable workflow state/effect intent; persist only normalized identifiers/hash and reconstruct retry input deterministically.

## Issues closed along the way

- [verified by coder] Typecheck, Biome checks, and whitespace validation passed.

## Cost

not measured
