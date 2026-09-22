# Orchestrator contract

This contract owns a task's lifecycle from intake to durable closeout. A task is
a series of turns; a turn is one provider call; a run is a durable pipeline
execution. Roles execute work, while stages are workflow phases.

## Guarantees

- An accepted task is exactly one of WIP, blocked, or closed. Waiting is WIP.
  There is no quietly stopped state: the orchestrator can name its state,
  durable evidence, and next event or action. A new message, restart, or context
  boundary does not close an unfinished task.
- Intake states the outcome, scope exclusions, mode, measured task shape,
  budget, ceilings, and any ambiguity that changes the result. It decomposes
  large tasks rather than requiring operator-supplied slices.
- Before work starts, the budget is accepted, counter-estimated with evidence,
  or honestly left blocked for a decision. It never proceeds with an unknown
  budget by implication.
- An unfinished task advances without a new operator message or explicitly asks
  for a decision. A deliberate foreground interrupt preserves durable WIP and
  waits for the next operator input; it does not invent an automatic turn.
- Long-running work has durable event- or timer-based wake delivery. The product,
  not an orchestrator turn, polls sources without push support. A wait names its
  object and condition, has a finite timeout, reports unavailable conditions
  separately, and is interrupted immediately by an operator message.
- Claims about a run cite an artefact; otherwise they are hypotheses. Reports do
  not prestate verdicts, paraphrase a refusal or abort as success, or call an
  unchecked check green. Green CI comes from its step list, not a badge.
- A closed task reports completed or failed outcome, evidence, ledger-derived
  total cost across all rounds, budget remainder, and required ceilings. It
  distinguishes configured estimates from provider billing and reports failed
  task cost too.
- The orchestrator reads the target project's working conventions before acting.
  Durable decisions belong in repository documents and state, not conversation.

## Failures

A lost wake-up must expose what is awaited and since when. A wait timeout wakes
the task for escalation, plan change, or decision; it never loops silently.

## Verification

Exercise intake, durable recovery, event wake, timeout, operator interruption,
and both successful and failed closeout. Inspect cited artefacts for every report
claim.

## Related surfaces

- [Autonomy](autonomy.md) owns authority, mode, budgets, and ceiling raises.
- [Delegation](delegation.md) owns execution-path selection.
- [Wake delivery](wake-delivery.md) owns durable wake mechanics.
- [Operation modes](operation-modes.md) owns manual and automatic decision scope.
