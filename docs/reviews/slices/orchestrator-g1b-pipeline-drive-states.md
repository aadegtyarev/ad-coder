# Slice audit: orchestrator guarantee `orchestrator.md:9-12` (pipeline-drive states)
Audit base: 746a55d6cfb177bcefb7046fcd005d4176f3ce2b, date 2026-09-24.
Residual from `orchestrator-g1-task-states.md`: the same guarantee was not verified for
`runPipeline`/`WorkflowState` (src/orchestration/types.ts:875) or for background runs beyond
BgRun's internal `closed` flag (src/orchestration/background-runs.ts:341 today).
Rule text (current lines, docs/contracts/orchestrator.md:9-12): "- An accepted task is exactly
one of WIP, blocked, or closed. Waiting is WIP. There is no quietly stopped state: the
orchestrator can name its state, durable evidence, and next event or action. A new message,
restart, or context boundary does not close an unfinished task."

## Verdict
violating — narrowly, on the background-run surface: a detached run whose worker dies in the
pre-claim window leaves a durable record at `lifecycle: "requested"` forever. The state is
*named*, but its named next action (`recovery: "wait"`) never happens, no wake ever fires,
`result()` throws `not_terminal`, and `load()` deliberately never marks it abandoned — a
record that says "in flight" while nothing will ever advance it. This is the "quietly stopped
state" the rule forbids. The rest of the pipeline-drive surface conforms: coordinator pauses,
awaiting-decision, closeout and terminal outcomes are all named, durable, and carry a next
action; the pause path and abandoned-reload path are test-proven.

## Checks executed (4 commands beyond navigation/greps; the `bun -e` repro's first attempt
failed on a wrong state-file path and is not evidence)
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` + grep of the rule | `746a55d6...`, rule found at orchestrator.md:9-12 |
| `bun test test/background-runs.test.ts` | 25 pass, 0 fail, 146 expect() calls, exit 0 (1.44s) |
| `bun test test/orchestrator-wake.test.ts` | 19 pass, 0 fail, 472 expect() calls, exit 0 (1.16s) |
| `bun -e` repro (stateDir under os.tmpdir, not the repo): `startDetached` with a host that
  resolves without claiming, owner manager closed, second manager reopens from disk | printed
  `statusAfterReconnect: { lifecycle: "requested", recovery: "wait", metrics: {steps:0,...} }`,
  `resultThrows: "not_terminal"`, `pendingWakesForRun: []`, durable record lifecycle
  `"requested"` |

## Evidence read
Conforming paths — state, evidence, next action are named and durable:
- `src/orchestration/types.ts:838` — `WorkflowPhase` is an exhaustive literal set ending in
  `"done"`; `types.ts:880-884` — `phase` is the phase the NEXT `step` runs and `done`/`approved`
  are set only by `applyTransition` on a `stop` edge; `types.ts:641` — the terminal outcome is a
  closed literal `"approved" | "decomposition_required"`. No unnamed resting phase exists.
- `src/project-operations/run-coordinator.ts:59` — `CoordinatorPhase` is an exhaustive literal
  (`workflow|follow-ups|decisions|closeout|complete`); the checkpoint is persisted via
  `VersionedState` (line 642, 673), so a restart reopens the same named phase.
- `src/project-operations/run-coordinator.ts:100-109` — a stage failure records a durable
  `pause {phase, code, action, ...}` inside the checkpoint; `run()` at 1401-1403 exits with
  `status: "paused"` and returns that checkpoint — the blocked equivalent, with the action in
  words. `src/orchestration/types.ts:731-750` — the pause record is fixed code-built phrases
  (`phase/code/action`), bounded, never model content.
- `src/orchestration/background-runs.ts:543-553` — a `PipelinePauseError` sets lifecycle
  `"paused"` and copies the pause verbatim into the entry and event; `:164-168` — a paused run
  reports through the same outcome surface. `statusOf` (:873-890) gives every non-terminal
  attention/paused run `recovery: "resume_pipeline"` + a concrete detail line
  (`RESUME_PIPELINE_DETAIL`, :99-110) naming the console and the `resume_pipeline` action.
- `load()` abandonment (src/orchestration/background-runs.ts:1132-1161): an interrupted,
  non-paused, non-`requested` record with a stale lease reloads as `failed` with
  `recovery: "resume_pipeline"` — a worker that dies mid-run is NOT quietly stopped.
  Test-proven: `test/background-runs.test.ts:1034` "an abandoned interrupted run reloads with
  the recovery detail and stays wakeable (issue #430)" and `:776` "a durable pause survives a
  worker exit as a resumable record, not an abandonment".
- `timeout()` (:862-876) names `timed_out` with `recovery: "resume_pipeline"`; `cancel()`
  (:753-757) is a deliberate terminal transition — "closed" is a decision, never a silent stop.
- `operator_attention` (:556-573) is non-terminal with no pause payload, but it IS in
  `WAKE_INITIATING_LIFECYCLES` (:33-42, "a state the orchestrator has to decide on") and
  `statusOf` gives it `resume_pipeline` — next event exists, so it is not a quiet stop.
- Restart/new-message: the durable record is reloaded by `load()` (:1126+), wakes survive
  reload (`markWakesHandled` mutates the durable file, :895-920), and nothing in the restart
  path closes an unfinished run. Wake coverage is test-proven in
  `test/orchestrator-wake.test.ts` (19 pass).

Violating path — the pre-claim window:
- `src/cli.ts:2666-2705` — the production `createBackgroundHostLauncher` resolves its promise
  on `spawn` (OS accepted the process), NOT on the worker claiming; a worker that dies between
  spawn and `claim()` (crash, bad env) is indistinguishable from a pending launch.
- `src/orchestration/background-runs.ts:1136-1139` — `load()`'s abandoned branch explicitly
  excludes `lifecycle === "requested"` (no comment records why; a claim race is my inferred
  reason), so an unclaimed record is never reaped; `maxRunMs` is armed only in `launch()`
  (:508-509), i.e. after a claim; and `WAKE_INITIATING_LIFECYCLES` (:33-42) excludes
  `requested`/`started` by design, so no turn ever starts for it.
- Consequence (executed repro above): the durable record keeps saying `requested` with
  `recovery: "wait"` while nothing will ever advance it — precisely a record whose named next
  event is unreachable. An operator who inspects can `cancel()` it (requested is non-terminal,
  so cancel works), but no surface prompts that; `result()` says only `not_terminal`.
Boundary note, not a finding: `maxRunMs` defaults to 0 (:220), so an in-process executor that
never settles stays `started` with a fresh lease indefinitely — but the work IS in flight (WIP
by the rule), a liveness cost, not a state-naming violation.

## Pending decision (block refactoring this surface until decided)
1. Close the pre-claim window: reap an unclaimed `requested` record past a bounded
   claim-deadline (`load()` marks it `failed`, `recovery: "resume_pipeline"`), OR amend the
   contract to name `requested` a WIP sub-state with a required bounded next event. Either is
   contract-level: needs an operator decision plus characterization tests
   (`test/background-runs.test.ts:1034` is the seam) before any implementation.

## Unverified
- I did not execute the real CLI end-to-end (`ad-coder background start/status`); the stuck
  state is established by an in-process repro against the real manager, not the binary. The
  pre-claim death in production is argued from src/cli.ts:2666-2705 reading, not witnessed.
- No adversarial check that a malformed durable record (e.g. lifecycle `"stopped"`) is rejected
  by `parsePersistedEntry`'s strict reader rather than silently adopted; the strict-reader
  existence (:1558+, `LIFECYCLES` list) suggests rejection, but I did not test a bogus literal.
- Whether any host-side watchdog outside background-runs.ts/cli.ts protects the pre-claim
  window I could not establish; I did not trace the wake pump wiring line by line either.
- Command count: 4 executed beyond navigation/greps (the repro twice — first attempt errored).
