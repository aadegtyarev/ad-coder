# Operation modes contract

Rules for operator authority in ad-coder. A violation is always blocking.

- 2026-09-12: `manual` keeps product and architecture decisions pending until an
  external operator resolves them.
- 2026-09-12: Selecting `auto` delegates operator authority to the Orchestrator;
  it resolves decisions from the task and committed project knowledge without
  asking for confirmation.
- 2026-09-12: Every automatic decision records its action, rationale, evidence,
  scope, mandate source, and affected run IDs in durable state.
- 2026-09-12: After root `decomposition_required`, auto mode may create and run
  child pipelines. A repeated decomposition in a child stops the current series
  and returns its verdicts and remaining work.
- 2026-09-12: Automatic decisions and child tasks stay within the root task's
  project scope and inherited external-effect authority; uncertain expansion
  stops instead of inventing authority.

- 2026-09-17: The orchestrator's execution WORLD is stated to it, not inferred:
  the `run_role` tool description carries three live facts assembled by the
  machine from the resolved config -- the same facts the startup banner prints.
  Which worker roles this session can delegate and the model each dispatches on
  at the default complexity; that they are the only callable names (an unrouted
  role fails with `invalid_role`); and which mode the session is in -- roles
  only, roles plus the enabled workflow modules, or direct editing when neither
  surface is registered. No hand-written routing prose anywhere may go stale:
  a session under another inventory renamed or remapped in the profile changes
  the description with it. The static knowledge about when each path and role
  is the right call is the `role-selection` skill, not prompt text.
- 2026-09-17: The execution path is decided BEFORE the work and the decision is
  recorded, then routed on (issues #263/#264). Before its first mutation the
  orchestrator must classify the task on the shipped `COMPLEXITY_RUBRIC` --
  complexity tier, execution path, the deciding property -- and state that
  answer; read-only inspection may precede it, the first edit or dispatch may
  not. Dispatch precedes the orchestrator's own first edit, and the recorded
  tier rides the dispatch: `run_role`, `run_pipeline`, `decompose_task`, and a
  stepping run's beginning take an optional `complexity` that replaces the
  declared default at the routing sink, so a pre-plan role routes on an
  assessment instead of a constant. The unclassified default is a fallback,
  never itself evidence of judgment. Measurable: on comparable work a
  delegated role makes edits, and per-role `edits` plus `timeToFirstEdit` in
  `ad-coder ledger report` show dispatch landing before the orchestrator's
  first edit.
- 2026-09-17: **Coding is the delegate's work (issue #271).** The coder role
  writes the code; the orchestrator does not edit target files outside a
  recorded `trivial` classification -- one function, no call sites, the fix
  uniquely determined -- and a delegated coder returns implemented edits, not
  advice. The statement ships in the surfaces the model actually reads
  (`prompts/orchestrator.md`, the `role-selection` skill), beside the
  classification step that already routes it: classifying honestly, dispatching
  for judgement, then writing the files yourself is the failure pattern this
  rule names. It is verified by measurement, not prose alone: per-role `edits`
  and `timeToFirstEdit` after dispatch in `ad-coder ledger report` show the
  edits under `coder`, not `orchestrator`.
- 2026-09-19: A bounded trivial edit is the one direct edit the orchestrator's
  own hands may make, and the bound is measured by the machine, not judged by
  the orchestrator (operator decision, issue #388). At most ONE file and at
  most FIVE changed lines (added + removed), accumulated across still-uncovered
  edits until a reviewer covers them; over the bound, the change is delegated
  like any other. Where the orchestrator's job is to start roles, that is
  exactly what makes the exception honest: if the edit touched code and a
  reviewer is reachable, a reviewer covers the edit -- reading the file's
  current content itself -- before the work is considered closed, and the
  verdict is recorded like any other stage verdict. When roles are not
  available (the #386 orchestrator-only collapse), the direct edit stands and
  the accumulated record with `reviewer_unavailable` entries is what that mode
  provides. The per-run record lives in durable state at
  `.ad-coder/runs/trivial-edits/<runId>.json`.

- 2026-09-20: An operator's direct request is routed to the cheapest path that
  can carry it, and the path is stated in the conversation before it is taken
  (operator decision). Preference runs the orchestrator's own hands -- bounded by
  the machine at one file and five changed lines (2026-09-19 above), so the bound
  is measured rather than argued -- then one `run_role` for a single bounded job,
  taken at the orchestrator's own discretion with no stages and no plan document,
  then the pipeline. The pipeline is earned by the SEQUENCE -- stages that must
  run in an order, a review that must write a stamp, gates that must pass before
  a merge -- never by the work being real and never by its size alone. Where the
  ask does not fit the orchestrator's hands, the answer is that sentence plus the
  two options (one role now, or the pipeline if the sequencing is what is being
  bought), offered to the operator rather than a silent escalation to the
  heaviest machinery available. Measured 2026-09-20: the operator asked the
  orchestrator to fix a small bug himself and the reply was a pipeline run --
  slower and dearer than the path he asked for, and the choice reached him as a
  bill rather than as a sentence. Narration is part of the rule, not politeness:
  the operator reads the orchestrator's replies and not its tool calls.

## Sources

The operator deliberately chooses the mode. Auto mode is itself the approval to
act, including resolving durable decisions; roles must not repeatedly ask for the
authority already delegated. Manual mode retains the explicit approval boundary.
Automatic decomposition defaults to one level so one failed child returns control.
The depth and child-count controls remain configurable.
