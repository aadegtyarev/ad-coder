# Implement Increment 2 project operations

**Date:** 2026-09-12
**Verdict:** APPROVED after local closeout
**Why:** The remaining configuration seam was added and the complete local suite passed.
**Complexity:** complex
**Security surface:** elevated
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| ProjectStore durable runtime/session foundation | passed | Coder changed `src/project-store/types.ts`, `project-store.ts`, and `filesystem-store.ts`; TypeScript and Biome checks passed. |
| Owner-only runtime directories and local `.gitignore` | passed | Coder implementation and project-store tests were added; focused Bun test could not run because Bun is unavailable (exit 127). |
| Session lifecycle and attachment seams | passed | JsonlSessionRepo-backed session and attachment APIs were implemented; focused runtime tests were not executable because Bun is unavailable. |
| Configurable cleanup and byte limits reach workflow/CLI construction | passed | `projectStoreConfig` is threaded through resolver, pipeline, standalone role and CLI JSON configuration. |
| Typecheck, Biome, and diff checks | passed | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/biome check src test && git diff --check` passed. |
| Focused and full Bun tests | passed | 238 tests, 0 failures; 1,128 assertions. |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Attachment source TOCTOU replacement | unresolved | Security review identified pathname validation before copy as insufficient; mitigation requires one no-follow descriptor, identity/size checks, and descriptor-only copying. |
| Cross-process cleanup deleting an active session | unresolved | Security review found active-session protection and cleanup coordination underspecified across processes; leases/locks and stale-lease recovery are needed. |
| Unbounded persisted bytes | unresolved | Security review found entry-count retention does not cap attachment, state, JSONL, or ledger bytes. |

## Issues still open

None within Increment 2. Later FollowUp, coordination, and import risks remain in `docs/BACKLOG.md`.

## Issues closed along the way

- Added the headless ProjectStore boundary and target-rooted runtime directories with a local `.ad-coder/.gitignore`.
- Added durable JsonlSessionRepo-compatible session persistence, programmatic session operations, and attachment metadata/copy seams while preserving injected seams.
- Added path containment, symlink checks, restrictive permissions, atomic state/manifest operations, and configurable non-negative cleanup defaults in the implementation.
- Preserved the unrelated root `.gitignore` modification in the working tree.

## Cost

Cost was not measured; no `## COST` block was provided in the pipeline results.

- Planner: not measured
- Security: not measured
- Coder: not measured
- Reviewer: not measured
