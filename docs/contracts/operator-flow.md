# Operator flow contract

How the operator works with ad-coder, stated as rules rather than as a feature
list. This is the product's UX: everything else exists to make this shape
possible.

The operator does not read the code to brief the work, does not name files, and
does not decide questions the system has more information about than they do. A
pause is worth their attention only when they can decide something the system
cannot.

## The brief

- 2026-09-16: A task arrives as intent and constraint, not as an implementation
  plan. "I want the orchestrator to be able to save the routing it derived, and
  I want to see later where each cell came from" is a complete brief. Naming the
  file to edit, the function to call, or the place to look is the system's job,
  not the operator's.
- 2026-09-16: When the brief is too vague to act on, the system states the task
  back as it understood it and asks for correction. It does not ask the operator
  to restate the brief in more technical terms. A misunderstanding surfaced
  before any model spends a budget is cheap; the same misunderstanding surfaced
  in a review is not.

## The budget is agreed before the work starts

- 2026-09-16: Before running a feature, the system and the operator agree what it
  may cost. The operator may name the figure ("I am willing to spend $8-10 on
  adding a TUI"). The system answers with one of three things, and never with
  silence:
  - **acceptance** -- the estimate fits and the work starts;
  - **a counter-estimate with evidence** -- "we have done features of this shape
    for about $15; I may not fit in $10", naming what that evidence is;
  - **an admission of ignorance** -- "I cannot support an estimate for this
    shape; here is what I would spend to find out."
- 2026-09-16: An estimate is grounded in recorded outcomes where any exist -- what
  comparable accepted work actually cost, not what a model feels about the task.
  Where no comparable evidence exists, the system says so rather than producing a
  confident number from nothing.
- 2026-09-16: To estimate, the system may first spend a small bounded amount
  looking at the project -- directly or through a subagent -- and says up front
  what that reconnaissance will cost. Estimating blind is not a virtue.
- 2026-09-16: Within the agreed budget the system runs as it sees fit: how many
  attempts, which models, what gets retried is its decision. Crossing the budget
  is not.

## Routing is proposed, evidenced, and correctable

- 2026-09-16: The operator names providers and authorizes them. Deriving which
  model serves which role at which complexity is the system's job, seeded from
  published evidence (see AGENTS.md, "Model routing").
- 2026-09-16: Every routing cell carries the evidence that decided it. A matrix
  nobody can audit later is a matrix nobody can correct.
- 2026-09-16: The system persists a routing it derived into the project-local
  override itself. Requiring the operator to hand-edit a profile to apply a
  recommendation the system just made is not a workflow.
- 2026-09-20 (issue #501): The startup banner is one line, printed once per process: the selection, the provider(s)
  the routed models resolve to, and the role->model ladder. One console session re-resolves per role delegation, and
  the same banner stacking twenty times read as twenty milestones; a repeated identical banner is a defect, not
  emphasis, while a genuinely different routing prints once more. The banner names no credential variable and no host
  -- plumbing, not a decision -- and no built-in default complexity: the orchestrator classifies each brief and routes
  on that tier.

## Interruptions are decisions, not notifications

- 2026-09-16: The system stops for the operator only when the operator can decide
  something it cannot. "The stage ran out, shall I raise the limit?" is not such
  a moment: the only available answer is yes, and the system has more information
  than the operator does. It raises it and records the correction.
- 2026-09-16: A milestone is informational, not an interruption. A front may
  push milestones by default -- a run started or finished, a cost spike crossing
  a threshold, a transfer settling -- but a milestone arrives, is visible, and
  never blocks a turn or a run or demands a reply. Progress itself (steps, tool
  calls, stage transitions) stays pull-only through status/summary and is never
  pushed. Only a decision push is an interruption, and it always carries the
  diagnosis and the choices, never an open question.
- 2026-09-16: When it does stop, it reports a diagnosis rather than a question.
  "Planner on this model is not progressing: nine turns, the same three files, no
  new tool targets" is actionable -- change the model, restate the task, abandon
  it. "Raise the limit?" is not.
- 2026-09-16: An exhausted stage has at least three causes and they are not
  interchangeable. An **underestimate** (work is progressing, scope is closing)
  is raised and recorded. A **loop** (turns continue, progress does not) stops
  with a diagnosis. **Work too large for this model** (progress is real but scope
  keeps widening) is decomposed and dispatched as slices -- which keeps a cheaper
  model usable instead of escalating the whole task.
- 2026-09-17: A stage pause is a resumable state everywhere it is projected, and
  it reaches the orchestrator like a completed run does (issue #261). A run the
  coordinator records as `paused` is never projected as `failed` with
  `internal_failure` and `recovery: none`: the report carries the pause record
  (phase, code, recovery action in words), the limiting reason and its limit
  (`limitReason`, `limit`), and the metrics of what the run actually spent,
  paused attempt included. The background-run status, event stream, and result
  surface all carry it, so whichever surface the orchestrator already polls for
  completion reports the pause -- it cannot raise a ceiling it never hears
  about.

- 2026-09-20 (issue #479): A pause names WHICH signal ended the run and whether
  anything asked for it. The record a run's own process writes when a signal
  ends it (the standalone role checkpoint) carries the signal
  (`pause.signal`) and, when a `runs stop` request asked for the stop, that
  request (`pause.stopRequest`, read from the stopper's witness file and
  consumed by the write) -- because an externally stopped run is not the same
  fact as the run's own failure, and durable state is the only place that
  distinction survives the process. The victim cannot always write it: a
  process that dies before reaching the write leaves `status: "running"` and
  `pause: null` with no diagnostic at all (measured 2026-09-20, on an
  orchestrator's own delegate), and in exactly that case the stop-request
  record the stopper wrote BEFORE its first signal
  (`<target>/.ad-coder/runs/stop-<runId>.json`) is the only witness that this
  was a stop and not a fall-over. The same record's absence is not a crash
  and not a verdict on the run's health: it says "nothing asked this run to
  stop", and a closeout that finds no witness reports that, not an error. A
  stage-limit pause carries neither a signal nor a stop request: a limit is
  nobody's signal.

- 2026-09-17 (issue #208): A stage that exhausts a ceiling on progressing work
  is resumed at a LARGER ceiling, by the orchestrator, without the operator.
  The coordinator refuses a resume at an unchanged number, so the raise is not
  optional politeness -- it is the only legal way to continue, and
  `resume_pipeline` carries the role, the exhausted reason and the new value.
  A raise names one role and one reason: raising every ceiling because one was
  hit discards the evidence the pause produced.

- 2026-09-19 (issue #387): The system's own wake obligation completes this: a
  state notice (`paused`, `failed`, `operator_attention`, `timed_out`,
  `completed`, `stage_changed`) is a durable wake record that starts an
  orchestrator turn so the system raises and records the correction itself,
  without the operator or a watching coordinator; activity notices stay
  rendering-only.

- 2026-09-20 (issue #451): The "one bounded raise, then decompose" rule is
  round-level (`docs/CHECKPOINT.md:200`), while `stage-limit-calibration.md`
  governs stage-time ceilings. A second blocking verdict on a slice is an
  escalation signal, not another identical round: the run settles not-approved
  carrying it, regardless of the round cap. A role may submit
  `decomposition_required` to ask for decomposition, distinctly from
  `changes_requested`. The signal is a bounded, typed record on the run result
  (`required`, `reason` = `role_requested` | `blocking_verdicts`,
  `blockingVerdicts`) and on the status projection the orchestrator reads, so
  the orchestrator can act on it without the operator. The fail-not-raise rule
  for ceiling grows stays as the 2026-09-17 entry wrote it. Future work, not in
  this entry: the orchestrator cutting a slice into children, raising the rung,
  and merging small adjacent follow-ups into one slice.

- 2026-09-20 (issue #451): CUT: a settled run carrying the escalation signal is
  cut by the orchestrator -- one child per `blocker`/`major` issue of its last
  `changes_requested` verdict, at most four; host-supplied children take
  precedence; when nothing is derivable the run pauses with a deferred decision
  naming why, and `decomposition.children` is never `invalid_config`. This
  stops a twice-blocked slice from round-tripping as another identical run
  instead of being cut. CONSOLIDATE: several small adjacent follow-ups merge
  into one -- same kind and kind-destination, evidence paths equal or sharing a
  directory prefix, two to five members, each with at most two distinct
  evidence paths, and only when the merged item still passes the validation it
  will face at save, configured evidence limit included; otherwise the group is
  left exactly as it was, never partially merged. This is the mirror of the cut
  and the same automatic decision, not the operator's: it stops a run's
  scattered-but-related follow-ups from surfacing as a pile of near-duplicates.
  RAISE: the run's failed tier is readable from its persisted classification in
  `PipelineResult.complexity`, but acting on it needs a per-dispatch tier the
  control plane does not carry, and the routing ladder's steps beyond the first
  are future work (`docs/contracts/config.md`, 2026-09-19 entry); the mechanism
  is tracked as issue #460 and is not yet wired, so the rung is not claimed as
  raised while no mechanism raises it. Known remaining gaps where a role's
  signal still does not reach a decision: issues #461 and #462.

- 2026-09-20 (issue #501): The busy console line names what the turn is doing -- the activity subject, the worker once
  a second role has worked, and the spend so far -- updated in one in-place line, instead of a bare "still running"
  that stacked a fresh line per heartbeat. Identical progress is never rewritten, and machine mode stays structured:
  JSON progress events remain complete lines, never drawn in place.

- 2026-09-20 (issue #501): A pause notice carries the recovery action in words and is printed once per occurrence. The
  same pause reaches the terminal through more than one path -- a re-delivered background event, and the result path
  that drove the run -- and printing it twice reads as a new decision where the operator already made one, so the
  first renderer of an occurrence wins. The line still says the phase, the code, and that the run is resumable, not
  failed; a payload that fails validation degrades to "unknown", never an invented limit.

## What the system learns without being told

- 2026-09-16: Stage budgets, like model choice, are corrected by what actually
  happened. A ceiling that a role on a model keeps exhausting for a shape of task
  is recorded so the next run starts from the better number.
- 2026-09-16: Corrections persist to the project-local override, never silently
  to the user baseline. The reusable base is the operator's, and a single
  project's evidence does not rewrite it.
