# Delegation contract

This contract owns how an orchestrator chooses an executor for bounded work.

## Guarantees

- Choose and name the least costly sufficient path before taking it: a reviewed
  direct edit, one specialist role, a generic agent, a selected workflow, or a
  pipeline. A pipeline is justified by its required sequence, not task size
  alone.
- The orchestrator selects only roles useful to the bounded goal. It may skip a
  planner for a narrow merge-conflict resolution, dispatch a researcher directly
  to assess a specification or work volume, and choose other specialised paths.
  It may not skip any role named by the effective required-role policy; when
  `review.required` is true, code changes always receive the required review.
- Role work is performed by roles. The coordinator does not replace a role with
  its own edits except for the explicitly recorded trivial direct-edit allowance
  in [operation modes](operation-modes.md).
- A dispatch includes goal, acceptance criterion, scope and file bounds, budget,
  ceilings, and task shape. Scope widening is a new dispatch, not a silent edit.
- Parallel mutable work follows [parallel lanes](parallel-lanes.md); it is
  available only through the Git workspace adapter and never shares a worktree
  or branch. Independent read-only research may still run without Git.
- `run_role` reviewer output is advisory. A review that must satisfy merge policy
  uses a pipeline review stage or standalone reviewer round as required by
  [review evidence](review-evidence.md).
- A manual or orchestrated agent launch follows [agent dispatch](agent-dispatch.md).
  Choosing a background execution path does not bypass scope, worktree, or review
  requirements.
- Work expected to produce output above the configured context threshold goes to
  the appropriate specialist role or `generic` agent. The orchestrator receives
  a bounded result and artifact references, not an unbounded transcript; it may
  retain large output directly only when no delegable path exists and records why.

## Verification

Record the chosen path, selected/skipped roles, rationale, and dispatch bounds.
Test required-role refusal, direct researcher and conflict-resolution paths,
large-output delegation, scope rejection, worktree separation, and the difference
between advisory and stamp-producing review.

## Related surfaces

- [Operation modes](operation-modes.md) owns the direct-edit allowance.
- [Review evidence](review-evidence.md) owns review proof.
- [Agent dispatch](agent-dispatch.md) owns role and ad-hoc launches.
- [Product changes](product-change.md) owns issue and pull-request lifecycle.
- [Configuration](config.md) owns required-role and context-threshold settings.
- [Parallel lanes](parallel-lanes.md) owns concurrent mutable execution.
