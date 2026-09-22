# Operator flow contract

This contract owns the operator's task-facing experience, not implementation
mechanics of routing, pausing, or background delivery.

## Guarantees

- An operator briefs intent and constraints, not files or implementation steps.
  When intent is too vague to act on, the system restates its understanding and
  asks for correction in ordinary language before spending a work budget.
- Before feature work, the system accepts the proposed budget, presents an
  evidence-backed counter-estimate, or states what bounded reconnaissance would
  cost to estimate honestly. Comparable recorded outcomes outweigh intuition.
  Work does not silently cross the agreed budget.
- The operator authorizes providers; the system derives role routing and exposes
  its evidence. The startup banner prints a distinct resolved route once per
  process, without credential variables, hosts, or a claimed built-in task tier.
- The system interrupts only for a decision the operator can make. Milestones and
  price warnings may be pushed as non-blocking notices; detailed progress remains
  pullable. A decision notice states diagnosis, options, and recovery rather
  than asking an empty question.
- Exhausted work is classified as progressing underestimate, no-progress loop,
  or work too large for the route. The first receives the bounded response its
  contracts allow; a loop stops with diagnosis; oversized work decomposes rather
  than silently escalating the whole task.
- A pause is resumable everywhere it is projected and includes phase, code,
  limit reason and value where applicable, recorded spend, and recovery action.
  A signal stop records its signal and, if present, its prior stop-request
  witness; a missing witness means only that no stop was observed.
- Interactive busy output identifies current activity, worker where applicable,
  and spend so far without repeating identical terminal lines. A pause notice is
  shown once per occurrence; JSON progress remains complete structured lines.
- The orchestrator makes material decisions and next actions visible while work
  remains active. A background result or its timer wake is summarized briefly:
  what changed, whether data or an error is available, and the intended next
  action. A progress report is never presented as task completion.
- Learned routing and ceiling corrections persist to project-local overrides,
  never silently overwrite the reusable user baseline.

## Verification

Test vague-brief clarification, all budget responses, route-banner suppression,
non-blocking milestones, wake summaries, actionable pauses, pause de-duplication,
and the three exhaustion classifications.

## Related surfaces

- [Orchestrator](orchestrator.md) owns task lifecycle and reports.
- [Autonomy](autonomy.md) owns authority and raises.
- [Pause causes](pause-causes.md) owns durable pause classification.
- [Routing calibration](routing-calibration.md) owns persisted routing evidence.
- [Tool observability](tool-observability.md) owns activity events.
