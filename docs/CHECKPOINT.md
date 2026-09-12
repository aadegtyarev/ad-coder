# Checkpoint

## 2026-09-12 — Project operations Increment 3

Structured FollowUps, safe documentation proposals, and selectable backlog
authorities are implemented. FollowUps preserve deterministic producer/run/branch
provenance. File backlog state uses the merged ProjectStore; GitHub issue access
uses an injected argv executor, stdin payloads, unconditional metadata-only persistence,
a read-only capability probe, required shared claim coordination, and one-time
migration advice. File mode is the default and no backend falls back to another.
Expired finite leases revoke holder operations; only a fresh claim can recover
them. The `operations` command exposes every subsystem capability as JSON.

The local gate passed: 247 Bun tests (1,221 assertions), `tsc --noEmit`, Biome,
and `git diff --check`. Next: Increment 4, RunCoordinator closeout. LDO import
and repository publishing remain later increments.
