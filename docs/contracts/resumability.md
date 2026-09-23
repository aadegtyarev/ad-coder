# Resumability contract

This contract owns preservation and recovery of every durable ad-coder state.

## Guarantees

- An operator may end a session, and a process may stop unexpectedly, without
  losing accepted work. Resume restores the orchestrator conversation/context,
  queued operator messages, task state, role and agent runs, workflow state and
  offered transitions, budgets and spend, selected profile and overrides, skill
  selection, waits, timers, wakes, and observable run history.
- The core owns one `DurableStateStore` lifecycle for sessions, tasks, roles,
  agents, runs, timers, wakes, ledgers, and workflow instances. Fronts, optional
  workflow modules, and roles use its versioned state API; none owns a private
  recovery store whose availability can determine whether a session resumes.
- Every workflow, including a user-authored workflow, declares a versioned state
  schema, checkpoint boundary, and restoration entrypoint before dispatch. The
  core validates this declaration and refuses a workflow that cannot resume its
  mutable state; disabling a workflow module never removes its stored evidence.
- State needed to continue is versioned, bounded, validated, secret-safe, and
  atomically checkpointed before success is reported or a dependent effect
  begins. Checkpoints never copy raw prompts, provider payloads, tool
  arguments, or credentials. `ProjectStore` serializes writes and preserves the
  prior valid state on a rejected or malformed update.
- A cross-entity transition commits its session, role/workflow, queue, wake, and
  ledger references as one recoverable state transaction or remains visibly
  uncommitted. Power loss or a process crash cannot report a later state without
  its required predecessor data.
- A resume reopens the same durable identities and preserves FIFO message order,
  workflow phase, role attribution, stage accounting, and ledger continuity. It
  resumes runnable work or schedules its next wake without requiring an
  operator to reconstruct context or choose a lost transition; it never silently
  starts a blank replacement or reports a partial restoration as complete.
- A checkpoint records a settled or pending context-handoff state: prior and
  target route, reason, conversion/compaction evidence, and whether a request
  was in flight. Resume completes or safely rolls back that handoff exactly once;
  it never starts a blank conversation or duplicates a model request.
- Restart recovery reconciles each in-flight model, tool, subprocess, and
  external-effect action with its durable intent and witness. A proven completed
  or settled action is not repeated. An in-flight or ambiguous action pauses
  with typed evidence and a recovery choice; it is never silently retried,
  discarded, guessed, or resolved without durable intent and a source-specific
  witness.
- An invalid, unsupported, or incomplete checkpoint leaves the original data
  intact and pauses the affected state with a typed recovery path. It never
  starts a blank replacement session, silently resets budget or profile, or
  presents partial recovery as complete.
- A journal whose complete committed transactions overlap is an ambiguity, not
  an ordering fault. Resume leaves its bytes untouched and reports a typed
  pause. Only an explicit clear may archive the exact journal and begin a
  marked fresh continuation; it never guesses which conflicting record wins.
  The machine recovery action requires the exact session identity and project
  scope, returns the archive location and continuation marker, and is never
  invoked as part of ordinary resume.
- TUI and machine resume controls expose the same restored state, pending input,
  paused ambiguity, and available action. Recovery requests are idempotent:
  repeated reopen/resume cannot duplicate a provider operation, run, wake,
  message, or external effect. Terminal records remain inspectable.

## Wait-specific recovery

`WaitService.reopen` validates a durable wait without external work. Its
reconciliation operation id is checkpointed before adapter invocation. A record
with that witness but no outcome is `reconcile_uncertain`: it cannot be replayed
by `reconcile`, and the recorded recovery action (`inspect`, `retry`, or
`replace`) directs the host's later explicit handling. See [waiting](waiting.md)
for the durable record and [wake delivery](wake-delivery.md) for notifying the
orchestrator after persisted state changes.

## Verification

Test orderly exit, power-loss-style interruption, and fatal harness failure at
orchestration, role, built-in/custom workflow, timer, queue, and external-action
boundaries; resume each from a fresh process. Assert preserved context/state/order,
no duplicate effect, typed ambiguous-action pause, corrupt-checkpoint preservation,
disabled-module evidence retention, and idempotent repeated resume.

## Related surfaces

- [Architecture](../ARCHITECTURE.md) maps durable coordination and storage.
- [Session manager](session-manager.md) owns shared session identity and recovery.
- [Task orchestration](orchestrator.md) owns task lifecycle.
- [Agent dispatch](agent-dispatch.md) owns role-run lifecycle.
- [Wake delivery](wake-delivery.md) owns timers and durable notices.
- [Public error behaviour](errors.md) owns recovery failure projection.
- [Configuration](config.md) owns durable-store selection and recoverable-state limits.
