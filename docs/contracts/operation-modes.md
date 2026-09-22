# Operation modes contract

This contract owns the manual/automatic decision boundary and the narrow
direct-edit exception.

## Guarantees

- In `manual`, product and architecture decisions wait for operator resolution.
  In `auto`, the recorded mandate delegates those decisions to the orchestrator,
  which resolves them from the task and committed project knowledge.
- Every automatic decision records action, rationale, evidence, scope, mandate
  source, and affected run identifiers. Child work stays within root project
  scope and inherited external-effect authority; uncertain expansion stops.
- After root decomposition, auto mode may create child pipelines. A repeated
  decomposition in a child ends that series and returns remaining work and
  verdicts rather than recursing without bound.
- Before the first mutation or dispatch, classify complexity, execution path,
  and deciding property; inspection may precede this. The classification rides
  dispatch and replaces routing fallback complexity.
- Code changes are delegated to the coder except for a recorded trivial edit:
  one function, no call sites, uniquely determined, at most one file and five
  total added-plus-removed lines accumulated until reviewer cover. The machine
  measures this bound. A reachable reviewer covers any code edit; otherwise
  durable `reviewer_unavailable` evidence records the exception.
- The resolved delegation surface and routes are generated from configuration,
  never hand-written prompt prose. Static guidance on choosing a path belongs in
  the role-selection skill.

## Verification

Test manual and auto decisions, durable automatic-decision records, root/child
decomposition stop, pre-mutation classification, direct-edit measurement, and
reviewer-unavailable recording.

## Related surfaces

- [Autonomy](autonomy.md) owns mandate changes and authority classes.
- [Delegation](delegation.md) owns execution-path dispatch.
- [Routing configuration](routing-config.md) owns resolved role routes.
- [Review evidence](review-evidence.md) owns reviewer proof.
