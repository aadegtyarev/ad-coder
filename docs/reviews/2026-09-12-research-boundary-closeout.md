# Research boundary closeout

**Date:** 2026-09-12

The final LDO review correctly rejected the implementation because the durable
research intent still contained the raw outbound query and recovery coverage did
not include a prepared-checkpoint reopen or two competing resume-to-completion
attempts. The post-review closeout removed the query from
`ResearchDispatchIntent`; the dispatch input is now reconstructed from the
checkpointed surface analysis and verified against the persisted hash and
surface IDs before provider use.

Production-flow coverage now proves positive and zero-disabled analysis limits,
strict response rejection and canonical corroboration, mandatory ceilings,
durable artifact secrecy, dispatched recovery, prepared-checkpoint reopen, and
CAS-mediated concurrent exactly-once completion. The two dated governance items
were removed from `docs/BACKLOG.md` only after these checks passed locally in a
writable environment.

Verification:

- `bun test test/orchestration.test.ts`: 42 passed, 0 failed.
- `bun test`: 345 passed, 0 failed.
- `bun run typecheck`: passed.
- `bun run smoke:artifact`: passed with SHA-256 integrity output.
- `git diff --check`: passed.
- `bun run check`: rerun after formatting correction as part of final closeout.

No global install, publish, push, tag, release, or merge was performed.
