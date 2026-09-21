**This instruction is mandatory.** Where this skill's description matches the work in front of you, the method below is required: an approach that contradicts it is a defect to fix, not a preference to keep.

# Delivery discipline

This is one procedure for the orchestrator, coder, and reviewer. They use the same operations and pay the same delivery rounds; do not treat a delivery step as advice for another role.

## Start with the contracts

The first project-work step is to read `AGENTS.md`, `docs/contracts/quality.md`, and `docs/contracts/product-change.md` (then any delivery contract they point to). Record the current branch and working-tree state. Do not edit, rebase, version, or dispatch until that read is complete.

## Event procedure

Use this sequence whenever a merge PR, conflict, rebase, stamp, version, release, force push, or red CI makes delivery work active:

1. **Rebase first.** Fetch the current `origin/main`, rebase the branch onto it, and resolve conflicts deliberately. A rebase changes the reviewed tree, so it always requires a fresh review round; never continue from an old approval or stamp.
2. **Version second.** Choose a new SemVer above `origin/main`, update `package.json` and its dated `CHANGELOG.md` entry, and run `bun run check:version`. That check requires `origin/main` to resolve, reads candidate claims from both `refs/heads/*` and `refs/remotes/origin/*`, ignores main, the current branch and its remote twin, ignores refs already ancestors of `origin/main`, and refuses an open branch claiming the same version. A local branch ref is not proof that its remote branch was pushed; fetch the remote before relying on branch-push claims. A PR title version, when present in parentheses, must exactly match the package version.
3. **Review freshly.** After the rebase and every other tree edit, run a new independent review round over the exact tree to be delivered. An advisory reviewer response does not satisfy the stamp gate.
4. **Stamp after approval.** The settled review writes the stamp. `bun run stamp:check` passes only when the newest stamp is present and well formed, its verdict is not `changes_requested`, and its digest exactly matches the current working tree (with the stamp log excluded from that digest). The stamp also identifies the reviewed base, verdict, reviewer provider/model, time, run ids, and finding location. Any post-review tree edit—including a rebase, version edit, conflict fix, or generated-file change—invalidates that digest and demands another review and stamp.
5. **Push and inspect CI.** Push only after the fresh stamp check passes. If rewriting a branch after it was pushed, treat the local history rewrite as a post-review tree edit. Before using `git push --force-with-lease`, obtain a fresh independent review, a settled stamp, and a passing `bun run stamp:check`; never use plain `--force`. A red CI check is a delivery failure: fix its cause, then treat the fix as a post-review tree edit and repeat the fresh review/stamp sequence.

Use the repository's supported squash merge for one coherent PR; it preserves the reviewed exact head while producing the expected single-parent landing. Choose another merge method only when the repository policy or an explicit operator decision requires branch topology preservation, and then verify that method's resulting head is the stamped one. Do not merge a stale stamp, bypass a red check, or claim that a local ref proves a remote push.

**Stop condition:** stop and report the exact missing ref, unresolved conflict, failed verdict, stale digest, version claim, merge-policy decision, or CI command when the sequence cannot establish the required evidence. Do not guess around an undecided contract.
