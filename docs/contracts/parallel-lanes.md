# Parallel lanes contract

This contract owns concurrent isolated role and workflow execution.

## Guarantees

- An operator and the orchestrator may request parallel lanes through the same
  headless launch action. A lane has a durable parent, goal, mutable scope,
  budget/reserve, run identity, branch, worktree, and terminal result.
- Concurrent mutation requires the enabled Git workspace adapter. Each lane gets
  a managed worktree and unique branch from the same validated base; a non-Git
  workspace permits at most one mutable lane while retaining independent
  read-only research work.
- Before launch, the planner records each lane's intended mutable paths and
  integration order. Strictly disjoint scopes may run together. An overlap needs
  an explicit bounded merge plan with independently assigned regions and a
  named integration lane; otherwise the later lane queues or refuses before a
  write. Shared read-only paths never count as a conflict.
- The parent forecast reserves each lane's work, review, and final integration.
  A lane cannot consume another lane's reserve. A failure, decomposition, or
  cancellation is attributed to that lane and does not silently cancel siblings.
- Completed lanes remain independently reviewable. Integrating their branches,
  resolving a merge conflict, and final review are separate recorded work; a
  configured required reviewer is never bypassed by parallel execution.
- A front projects lane state, scope, cost, and integration readiness without
  blocking ordinary input. The user and orchestrator can list, start, stop, and
  observe lanes; launch, validation, errors, and results have TUI/API parity.

## Verification

Test simultaneous disjoint lanes, non-Git mutable-lane refusal, overlap queue and
explicit merge-plan admission, worktree/branch uniqueness, per-lane reserve,
isolated cancellation, conflict-resolution dispatch, required review, and TUI/API
parity.

## Related surfaces

- [Worktree lifecycle](worktree-lifecycle.md) owns Git worktree safety.
- [Delegation](delegation.md) owns execution-path selection.
- [Task estimation](task-estimation.md) owns whole-cycle reserves.
- [Agent dispatch](agent-dispatch.md) owns durable background runs.
