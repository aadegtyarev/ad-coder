# Conversation intake audit: orchestrator guarantee `orchestrator.md:13-17` (g2b, conversation intake)
Audit base: c4d378c4690aac65e49bda9c318f083863f32c71, date 2026-09-24.
Rule text: "- Intake states the outcome, scope exclusions, mode, measured task shape,
  budget, ceilings, and any ambiguity that changes the result." (docs/contracts/orchestrator.md:13-17)

## Rule
`docs/contracts/orchestrator.md:13` — "Intake states the outcome, scope exclusions, mode,
measured task shape ... budget, ceilings, and any ambiguity that changes the result."
`docs/contracts/orchestrator.md:22` — "Before work starts, the budget is accepted,
counter-estimated with evidence, or honestly left blocked for a decision. It never
proceeds with an unknown budget by implication." The shape contracts are implemented in
`src/orchestration/intake.ts:57-90` (`IntakeStatement`, `BudgetDecisionKind`).

## Verdict
violating — on the conversation intake surface. `run_pipeline` and `start_pipeline` are
gated (`orchestrator.ts:1539`, `:1596`); the conversational start paths are not.

## Evidence read
- `src/orchestration/orchestrator.ts:1317-1335` — `run_role` tool schema accepts only
  `role`, `task`, optional `complexity`. No intake fields, no budget field.
- `src/orchestration/orchestrator.ts:2070-2077, 2165` — the run_role handler resolves the
  delegate and calls `conversation.step(task, ...)` directly through
  `buildRunRoleTool(async ...)`. No `gatedIntake`, no `recordIntake` call anywhere on this
  path (grep: `gatedIntake(` appears only at `:1539` and `:1596`). VIOLATION of
  `orchestrator.md:22` (budget decision before work starts) and of `:13` (intake fields):
  a delegated turn starts provider work with no intake statement and no budget decision
  on record. The only post-turn statement is `${role} complete (cost ...)` at `:1350-1353`.
- `src/orchestration/orchestrator.ts:1748-1790` — `run_step` begins a stepping run via
  `core.beginStepping(task)` (`:1769`) with the same ungated start. Same violation.
- Direct edits: the orchestrator's own conversation gets the builtin
  `bash/read/write/edit` set (`src/runner/builtin-tools.ts:271-275`, wired via
  `src/conversation/conversation.ts:373-378`). Those edits bypasses both budgets unless
  the trivial-edit guard is installed (`orchestrator.ts:2362-2373`); the code itself
  concedes it at `orchestrator.ts:2030-2032`: "The orchestrator-only collapse (#386)
  edits directly -- no guard, no bound, no record." VIOLATION of `orchestrator.md:22`,
  with no intake statement for the task whose files are being edited (`:13`).
- What the operator is told: on all three paths, nothing before work starts. After the
  run_role turn only cost (`:1350-1353`); on a direct edit only trivial-edit-guard
  entries, only when the guard is installed, and its entries record edit coverage, not
  intake (grep `orchestrator.ts` for `intake`: comments at `:437-443`, `:851-859`,
  and the two gated tools only).
- Counter-estimated case: `src/orchestration/counter-estimate.ts:93-95` fills `outcome`
  with the placeholder "run the stated task under the counter-estimated whole-task
  budget recorded at the pre-work gate". Present and schema-valid, but the rule defines
  the intake outcome as "the intended end state of the task's work on the target
  project" (`orchestrator.md:15-17`); a task-agnostic gate restatement is a hole in the
  field's meaning, not conformance. Same for `mode: "auto"` (`:96`) and
  `resultChangingAmbiguities: []` (`:108-109`). Note this statement is only ever
  produced by the gated `run_pipeline`/`start_pipeline` branch
  (`orchestrator.ts:1467-1471`) — it never reaches the ungated paths above.
- Contrast (conforming half): `orchestrator.ts:1504` / `:1578-1579` tool descriptions and
  `gatedIntake` at `:1453-1480` implement all three branches with refusal codes.

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `c4d378c4690aac65e49bda9c318f083863f32c71` |
| `bun test test/intake-budget.test.ts` | 6 pass, 0 fail, 53 expect() calls, exit 0 (711ms) |
| `bun test test/orchestrator.test.ts` | 76 pass, 0 fail, 445 expect() calls, exit 0 (5.95s) |
| `grep -n run_role test/orchestrator.test.ts` | 9 hits (delegation/error/advisory tests, e.g. :456, :552); none covers intake or budget on the delegated path |

Tests pass because the gates live in the two gated tools only; `test/intake-budget.test.ts`
exercises `run_pipeline`/`start_pipeline` exclusively, so the ungated `run_role` /
`run_step` / direct-edit paths are untested for intake, not proven.

## Unverified
- Which embedding/CLI hosts call `startOrchestrator.step()` with tasks that then reach
  `run_role` or direct edits in production (grep only; no run of `ad-coder` CLI).
- Background-run executor intake (`core.backgroundRuns.startDetached`, `:1597`) beyond
  the gate at `:1596`.
- Whether a later `report_status`/ledger row carries an ingestible outcome for the
  delegated turn (not read).

## Next safe step
Fix: route the delegated `run_role` turn, the `run_step` start, and the orchestrator's
own edit-bearing session through the same `gatedIntake` seam (`orchestrator.ts:1453`) —
an intake statement + budget decision recorded before `conversation.step(task)` at
`:2165`, and the counter-estimate `outcome` placeholder replaced with the task's stated
end state. This changes WHEN work may start (ungated conversational starts would begin
refusing or blocking), so the operator decides before code is written.
