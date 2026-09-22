# Task estimation contract

This contract owns whole-cycle development forecasts and their corrective
feedback.

## Guarantees

- Before dispatch, the orchestrator forecasts the full proposed development
  cycle, not merely its first role. The forecast names selected workflow and
  roles, reachable routes, configured ceilings, expected review/rework rounds,
  and total budget reserve with declared price inputs.
- A dispatch may start only when its budget can fund that forecast or its
  shortfall is visible and resolved under the autonomy contract. Raising one
  role's ceiling recomputes the remaining-cycle reserve; a raise that starves
  required later roles is an estimate failure and a decomposition signal, not a
  quiet transfer of their budget.
- Planner estimate mismatch, an explicit `too_complex` signal from planner,
  coder, or reviewer, repeated review findings, and pipeline review loops become
  durable estimation observations. They feed the one-probe-or-decompose
  mechanism in [work decomposition](work-decomposition.md).
- Observations record predicted and actual task shape, path, routes, ceilings,
  role rounds, cost, reserve outcome, and decomposition or probe result. They
  are bounded, secret-free evidence, never a penalty, reputation score, or
  automatic punishment for an honest estimate correction.
- The orchestrator has a read-only planning-feedback tool that returns relevant
  aggregated prior observations and current forecast variance before intake,
  dispatch, or a ceiling decision. The operator has the equivalent TUI and
  machine action; it never changes routing, budgets, or task state.

## Verification

Test full-cycle forecasts across standalone role and workflow paths, reserve
recalculation after a ceiling probe, starvation detection, each estimation signal,
bounded feedback aggregation, and read-only TUI/machine/orchestrator parity.

## Related surfaces

- [Work decomposition](work-decomposition.md) owns split execution.
- [Autonomy](autonomy.md) owns permitted budget changes.
- [Stage-limit calibration](stage-limit-calibration.md) owns ceiling learning.
- [Routing configuration](routing-config.md) owns declared route prices.
