# Checkpoint

## 2026-09-12 — Project operations Increment 2

ProjectStore and durable sessions are implemented. Runtime state lives under the
target project's ignored `.ad-coder/` tree; session lifecycle, attachments,
versioned state, cleanup, leases, containment and configurable byte limits are
available through the package API. Pipeline and standalone CLI role execution
carry one `projectStoreConfig`; CLI users may load it with
`--project-store-config <file.json>`.

Verified locally with 238 passing Bun tests (1,128 assertions), `tsc --noEmit`,
Biome, and `git diff --check`. Next: Increment 3, the structured FollowUp union,
documentation validation, and file/GitHub backlog lifecycle with claims.
