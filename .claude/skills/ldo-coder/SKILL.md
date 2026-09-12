---
name: ldo-coder
description: Set up the environment, implement the plan with tests, update user-facing docs
---

Invoke the coder to implement a plan.

## Usage

```
/ldo-coder "implement the plan"
```

The coder will:
1. Get the environment running — install deps, start services, fill `.env`
2. Work through the plan step by step, writing tests alongside the code
3. Run tests as it goes — scoped to the files it touched when the run is configured that way — and the full suite at the end of the pass
4. Implement any security mitigations as hard requirements
5. Update README / CHANGELOG for user-facing changes
6. Never swallow an error silently — the caller must be able to tell what happened
7. Write comments only where they state something the code can't show itself, not narration
8. Review its own diff before finishing

Environment setup, tests, and docs are all its job — it needs the environment to run tests anyway, and it already knows what changed.

Use after `/ldo-planner`, before `/ldo-reviewer`.
