# Checkpoint

## 2026-09-12 — Project operations Increment 6

Repository publishing now has a headless core and registry-derived JSON
preflight/start/finish operations. Remote HEAD then configured main/master
candidates select an exact base OID. Publishing creates a feature branch,
constructs commits from explicit paths in an isolated index, runs the selected
local/CI/combined/manual gate, pushes an explicit refspec, creates a structured
PR through stdin, and squash-merges only the checked head. Multi-developer mode
requires server-enforced approval by another developer on that exact commit.

Local repositories use a controlled single-parent squash update without
checking out base. Protected-base operations, initially dirty paths without
individual authorization, moving bases, empty/pending CI, and changed PR heads
fail closed. User files remain untouched, HEAD stays on the feature branch, and
results include recovery guidance. All policy choices are configurable; local
tests are default and numeric limits default to `0` disabled. Trusted project
prompt overrides and the no-sandbox/no-permission-cage stance are unchanged.

Verification: focused publishing/CLI/export coverage passed 48 tests with 561 assertions; the full suite passed 278 tests with 1,426 assertions across 23 files, including a linked-worktree publishing lifecycle. `bun run
typecheck`, `bun run check`, and `git diff --check` passed using the cached Bun
executable through `npm exec --offline -- bun`.

## 2026-09-12 — Project operations Increment 5

Existing LDO projects are adopted without migration. Headless and JSON CLI
operations detect and preview the existing layout without writes; imports retain
exact source bytes as immutable digest revisions with a versioned manifest,
observed/claimed provenance, and optional explicit digest trust. Source LDO
artifacts and project documentation are never overwritten. Unsafe filesystem
objects, traversal, malformed/unsupported version-1 data, and enabled numeric
limits fail before persistence; all numeric limits default to `0` disabled.
Artifact enumeration and reads stay anchored to a verified open LDO directory
descriptor, so an ancestor-path replacement cannot redirect an accepted read.

Inspection reports source status and the first incomplete phase. Trusted,
unchanged interrupted work is narrowly translated into native WorkflowState and
continued by RunCoordinator under a stable digest checkpoint; terminal work does
not rerun effects. A completed import is terminal only when its final supported
review is approved and the run's approved state agrees. Imported text requires explicit trust bound to its exact digest before resume. Trusted prompt
overrides and the no-sandbox/no-permission-cage MVP stance are unchanged.

Verification: 269 Bun tests (1,357 assertions), including focused CLI, ProjectStore,
package-export, malformed-envelope, import and resume coverage; TypeScript, Biome, and
`git diff --check` pass. Repository publishing policy is the next separate task.

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
