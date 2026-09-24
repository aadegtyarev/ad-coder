# Slice audit: orchestrator guarantee `orchestrator.md:16` (g3-budget)
Audit base: ff07c9988923aeb4fa0b66106f3574103eb4b4cd, date 2026-09-24.
Rule text: "- Before work starts, the budget is accepted, counter-estimated with evidence,
  or honestly left blocked for a decision. It never proceeds with an unknown budget by
  implication."

## Verdict
violating (for the orchestration dispatch surface): dispatch surfaces carry no budget and
no budget gate at all, the only counter-estimate implementation is an operator-side CLI
report tool that is never consulted before work, and a build whose forecasts have no
evidence returns `budgetStatus: "unknown"` with no code path that blocks or asks; the
existing cost ceilings (`maxCostUsd`) are runtime exhaustion limits, not a pre-work budget
decision. Examined: `src/economics/forecast.ts`, `src/orchestration/stage-limits.ts`,
`src/cli/resolve-config.ts` (stage-limit defaults), `src/orchestration/orchestrator.ts`
(dispatch tools, grep), `src/orchestration/control-plane.ts` (grep), `src/runner/role-runner.ts`,
`src/cli.ts` profile-estimate action, contracts `orchestrator.md`, `task-estimation.md`,
`operator-flow.md`. Not examined: conversation-level intake, session/context budget
derivation (`src/session-limits.ts`, `src/context/budget.ts` beyond grep), background-run
lane funding (`task-estimation.md` lane-reserve clause), TUI surfaces — all `unverified`.

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `ff07c9988923aeb4fa0b66106f3574103eb4b4cd` |
| `bun test test/economics-forecast.test.ts` | 2 pass, 0 fail, 2 expect() calls, exit 0 (553ms). Covers the suites-fit case only: asserts `budgetStatus: "fits_expected"`; no test in that file exercises the `unknown` branch or any blocking behaviour. |
| `bun test test/stage-limits.test.ts` | 20 pass, 0 fail, 66 expect() calls, exit 0 (458ms). Behaviour exercised: `cost_in_flight` single-admission gate (line 156) and "models wrapper meters every provider turn and blocks before dispatch" (line 190) prove mid-stage cost metering — NOT a pre-work budget decision. |
| `grep -rn forecastCost/budgetStatus across src+test` | `forecastCost` is consumed only by `src/cli.ts:45` (import) and `src/cli.ts:2173` (print); `budgetStatus` is produced in `src/economics/forecast.ts` and consumed nowhere else. |
| `grep -rni estimat across src/orchestration + src/project-operations` | No pre-dispatch budget or estimate gate: hits are comments (`orchestrator.ts:239`, `stage-limits.ts:287`), the flow-description string `orchestrator.ts:1434`, and two "never estimated" doc comments. |

## Evidence read
- Rule's three branches: (1) "accepted" — no branch exists: the dispatch tools I read in the
  previous slice (`orchestrator.ts:1272-1324`, `run_pipeline`/`start_pipeline` params are only
  `task`/`complexity`) carry no budget field to accept, and grep over `control-plane.ts` shows
  no budget decision point; nothing refuses dispatch for an unstated budget.
- (2) "counter-estimated with evidence" — the only counter-estimate is
  `src/economics/forecast.ts:51-108` `forecastCost`, whose inputs (`creditBalance`,
  `creditsPerUsd`) yield `budgetStatus` "unknown"/"fits_expected"/"below_expected"; it is
  reachable only from the operator CLI `src/cli.ts:2173` (`profile estimate`), a report, not a
  gate: an `unknown` status is printed and the CLI exits 0.
- (3) "honestly left blocked for a decision" — no blocking code path: grep found no consumer
  of `budgetStatus` in `src/orchestration/`; `CostAnomalyBlockedError` (`orchestrator.ts:13`)
  exists but only as a runtime anomaly import, and I found no pre-dispatch use (`unverified`
  where the wiring sits beyond grep).
- "never proceeds with an unknown budget" is directly contradicted on the observed surfaces:
  dispatch needs no budget at all (`PipelineResult`/tools above), and a run proceeds with
  stage limits implied by `DEFAULT_ROLE_STAGE_LIMITS` (`src/cli/resolve-config.ts:149-190`,
  `maxCostUsd` 0.3/0.75/0.45, ...) — configured ceilings, not an operator-accepted budget.
- What the implementation DOES gate: `StageLimitController.assertActive/admitModelTurn`
  (`stage-limits.ts:241-258, 298-310`) denies model turns past `maxCostUsd` and permits one
  in-flight admission (`cost_in_flight`), and `failUnknownCost` (`stage-limits.ts:420-427`)
  marks a run terminal (`cost_unknown`) when provider usage is missing — a measured runtime
  guard, not a pre-work budget state, and `maxCostUsd: 0` means disabled (unlimited), which is
  an unknown-budget path with no refusal at all.
- Sibling contracts name the demanded shape but the orchestrator bullet's branch is not its
  implementation surface: `task-estimation.md:5-10` ("dispatch may start only when its budget
  can fund that forecast") — the code I read has no full-cycle forecast object at all, so that
  sibling guarantee is unimplemented rather than merely untested; `operator-flow.md:12-14`
  (accept / evidence-backed counter-estimate / state reconnaissance cost) matches the CLI
  tool's shape but only for the operator, never before work.

## Gaps and unverified
- The g2-intake verdict's caveat stands here too: `orchestrator.md:14` vs `:16` use "budget"
  without a definition (sentence-level work budget vs context-token budget vs stage cost
  ceilings). A clarifying contract edit should precede the fix; as written, the sum of
  evidence (no gate, no consumer of the forecast, CLI-only unknown-printed exit 0) supports
  "violating" on the surfaces I read rather than `contract_missing_evidence`.
- UNVERIFIED surfaces: `src/context/budget.ts` token-budget validation semantics beyond grep
  (may be the "budget" the rule means — a reading under which the verdict would soften to
  mixed, still not conformance since no terminal consumer gates on forecast acceptance);
  full-cycle forecast implementation named by `task-estimation.md` Verification section
  (starvation detection, lane reserves) — I found no corresponding source, but did not
  exhaustively search background-run code; cost-anomaly detector wiring; TUI/operator-flow
  parity for the estimate action.
- No test anywhere I ran or grepped exercises the negative path the rule defines (proceeding
  with an unknown budget must NOT happen); `test/economics-forecast.test.ts` covers only the
  fits branch. A fix must start with a characterization test that a dispatch with no accepted,
  no counter-estimated, and no explicitly blocked budget does not start work.
