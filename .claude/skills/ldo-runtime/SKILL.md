---
name: ldo-runtime
description: Run LDO's shared planner, security, coder and reviewer pipeline through either Claude Code or Codex CLI
---

Run the runtime-neutral LDO pipeline when the operator explicitly asks for the
portable Claude/Codex path.

Choose the runtime from the current host:

- Claude Code plugin: `node "${CLAUDE_PLUGIN_ROOT:?}/scripts/ldo-run.mjs" --runtime claude "<task>"`
- Vendored Claude project: `node .claude/scripts/ldo-run.mjs --runtime claude "<task>"`
- Codex in an LDO checkout: `node scripts/ldo-run.mjs --runtime codex "<task>"`

Pass `--plan-only` when the operator asks only for a plan. Pass `--isolate`
only when they request a separate worktree; it creates and proves a fresh
`.worktrees/<task>` checkout before planning. Use `--research` only for work
that needs external evidence. The runtime prints one JSON result covering all
phases; report its final approval status and any incomplete verification.

For several independent features, repeat `--task "..."`. That mode creates an
isolated worktree for every task before its phases run concurrently; do not
batch dependent tasks.

This is additive. `/ldo` continues to use the existing Claude workflow while
the shared runtime is being migrated feature by feature.
