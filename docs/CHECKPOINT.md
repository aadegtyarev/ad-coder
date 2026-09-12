# Checkpoint

## 2026-09-12 — Project operations Increment 4

The non-model RunCoordinator now owns workflow progress and closeout for direct
pipelines, custom driving, and conversational orchestration. Each role turn gets
a fresh structured FollowUp capture when its tool policy permits it; provenance
is engine-authored and all rounds aggregate deterministically. Versioned
ProjectStore checkpoints retain workflow/pending-step progress, completed stable
effects, unresolved decisions, contract re-reviews, and terminal closeout, with
CAS rejection for stale writers and resume from the first incomplete phase.

Notes and authorized design-document drift use fixed metadata-only blocks and
stable markers; file backlog retries use deterministic IDs. Contract and
ambiguous product choices persist for an operator-only decision. Accepted exact
one-line contract rules are appended once and re-review the unchanged current
implementation before closeout. Numeric coordinator limits default to `0`, which
disables them. Trusted target-local prompt overrides remain automatic,
byte-verbatim, and unrestricted; no sandbox or permission cage was introduced.

Verification: 260 Bun tests (1,285 assertions), TypeScript, Biome, and
`git diff --check` pass. Next:
non-destructive LDO import/operator commands. Repository publishing policy and
distributed GitHub claim coordination remain deferred.
