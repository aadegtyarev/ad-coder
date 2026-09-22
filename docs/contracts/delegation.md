# Delegation contract

This contract owns how an orchestrator chooses an executor for bounded work.

## Guarantees

- Choose and name the least costly sufficient path before taking it: a bounded
  direct edit, one role, a standalone reviewer round, or a pipeline. A pipeline
  is justified by its required sequence, not task size alone.
- Role work is performed by roles. The coordinator does not replace a role with
  its own edits except for the explicitly recorded trivial direct-edit allowance
  in [operation modes](operation-modes.md).
- A dispatch includes goal, acceptance criterion, scope and file bounds, budget,
  ceilings, and task shape. Scope widening is a new dispatch, not a silent edit.
- Parallelize only independent work. Two mutable lanes may not share a branch,
  version, or file; each lane has its own branch, worktree, pull request, and
  console ownership.
- `run_role` reviewer output is advisory. A review that must satisfy merge policy
  uses a pipeline review stage or standalone reviewer round as required by
  [review evidence](review-evidence.md).

## Verification

Record the chosen path and dispatch bounds. Test scope rejection, worktree
separation, and the difference between advisory and stamp-producing review.

## Related surfaces

- [Operation modes](operation-modes.md) owns the direct-edit allowance.
- [Review evidence](review-evidence.md) owns review proof.
- [Product changes](product-change.md) owns issue and pull-request lifecycle.
