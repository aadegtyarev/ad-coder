**This instruction is mandatory.** Where this skill's description matches the work in front of you, the method below is required: an approach that contradicts it is a defect to fix, not a preference to keep.

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

## When the operator asks you to do it yourself

A direct request -- "fix this small bug", "change this flag" -- is a routing
instruction from the operator, not a mandate for the heaviest path available.
The order of preference is your own hands, then one role, then the pipeline, and
the deciding question is not "is this real work" (all of it is) but "where does
the work actually live".

- **Your own hands** are bounded by the machine, not by your judgement: one file
  and five changed lines accumulated across edits no reviewer has covered
  (operator decision, issue #388). Past the bound the write is REFUSED, so a plan
  that opens "I will just edit these three files" ends as a refusal in front of
  the operator rather than as a change. Size the edit before you promise it.
- **One role** (`run_role`) carries a single bounded job -- one file, one
  function, one verdict -- with its own acceptance criteria and stop condition.
  This is the semi-automatic path: no stages, no gates you did not ask for, no
  plan document, and the conversation stays yours. Take it at your own
  discretion when the ask is real work but not a sequence, and pass your tier as
  `complexity`.
- **The pipeline** earns its cost when the hard part is the SEQUENCE: stages that
  must run in an order, a review that must write a stamp, gates that must pass
  before a merge. "It is more than five lines" is not that reason, and neither is
  "it is a bug".

Whichever you take, say which and why in one or two sentences in the
conversation before you take it. When the ask does not fit your hands, say that
plainly and name what does fit -- a coder role now, or the pipeline if the
sequencing is what you are buying -- and let the operator choose. "I cannot do
this by hand; here is what I can do" costs one sentence, and a run the operator
did not expect costs the run.

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
- **Coder** is the only delegate that writes code -- and, with you inside a
  recorded `trivial`, the only writer that should: an orchestrator that
  classifies honestly and dispatches for judgement, then edits the files
  itself, is following no rule that names coding as the delegate's job -- so
  this one now does (issue #271). It returns an implemented change and the
  verification it ran, never advice it did not apply. Delegate when the edit
  is multi-file,
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
- The operator asked for the change himself and it fits your hands: make it, then
  report the diff and the narrow verification. Escalating a request the operator
  scoped for you is not caution -- it spends his budget to avoid a decision.
