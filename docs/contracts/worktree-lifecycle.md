# Managed worktree lifecycle contract

This contract owns worktrees created and cleaned by the optional Git workspace
adapter. It does not govern arbitrary developer worktrees or non-Git workspaces.

## Guarantees

- A managed worktree has durable ownership metadata: canonical primary project
  root, canonical worktree path, branch, creation head, creating run, and state.
  The product never adopts, removes, or prunes a worktree it did not create.
- The default managed root is `<project>/.worktrees/`, which is ignored by the
  project. It is separate from `.ad-coder/`, whose contents are runtime state.
  A configurable root resolves under the primary project root after realpath and
  containment validation; traversal, symlink escape, and path-prefix matches fail.
- Creation uses `git worktree add` with a unique safe branch and records metadata
  only after Git succeeds. A dirty, active, or already-bound worktree is never
  silently reused. A reviewed plan and a worktree target remain independent.
- Automatic cleanup is enabled by default. It runs only after a publishing path
  records a verified merged pull request, including squash/rebase merges that
  cannot be proved from branch ancestry alone.
- Cleanup requires managed ownership, a clean status, no live durable run, no
  active process rooted there, and a path other than the caller's worktree. It
  runs from the primary worktree or a dedicated cleanup process, never from the
  worktree it removes.
- Cleanup uses `git worktree remove`, then prunes Git metadata. It removes the
  feature branch only after merge verification and after confirming no remaining
  worktree uses it. A failed check or removal retains metadata and reports the
  exact safe reason; it never falls back to recursive filesystem deletion.
- Status and cleanup commands list managed candidates, state, retained reason,
  and recovery action. Disabling automatic cleanup is explicit configuration;
  manual cleanup applies the same safety checks.

## Configuration

`worktrees.root` defaults to `.worktrees`; `worktrees.autoCleanup` defaults to
enabled. Both are configurable through the standard settings precedence.

## Verification

Test contained-root creation, metadata atomicity, dirty/active/unmanaged refusal,
merge and squash-merge evidence, self-removal deferral, successful Git removal and
branch pruning, and retained diagnostics after every failed safety check.

## Related surfaces

- [Product changes](product-change.md) own publishing and merge completion.
- [Delegation](delegation.md) owns independent mutable lanes.
- [Configuration](config.md) owns setting precedence.
- [Security](security.md) owns filesystem and shell authority.
- [Extension modules](extension-modules.md) owns optional-adapter boundaries.
- [Parallel lanes](parallel-lanes.md) owns concurrent-lane admission.
