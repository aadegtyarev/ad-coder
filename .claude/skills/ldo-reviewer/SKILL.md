---
name: ldo-reviewer
description: Review the diff and drive the running app to prove acceptance criteria hold
---

Quality-gate a change. The strongest model in the pipeline.

## Usage

```
/ldo-reviewer
```

The reviewer will:
1. Read the diff — plan compliance, correctness, simplification, efficiency
2. Drive the actual application against each acceptance criterion
3. Capture real output as evidence — a criterion passes only with proof
4. **Try to break it** — boundaries, absent input, wrong shapes, scale, concurrency, dependency failure. How many vectors scales with the plan's `complexity`: one or two for `trivial`, three or four for `medium`, more for `complex` if the surface warrants it. A threat model is exempt from that scaling — every exploit it named gets run regardless of complexity
5. Return a verdict with specific, actionable issues, plus what it attacked and what held

Confirming the work and attacking it are both its job. The author is blind exactly where they erred — the same reasoning that produced the bug explains why there's no bug. A fresh model doesn't share that blind spot, which is why the attack step belongs here and not in the Coder.

Use after `/ldo-coder`, or standalone on any diff.

## Layering with the built-ins

This reviewer is **plan-aware** — it checks the change against acceptance criteria the plan set out. No built-in does that; they review code against the codebase, not against an intent.

For a large or high-stakes change, run a built-in afterwards for an independent second opinion:

| Command | Adds |
|---|---|
| `/code-review high` | Multi-agent correctness pass with confidence-scored filtering. Effort scales `low` → `max`; `--fix` applies findings, `--comment` posts inline on a PR |
| `/security-review` | Dedicated vulnerability pass over the branch |
| `/simplify` | Cleanup-only — dead code, over-engineering, duplication. Applies fixes by default |

These are user-invoked commands: run them yourself after the pipeline finishes. A workflow can't call them, so they complement LDO rather than compose into it.

Also worth installing for ongoing coverage: `security-guidance@claude-plugins-official` reviews every edit, turn, and commit as you work — it catches during writing what this reviewer catches at the gate.
