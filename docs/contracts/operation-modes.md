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

## Sources

The operator deliberately chooses the mode. Auto mode is itself the approval to
act, including resolving durable decisions; roles must not repeatedly ask for the
authority already delegated. Manual mode retains the explicit approval boundary.
Automatic decomposition defaults to one level so one failed child returns control.
The depth and child-count controls remain configurable.
