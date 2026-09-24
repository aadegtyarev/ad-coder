# Slice audit: orchestrator guarantee `orchestrator.md:47` (g8-closeout-report)
Audit base: ff07c9988923aeb4fa0b66106f3574103eb4b4cd, date 2026-09-24.
Rule text: "- A closed task reports completed or failed outcome, evidence, ledger-derived
  total cost across all rounds, budget remainder, and required ceilings. It
  distinguishes configured estimates from provider billing and reports failed
  task cost too."

## Verdict
violating (partial): the outcome, evidence, ledger-derived-cost, ceiling and failed-cost
clauses conform with executed evidence on the pipeline/background-run surfaces, but no
surface in the code reports a "budget remainder" figure or distinguishes "configured
estimates" from provider billing by name. Surfaces examined: `src/orchestration/
orchestrator.ts` tool projections, `src/orchestration/background-runs.ts` terminal
outcomes. Not examined: the conversation/console close path (covered by slice g1 for
states, not for cost), the stamp/delivery-signature surface (`src/stamp/delivery-
signature.ts` carries `totalCostUsd` but was not verified), and any real-provider
closeout artifact.

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `ff07c9988923aeb4fa0b66106f3574103eb4b4cd` |
| `bun test test/orchestrator.test.ts` | 76 pass, 0 fail, 445 expect() calls, exit 0 (5.19s) |
| `bun test test/background-runs.test.ts` | 25 pass, 0 fail, 146 expect() calls, exit 0 (1.36s) |

Behaviour actually exercised (test names verified by reading the files):
- `showCost perStep sums to totalCost` (test/orchestrator.test.ts:1542): after a real
  `core.runPipeline`, `core.showCost()` reports perStep and a total consistent with the
  run's ledger-derived costs — the ledger-derived-total clause.
- `a resumed session's show_cost is cumulative over the seeded prior rows`
  (test/orchestrator.test.ts:2934): a seeded prior ledger row plus new work aggregates in
  one report — the "across all rounds" clause.
- "headless orchestrator shares limits across pipeline and manual workflow work"
  (test/orchestrator.test.ts:1564): `sessionLimits.admittedTurns` is 5 from the
  controller — the ceilings carry into the cost report surface.
- background-runs.test.ts pause-reconnect test (real state machine, ~line 780): a run
  paused on a cost stage limit durably reports `outcome.metrics = {steps: 1,
  totalCost: 0.1}` after worker exit — real spent cost reaches the outcome surface.
- same file's failure paths (~line 739): a failed run's frozen moment carries
  `metrics: {steps, totalCost}` — the "reports failed task cost too" clause.

## Evidence read
- `src/orchestration/orchestrator.ts:216-227` — `CostReport.totalCost` is documented and
  implemented as the sum of `usage.cost.total` over EVERY ledger record on the shared
  sink (`src/orchestration/orchestrator.ts:762-774`), i.e. ledger-derived across rounds.
- `src/orchestration/orchestrator.ts:962-982` — `formatCost` renders `total cost:` +
  per-step ledger costs, and with a snapshot appends `session limits: turns
  admitted/max, cost observed/max, in-flight, terminal reason` — the ceiling figures the
  operator can read; `show_cost` (orchestrator.ts:1532-1551) exposes it as a tool.
- `src/orchestration/orchestrator.ts:1288-1297` — `run_pipeline` reports
  `approved/rounds/review/gates + stage metrics + cost`; but its catch (1294-1297)
  returns only `safeErrorText(error)` with no cost, so a synchronously failed foreground
  run reports no cost on that tool's own reply.
- `src/orchestration/orchestrator.ts:236-264` — `RaisedStageLimits` + `assertRaisedLimits`
  record a raised ceiling with role/reason/limit; the resume tool description
  (orchestrator.ts:1433-1434) states the pause reports the exhausted value.
- `src/orchestration/types.ts:528` — stage metrics usage is "Provider-reported subset of
  output; never estimated"; `formatStageMetrics` (orchestrator.ts:1001-1025) adds a
  separate `providerCost=` line beside the ledger `total cost:` line.
- `src/orchestration/background-runs.ts:149-158` terminal outcomes carry
  approved/rounds/verdict; `background-runs.ts:506-508` accumulates real
  steps/totalCost per stage; `background-runs.ts:483-488` and `1146-1170` attach those
  real metrics to failed/abandoned outcomes.
- Gap evidence: greps over `src/` (excluding runtime `.ad-coder/` logs) found NO
  occurrence of "budget remainder", "failed task cost", or a configured-estimate field on
  any closeout surface — those two sub-clauses have no named implementation.

## Gaps and unverified
- "budget remainder": the closest implementation is the observed/max session-limits line
  (remainder is derivable, never stated). Verdict treats the literal clause as unmet;
  whether an implied "derive it from observed/max" reading satisfies the contract is for
  the operator to rule on.
- "distinguishes configured estimates from provider billing": the code distinguishes
  ledger attribution from provider-billed stage cost, but no "configured estimate"
  (e.g. a plan-time or full-request estimate figure) appears on any closeout surface I
  read — sub-clause `contract_missing_evidence`; `test/full-request-estimate.test.ts`
  exists and was NOT run or read for this slice.
- The conversation close path's cost reporting, the delivery-signature
  (`src/stamp/delivery-signature.ts:33,91,139`) and `pipelineResult` tool JSON
  (orchestrator.ts:~700-760) were identified but not read against this rule.
- No end-to-end run against a live provider was performed; all cost evidence is from
  faux-provider fixtures, so real-billing routing through these surfaces is `unverified`.
- Command count: 3 commands beyond navigation/greps (rev-parse + two `bun test` runs).
