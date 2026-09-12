---
name: ldo-planner
description: Read the codebase and produce an implementation plan with complexity and security ratings
---

Invoke the planner to turn a task into an executable plan.

## Usage

```
/ldo-planner "add rate limiting to the API endpoints"
```

The planner will:
1. Read the parts of the codebase the task touches — call sites, tests, config
2. Rate complexity (`trivial` / `medium` / `complex`)
3. Rate the security surface (`none` / `low` / `elevated`) and flag specifics
4. Rate whether the task fits one run, and return a suggested split with dependencies when it doesn't
5. Reconcile any artifact the task supplied — a schema, an API shape, a config block, a document to plan from — against the project's contracts and against the brief's own prose, and report each contradiction as a decision for you to confirm rather than picking a side
6. Produce ordered steps with checkable acceptance criteria
7. Capture a codebase context snapshot the Coder and Reviewer reuse

The sizing rating is advisory — the pipeline reports it and never blocks on it. `planOnly: true` on `/ldo` is how to get a plan and its sizing back without implementing anything.

Its `codebase_context` is the only repo information downstream agents get — they don't re-scan.

Use before `/ldo-coder`, or let `/ldo` run the whole pipeline.
