# Resumability contract

This contract owns preservation and recovery of every durable ad-coder state.

## Guarantees

- An operator may end a session, and a process may stop unexpectedly, without
  losing accepted work. Resume restores the orchestrator conversation/context,
  queued operator messages, task state, role and agent runs, workflow state and
  offered transitions, budgets and spend, selected profile and overrides, skill
  selection, waits, timers, wakes, and observable run history.
- Each mutation needed to continue work is checkpointed atomically before its
  success is reported or a dependent action starts. Checkpoints are versioned,
  validated, bounded, and secret-free; raw prompts, provider payloads, tool
  arguments, and credentials are not copied into them.
- A resume reopens the same durable identities and preserves FIFO message order,
  workflow phase, role attribution, and ledger continuity. It resumes runnable
  work or schedules its next wake without requiring an operator to reconstruct
  context or choose a lost transition.
- Restart recovery reconciles each in-flight model, tool, subprocess, and
  external-effect action with its durable intent and witness. A proven completed
  action is not repeated. An ambiguous action pauses with typed evidence and a
  recovery choice; it is never silently retried or discarded.
- An invalid, unsupported, or incomplete checkpoint leaves the original data
  intact and pauses the affected state with a typed recovery path. It never
  starts a blank replacement session, silently resets budget or profile, or
  presents partial recovery as complete.
- TUI and machine resume controls expose the same restored state, pending input,
  paused ambiguity, and available action. Resume is idempotent: repeated resume
  requests do not duplicate a run, wake, message, or external effect.

## Verification

Test orderly exit and forced interruption at orchestration, role, workflow,
timer, queue, and external-action boundaries; resume each from a fresh process.
Assert preserved context/state/order, no duplicate effect, typed ambiguous-action
pause, corrupt-checkpoint preservation, and idempotent repeated resume.

## Related surfaces

- [Session manager](session-manager.md) owns shared session identity.
- [Task orchestration](orchestrator.md) owns task lifecycle.
- [Agent dispatch](agent-dispatch.md) owns role-run lifecycle.
- [Wake delivery](wake-delivery.md) owns timers and durable notices.
- [Public error behaviour](errors.md) owns recovery failures.
