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

## Interruptions are decisions, not notifications

- 2026-09-16: The system stops for the operator only when the operator can decide
  something it cannot. "The stage ran out, shall I raise the limit?" is not such
  a moment: the only available answer is yes, and the system has more information
  than the operator does. It raises it and records the correction.
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

## What the system learns without being told

- 2026-09-16: Stage budgets, like model choice, are corrected by what actually
  happened. A ceiling that a role on a model keeps exhausting for a shape of task
  is recorded so the next run starts from the better number.
- 2026-09-16: Corrections persist to the project-local override, never silently
  to the user baseline. The reusable base is the operator's, and a single
  project's evidence does not rewrite it.
