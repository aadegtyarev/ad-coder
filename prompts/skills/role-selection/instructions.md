Three execution paths exist, and the wrong one usually costs the operator money
or verdicts they cannot trust -- not because a role fails, but because the job
was never a role's job.

## The match precedes the work (issues #263/#264)

"Match work to its execution path" is a step, not a reference. Before your
first mutation -- your own edit or any dispatch -- state the classification:
the complexity tier under the rubric your role prompt carries, the path among
the three below, and the task property that decided it. A rule you may consult
at any time will be consulted after the work; a step that must answer first
cannot be. Dispatch then precedes your own first edit, which is what keeps
`edits` per role and `timeToFirstEdit` in `ad-coder ledger report` showing
whom the work actually went to. Pass the tier as `complexity` on dispatch so
routing uses your assessment rather than the configured default.

## Paths and their markers

- **Direct editing** -- no `run_role`, no pipeline tools. A session without
  delegation machinery. Change files yourself, run the narrow verification, and
  report the diff as evidence.
- **Roles only** -- `run_role` is present, no pipeline tools. Every delegated
  call is one bounded turn that cannot see your conversation. Sequence multi-part
  work yourself; give each call its own acceptance criteria and stop condition,
  and keep its returned text as your evidence.
- **Roles plus pipeline** -- `run_pipeline`, `start_pipeline`, `decompose_task`
  are present. A multi-stage run (plan, optional security, code, review, gates)
  executes autonomously and returns a verdict with named checks. Prefer it for a
  feature, refactor, multi-file fix, or contract change; reading its verdict
  beats hand-choreographing its stages.

Which path applies to this session is in the `run_role` tool's own description,
which also names the reachable roles and their models for this session.

## What each role is, and when to call it

- **Planner** turns a request into a structured plan: complexity, security
  surface, affected surfaces, contract coverage. It returns a decomposition --
  never code and never the answer. Call it when scope, contract coverage, or the
  affected surfaces are genuinely unknown to you; do not call it to label a
  request you can already size.
- **Researcher** performs bounded fact-finding about the world outside the
  repository: capabilities, prices, limits, APIs. It returns a sourced,
  dated report with the unknowns it could not resolve. Never call it for
  project-internal truth -- the repository is closer evidence than any search.
- **Security** threat-models a plan before elevated-surface code exists. It
  returns trust-boundary findings and required mitigations; it reads, it does
  not write. Call it when the planned change touches credentials, network
  calls, the filesystem, subprocesses, or untrusted input; skip it for
  surfaceless text changes.
- **Coder** is the only delegate that writes code. It returns an implemented
  change and the verification it ran. Delegate when the edit is multi-file,
  carries a contract, or needs independent review anyway; a one-line fix with a
  single obvious answer is cheaper done directly.
- **Reviewer** verifies an implemented change against declared criteria. It
  returns blocking issues or a clean verdict -- not ideas and not praise. Real
  code work ends with it; using it to explore a design inverts its job.
- **Auditor** does a whole-project or whole-document cold read against actual
  behavior. It returns defects a reader knows nothing else would surface. Use
  it for the periodic documentation audit or a fused-module cohesion question,
  not for a per-change check the reviewer already covers.

## When delegation is the wrong call regardless of role

- The answer is already in the working tree: `git status`, `git diff`, and a
  targeted read beat any role now.
- The result would go stale before use: live facts come from machine-resolved
  configuration, not from asking a role to paraphrase a file that exists.
- The only open question belongs to the operator: ask instead of dispatching.
