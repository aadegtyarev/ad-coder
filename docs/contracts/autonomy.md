# Autonomy contract

This contract owns operator authority, task budget, and ceiling adjustment.

## Guarantees

- `manual` is the default mode. The orchestrator sees and states the resolved
  mode, records durable mode changes and their mandate, and may lower but never
  raise autonomy without the operator. [Operation modes](operation-modes.md)
  owns which decisions each mode reserves.
- Intake asks once about mode when no prior choice exists. An active auto mandate
  is not repeatedly re-asked as though authority had not been granted.
- Within the agreed budget, the orchestrator may dispatch, retry a failed step,
  read artefacts, lower mode, and use explicitly enabled automatic actions.
  It may merge a green pull request and file tickets only when their default-on
  settings remain enabled.
- Raising a stage ceiling is one measured step. It affects only the exhausted
  role and ceiling, derives from current metrics, and records the learned value
  by model, role/stage, and measured task shape. A second observation is needed
  to change a learned value.
- A silent raise is at most the configured factor from the intake value (default
  50%), happens once, never enables a zero-disabled ceiling, and excludes the
  task's own budget. It recomputes the whole-cycle reserve; a further exhaustion
  or a raise that starves required later roles is a decomposition signal.
- Above that factor, changing task budget, raising mode, cutting started scope,
  changing profile settings, deploys, publication, or acting in someone else's
  name require operator permission. The orchestrator never presents unfinished
  work as complete, edits contracts to fit code, or works a blocked or foreign
  lane.
- Authority settings have explicit defaults and effective source. A malformed
  settings file is refused rather than treated as an absent mandate.

## Verification

Test mode transitions, a silent and a permissioned raise, disabled ceilings,
reserve starvation, budget change refusal, and durable mandate and learned-limit
records.

## Related surfaces

- [Configuration](config.md) owns resolution of settings and ceilings.
- [Stage-limit calibration](stage-limit-calibration.md) owns measured raise data.
- [Orchestrator](orchestrator.md) owns task state and closeout.
- [Task estimation](task-estimation.md) owns full-cycle forecast and feedback.
