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
