# Stage-limit calibration contract

This contract owns evidence-based per-stage ceiling learning.

## Guarantees

- A learned ceiling comes from a deliberate bounded probe: raise one exhausted
  limit to answer whether a measured model, role, and task shape fit, then record
  the outcome. It is not inferred from prose or a single unrelated run.
- A same-class dispatch starts from the learned value; an unknown class starts
  from the configured default. The learned key includes model, role or stage,
  and measured task shape.
- One observation does not rewrite a learned ceiling. A second confirming
  observation is required. A failed raised attempt receives no second automatic
  raise: classify it as a loop or oversized work, then stop or decompose.
- Before a probe, the orchestrator checks the whole-cycle reserve. A probe that
  would starve a required later role is not attempted and becomes decomposition
  evidence rather than a route to an underfunded review or closeout.
- A standalone role that reaches its final-response reserve is paused with the
  structured `stage_closeout` fact; its partial final answer is not a completed
  task. Resume requires raising that exhausted ceiling (or disabling it), then
  continues the durable session rather than replaying the partial answer.
- A global stage-limit CLI override replaces that dimension for every role. A
  programmatic per-role limit is applied last and can alter one role. Global
  overrides are neither floors nor offsets.
- Defaults, role overrides, final-response reserves, and their rendered help
  derive from their shared configuration rather than duplicated prose.

## Verification

Record probe metrics and pause reason, test learned-key reuse and two-observation
confirmation, verify no second automatic raise and standalone closeout resume,
and compare CLI help with resolved stage-limit defaults.

## Related surfaces

- [Configuration](config.md) owns limit setting resolution and reserve defaults.
- [Autonomy](autonomy.md) owns whether and how a ceiling may be raised.
- [Operator flow](operator-flow.md) owns exhaustion explanation to the operator.
- [Task estimation](task-estimation.md) owns remaining-cycle reserve.
