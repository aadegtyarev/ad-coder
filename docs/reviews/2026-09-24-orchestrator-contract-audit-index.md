# Orchestrator contract audit — index

Audit date: 2026-09-24. Audit base: `ff07c9988923aeb4fa0b66106f3574103eb4b4cd`
(`git rev-parse HEAD` of this worktree; every slice re-confirmed it).

The orchestrator contract (`docs/contracts/orchestrator.md`) is audited guarantee by
guarantee against the current code. The nine slices in `docs/reviews/slices/` carry
the executed evidence; this index only relays their verdicts verbatim and does not
audit anything itself. The previous audit (2026-09-21) was removed: it addressed
clauses as "K0-K12" against a 589-line contract that #596 replaced, and marked
wait-service rules absent after the wait service had landed. Each verdict is
scoped to the surfaces its slice examined; read the slice before acting on it.

## Guarantees, in contract order

| Contract line | Guarantee | Verdict | Slice | What is missing (violations only) |
| --- | --- | --- | --- | --- |
| `docs/contracts/orchestrator.md:9` | task states: WIP/blocked/closed, no quietly stopped state | conforming | [g1](slices/orchestrator-g1-task-states.md) | — |
| `docs/contracts/orchestrator.md:13` | intake states outcome, scope exclusions, mode, task shape, budget | violating | [g2](slices/orchestrator-g2-intake.md) | no intake surface states outcome, scope exclusions, budget, or ambiguity |
| `docs/contracts/orchestrator.md:22` | budget accepted / counter-estimated / blocked before work | violating | [g3](slices/orchestrator-g3-budget.md) | no budget gate on any dispatch surface; the one forecast is CLI-report only |
| `docs/contracts/orchestrator.md:31` | advance without operator message or explicitly ask | conforming | [g4](slices/orchestrator-g4-advance-or-ask.md) | — |
| `docs/contracts/orchestrator.md:34` | durable wake delivery; wait names object/condition, finite timeout | conforming | [g5](slices/orchestrator-g5-wake-delivery.md) | — (one clause conflicts with the owning sub-contract — see below) |
| `docs/contracts/orchestrator.md:39` | material decisions, waits, next steps written to the operator session as they occur; wake summary; never premature complete | conforming | [g6](slices/orchestrator-g6-visible-decisions.md) | — |
| `docs/contracts/orchestrator.md:44` | claims cite artefacts; no refusal-as-success; green from step list | conforming | [g7](slices/orchestrator-g7-claims-cite-artifacts.md) | — |
| `docs/contracts/orchestrator.md:47` | closeout reports outcome, evidence, ledger cost across rounds, budget remainder, ceilings | violating | [g8](slices/orchestrator-g8-closeout-report.md) | no "budget remainder" figure; no configured-estimate vs provider-billing distinction |
| `docs/contracts/orchestrator.md:51` | read target project's working conventions before acting; durable decisions in repo docs | violating | [g9](slices/orchestrator-g9-project-conventions.md) | no prompt line or mechanism makes the orchestrator read conventions before acting |

Count: 5 conforming, 4 violating, 0 `contract_missing_evidence`, 0 head-verdict
`unverified` (violating: g2, g3, g8, g9); no slice covered every surface of its guarantee.

## Code that must change

- Intake must state outcome, scope exclusions, budget and ambiguity —
  `src/orchestration/` intake tools (`decompose_task`, `run_pipeline`,
  `start_pipeline`, control-plane `start()`). Slice g2.
- A pre-work budget gate (accept / evidence-backed counter-estimate / block) —
  `src/orchestration/` dispatch tools plus `src/economics/forecast.ts`, whose only
  consumer is the CLI `profile estimate` report (`src/cli.ts:2173`). Slice g3.
- Closeout must report a budget remainder and separate configured estimates from
  provider billing — `src/orchestration/orchestrator.ts` cost tools (`show_cost`,
  `pipelineResult`). Slice g8.
- The orchestrator must read the target project's conventions before acting —
  `prompts/orchestrator.md` and skill wiring (`src/skills/role-kit.ts`,
  `src/orchestration/orchestrator.ts:1721-1737`); g9's proposed fix (`always`
  skill or target-aware prompt injection) is pending operator decision. Slice g9.

## Unverified (residuals the slices name explicitly)

- g1: WIP/blocked/closed exhaustiveness on the `runPipeline`/`WorkflowState`
  surface (`src/orchestration/types.ts:875`); background-run state recording.
- g2: conversation-level intake (`src/conversation/` prompts); CLI drive flows.
- g3: `src/context/budget.ts` token-budget semantics (a reading under which the
  verdict would soften to mixed); full-cycle forecast / lane-reserve code named by
  `task-estimation.md`; cost-anomaly wiring; TUI parity.
- g4: foreground staleness with no pending wake (whether anything wakes such
  stalls); `conversation.step()` not read in full.
- g5: which product component polls sources at runtime; operator-message
  interruption of a live wait mid-poll; visible separation of
  unavailable-condition reports; TUI, machine-API and telegram surfaces.
- g6: wake-summary content quality; the premature-completion ban enforced only by
  prompt + contract (no test); durable writes of non-wake decisions to the session.
- g7: "otherwise they are hypotheses" has no code anchor outside structured claim
  surfaces; `parseVerdict` approval check unread; abort/cancel report surfaces
  (`stop-run.ts`, `run-stop.ts`) unrevised.
- g8: conversation-side close cost reporting; `src/stamp/delivery-signature.ts`
  cost fields; live-provider billing routing.
- g9: clause-2 enforcement (durable decisions to repo documents) beyond prompt
  advice; delegated planner/coder prompts (grep only).

## Not covered by this audit

- Other contracts in `docs/contracts/` — wake-delivery.md, waiting.md,
  work-decomposition.md, task-estimation.md and autonomy.md were read only as
  cross-checks for the orchestrator bullet; none was audited itself.
- The drive-facing CLI surface (`src/cli/drive.ts`) — excluded by g2; telegram
  front, TUI/machine-API wait surfaces, timer-wake delivery and non-wake ordinary
  turns — excluded by g5/g6.- External-facing CI-badging or any CI-reporting surface (g7 found none in-repo).
- Real-provider end-to-end runs (all executed evidence is faux-provider fixtures).

## Cross-slice inconsistency flagged

No two slices contradict each other; each of two slices flags a contradiction
between its guarantee and its owning text. g5: `orchestrator.md:34` demands a
wait "has a finite timeout", but `waiting.md:29` (the owning sub-contract)
permits an **optional** deadline and `src/orchestration/wait-service.ts:71-75`
implements exactly that (contract-conflict, medium). g2/g3 additionally flag
that `orchestrator.md` uses "budget" at lines 13/22 without a definition — those
fixes may need a clarifying contract edit before code.

A follow-up audit of the remaining `docs/contracts/` corpus would have to audit
each contract against the current code at the same guarantee granularity, run
its own executed evidence, and resolve the waiting.md/orchestrator.md deadline
conflict and the undefined "budget" wording before fixing code.

## Status update — 2026-09-25 (issue #570 series, current through 0.181.70)

This section is a handover ledger, not a re-audit. It records what landed after
the audit base and what each originally violating guarantee and named residual
looks like now; the verdicts above are the 2026-09-24 verdicts and are left as
written. Where this section states a residual is closed, the evidence is the
named merge's own CHANGELOG entry plus the code and test locations listed; the
unverified lists above keep their meaning unless a line here closes them by
name.

### Landed merges since the audit base

| Merge | Version | What it landed | Audit item it touches |
| --- | --- | --- | --- |
| #640 | 0.181.58 | contract terminology: defines intake outcome, scope exclusions, ambiguity, and the pre-work budget in `orchestrator.md`, the task budget in `autonomy.md`, measured task shape in `task-estimation.md` | precondition the g2/g3 slices demanded before code; closes the "budget undefined" flag below |
| #641 | 0.181.59 | pre-work intake statement + budget gate for `run_pipeline`/`start_pipeline` (`src/orchestration/intake.ts`; `BudgetWaitError`, `awaiting_decision`) | g2, g3 |
| #642 | 0.181.60 | budget closeout on settled runs: remainder, ceiling source, provider billing kept apart (`src/economics/charged-cost.ts`) | g8 |
| #643 | 0.181.61 | `project-conventions` skill (`always: true`, orchestrator) + the same rule in `prompts/orchestrator.md` | g9 |
| #644 | 0.181.62 | reap of a detached run stuck in the pre-claim window (the g1b slice's violating finding) | g1 residual |
| #645 | 0.181.63 | the reaped run names a recovery the operator can actually perform | g1 residual |
| #646 | 0.181.66 | `run_role` start gating through the same intake gate; the counter-estimated outcome carries the task's own wording | g2, g3 |
| #650 | 0.181.68 | `check:release` enforces non-increasing VERSION order within a tied date (issue #575) | none — process gate, not an audited guarantee row |
| #651 | 0.181.69 | the merge stamp refuses a tree the review round itself modified (issue #570 follow-up) | none — not a table row; hardens the review-stamp artefact the g7 "green from a step list" clause leans on |

### Per-guarantee state (the four rows marked violating above)

- `orchestrator.md:13` intake (g2): fixed on the pipeline and delegated-
  `run_role` dispatch surfaces. Evidence: `IntakeStatement` in
  `src/orchestration/intake.ts` carries outcome, scopeExclusions, mode,
  taskShape, budget, ceilings, and resultChangingAmbiguities; the gate is
  `buildGatedIntake` (`src/orchestration/orchestrator.ts:1454`), called by
  `run_pipeline`/`start_pipeline` (`:1539`) and by the `run_role` tool
  (`:2173`); tests `test/intake-budget.test.ts` and
  `test/conversation-intake.test.ts`. Still open: the g2b slice's remaining
  surfaces — a `run_step` start is ungated (the tool takes only
  `task`/`complexity`), the orchestrator's own direct-edit path is still "no
  guard, no bound, no record" (`orchestrator.ts:2089-2090`), and the
  conversation-prompt and CLI-drive surfaces are unverified.
- `orchestrator.md:22` budget gate (g3): fixed on the same surfaces by #641 and
  #646 — accepted, `counter_estimated` from the recorded per-role ceilings with
  evidence recorded, or blocked as an honest `budget_blocked` wait
  (`BudgetWaitError`, `orchestrator.ts:1466,1481`). Negative test: "without a
  stated decision work starts only on a recorded counter-estimate, never
  without a forecast basis" (`test/intake-budget.test.ts:171`). The slice's
  `src/context/budget.ts` caveat is closed as moot, not confirmed-as-conforming:
  #640 defines the pre-work budget as the whole-task work budget
  `autonomy.md` owns, so the role context budget is no longer a possible reading
  of this rule (see the resolution below). Still open: `run_step` and the
  direct-edit path (same surfaces as g2); the full-cycle forecast and lane
  reserves `task-estimation.md` names are not implemented beyond the
  counter-estimate; cost-anomaly wiring and TUI parity unverified.
- `orchestrator.md:47` closeout (g8): fixed by #642 (0.181.60). Evidence:
  `buildBudgetCloseout`/`formatBudgetCloseout`
  (`src/orchestration/orchestrator.ts:1102-1142`, record comment `:208-230`)
  report the ceiling with its source (operator-stated vs configured estimate),
  ledger-derived spend across rounds, an unclamped remainder whose negative
  value is stated as an overrun, and provider billing kept by name apart
  (`src/economics/charged-cost.ts`, `chargedUsd`); a provider that reported no
  billed amount is stated as an absence, not zero. Tests:
  `test/orchestrator-closeout.test.ts` (4 tests). Still open:
  conversation-side close cost reporting, `src/stamp/delivery-signature.ts`
  cost fields, live-provider billing routing.
- `orchestrator.md:51` conventions (g9): fixed by #643 (0.181.61). Evidence:
  the `project-conventions` skill (`prompts/skills/project-conventions/`,
  `always: true`, role `orchestrator`) is pasted unconditionally via
  `unconditionalSkills` (`src/skills/resolver.ts:423`), and
  `prompts/orchestrator.md:196` carries the same rule; tests
  `test/skills.test.ts:816-843`. Still open: clause-2 enforcement (durable
  decisions to repo documents) remains prompt+skill text with no mechanical
  check, and the delegated planner/coder prompts did not receive the rule.

### Residual ledger (the "Unverified" section above, item by item)

- g1: the background-run state-recording residual was executed as its own
  follow-up slice (`orchestrator-g1b-pipeline-drive-states.md`, verdict
  violating, narrowly) and fixed by #644 + #645 — CLOSED. The
  `runPipeline`/`WorkflowState` exhaustiveness read (`src/orchestration/
  types.ts:875`) was not touched by this series — OPEN.
- g2: conversation-level intake — g2b executed it (violating) and #646 fixed
  the `run_role` start; `run_step` and direct edits remain ungated — OPEN
  (narrowed). CLI drive flows — OPEN.
- g3: the `src/context/budget.ts` token-budget reading — CLOSED as moot by
  #640's definition (the file is the role context budget compaction owns and is
  deliberately not this rule's object). Full-cycle forecast / lane-reserve
  code — OPEN (nothing found beyond the counter-estimate; not exhaustively
  re-searched). Cost-anomaly wiring — OPEN. TUI parity — OPEN.
- g4: foreground staleness with no pending wake; `conversation.step()` read in
  full — OPEN (no change in this series).
- g5: which product component polls sources at runtime — OPEN. Operator-message
  interruption of a live wait mid-poll — OPEN. Visible separation of
  unavailable-condition reports — OPEN. TUI, machine-API and telegram wait
  surfaces — OPEN.
- g6: wake-summary content quality — OPEN. Premature-completion ban with no
  test — OPEN. Durable writes of non-wake decisions — OPEN.
- g7: "otherwise they are hypotheses" code anchor — OPEN. `parseVerdict`
  approval check unread — OPEN. Abort/cancel report surfaces — OPEN. (#651
  hardened the stamp against a review round that perturbed the tree under
  review, which protects the artefact this guarantee's clause leans on; it does
  not close any named residual.)
- g8: conversation-side close cost reporting — OPEN. `delivery-signature.ts`
  cost fields — OPEN. Live-provider billing routing — OPEN.
- g9: clause-2 enforcement beyond prompt advice — OPEN (the skill instructs it;
  no mechanical check exists). Delegated planner/coder prompts — OPEN.

### Cross-slice inconsistency resolutions

- g5 deadline conflict — RESOLVED 2026-09-25 (this docs series, 0.181.70), in
  the direction the owning sub-contract and the code support: the deadline is
  optional. Code evidence: `deadlineAt?: number` — "Omit for no core deadline"
  (`src/orchestration/wait-service.ts:73-74`), stored only when supplied
  (`:229`), validated only when defined (`:472-475`), and
  `timed_out`/`deadline_exceeded` produced only when a deadline exists
  (`:286`); `DEFAULT_WAIT_SERVICE_LIMITS` (`:7-14`) contains no deadline
  default, and no in-repo caller supplies or defaults one. The orchestrator's
  guarantee is preserved by replacing the false clause with what actually
  bounds the wait: `orchestrator.md`'s wait clause now states the decision
  rule — an explicit owner-side deadline, or an explicit recorded decision to
  wait without one, never silence — and its Failures section names a
  deadline-less wait's exits; `waiting.md`'s wait-record guarantee now states
  the core's no-default-deadline behaviour and cross-cites the orchestrator
  rule. The original verdict text above is unchanged.
- g2/g3 "budget" undefined — CLOSED by #640 (0.181.58), which defined the terms
  in `orchestrator.md`, `autonomy.md`, and `task-estimation.md` before the code
  fixes landed; this docs series adds only a forward pointer at the intake
  clause's first mention of the word. The original flag above is unchanged.
