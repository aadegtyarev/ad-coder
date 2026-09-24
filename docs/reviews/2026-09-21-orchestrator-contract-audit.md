# Orchestrator contract audit — 2026-09-21 (issue #570)

## Method, base, and evidence rules

This is a factual audit of current base `a4902ec640b062f0f2ff039c455df766ee083b55`.
The landing contract was obtained exactly with:

```sh
git show origin/docs/orchestrator-contract:docs/contracts/orchestrator.md | nl -ba
```

Landing citations below use that output. Current-source citations were checked with
`nl -ba` at the cited range. The audit also inspected `control-plane.ts`,
`orchestrator.ts`, `session.ts`, `wake.ts`, `console.ts`, config validation and
resolution, stamp/gate code, and the orchestration/control-plane/config tests.
The tests include durable control-plane reconstruction, manual/auto decisions,
decomposition, wake draining, stage limits, and stamp resolution.

For absence claims, the bounded searches were run separately against named
surfaces; no single token search is treated as proof for differently named
mechanisms:

```sh
git grep -n -E 'maxContinuations|waitTimeoutMs|silentRaiseFactor|taskBudget|taskState|lane|learned.*ceiling' -- src test docs/contracts
# output: no matching lines for maxContinuations, waitTimeoutMs,
# silentRaiseFactor, or taskBudget. The learned.*ceiling pattern did match:
# docs/contracts/stage-limit-calibration.md:61 and
# src/cli/resolve-config.ts:135 (the complete returned lines were inspected
# with `nl -ba`). Those are, respectively, contract prose and a shipped
# default's explanatory comment; neither is a durable learned-state lookup or
# store. lane/taskState matches included the run-stop ownership/refusal
# implementation and unrelated state/labels, so the former is cited below
# rather than treated as absent.

git grep -n -E 'mode.?clarification|clarif.*mode|first.?use.*mode|ask.*mode' -- src test
# output: only unrelated cacheRetention/CLI mode fields and mode arguments;
# no mode-clarification implementation.

git grep -n -E 'price.?options|cheaper.?options|cheapest.?path.?options|offer.*(cheaper|price)' -- src test
# output: no matching lines.

git grep -n -E '(settings|config|profile).*(mutat|update|change)|set(ting)?[-_ ]?(config|profile)' -- src test
# output: only unrelated registry/publishing/config validation lines; no
# settings/profile mutation command.

git grep -n -E 'poll|watch|watcher|fs\.watch|interval' -- src/orchestration src/cli test
# output: product watcher implementation at
# src/orchestration/background-runs.ts:332,1012-1031 and explicit polling
# recovery at :1028; orchestrator wake delivery is separately cited below.

git grep -n -E 'correct|correction|rejected.*submission|transcript' -- src/orchestration test
# output: planner correction implementation at
# src/orchestration/plan.ts:706-724 and session retry at
# src/orchestration/session.ts:963-980, plus corresponding tests; no
# universal own-mistake event was found.
```

A negative result means absent from the named surfaces and exact patterns only;
it does not prove absence from the whole product. Verdicts are `met`, `partial`,
`absent`, `deviates`, or `unexamined`. “Smallest closure” is the smallest
additional mechanism that would satisfy the cited duty; it is not a claim that
this audit implemented it.

## 1. Code against the landing contract

Every K0–K12 clause and subclause is listed. A cited line is evidence for the
statement immediately attached to it; no ticket is used as proof.

### K0 — dictionary

- **K0 governing duty: project-meaning terms are defined before first use — met.** Duty: define each term carrying a project meaning in K0 before using it. Evidence: the landing contract states this duty (`orchestrator.md:13-15`), and the K0 dictionary supplies the definitions at `orchestrator.md:35-77` before the later clauses use them.
- **K0 governing duty: required defaults/settings statements are normative — met.** Duty: treat statements about project settings as required defaults, not constants. Evidence: the landing contract states both that it is normative and that setting statements are required defaults (`orchestrator.md:9-15`).
- **Operator — met.** Duty: the human sets tasks and grants mandate. Evidence:
  the landing definition (`orchestrator.md:37`) and operator controls in
  `src/cli/console.ts:899-917`.
- **Task — partial.** Duty: a task includes closeout, spans turns, and survives
  pauses/wakes. Evidence: durable run fields `task`, `status`, `events`, and
  `result` in `src/orchestration/control-plane.ts:60-94`; no task-level closeout
  object was found in the inspected durable run record. The bounded search
  does not establish anything about a differently named learned shape store.
  Gap: persist a task lifecycle and mandatory closeout report; it is the
  smallest closure.
- **Turn — partial.** Duty: one provider call per input/wake turn. Evidence:
  `src/orchestration/orchestrator.ts:2107-2118` and `src/cli/console.ts:880-917`
  each call the `ConversationSession.step` wrapper once; neither proves that
  exactly one provider call occurs inside the wrapper. Gap: trace or test the
  provider boundary for both input and wake turns, including resume behavior.
- **Run — met.** Duty: a started run has durable state, metrics, pauses, and
  resume. Evidence: `DurableRunRecord` and `ForegroundRunProjection` in
  `src/orchestration/control-plane.ts:60-94` and
  `src/orchestration/orchestrator.ts:716-758`; `resume` reconstructs state in
  `src/orchestration/control-plane.ts:801-849`.
- **Stage/role — met.** Duty: executor roles and run phases remain distinct.
  Evidence: role/phase model is separate in `src/orchestration/types.ts:202-221`
  and foreground phase projection in `src/orchestration/orchestrator.ts:721-727`.
- **Ceiling — partial.** Duty: model the listed ceilings and task budget.
  Evidence: stage-limit raises validate a role, reason, and positive limit in
  `src/orchestration/orchestrator.ts:243-284`, and control-plane project turn/cost
  limits are in `src/orchestration/control-plane.ts:194-223`; no task budget or
  `silentRaiseFactor` was found by the bounded search. Gap: persist intake
  ceilings and budget, including the pinned raise base.
- **Mode — partial.** Duty: landing `manual`/`auto` is distinct from execution
  surface. Evidence: `RunMode` and mode on durable/status records in
  `src/orchestration/control-plane.ts:17-25,60-66,376-397`; the execution-world
  contract still calls that world “mode” (`docs/contracts/operation-modes.md:19-29`).
  Gap: rename/render the two axes consistently; see List 2.
- **Mandate — partial.** Duty: record ground for acting without asking. Evidence:
  `DecisionRecord.mandateSource` and durable decisions in
  `src/orchestration/control-plane.ts:39-50,696-748`; tests cover manual and
  auto mandate behavior (`test/orchestrator.test.ts`, control-plane decision
  tests) only for control-plane decisions. Gap: require and test mandate evidence
  on every action that proceeds without asking.
- **Task shape — partial.** Duty: use measured size/complexity, not task text,
  for learned ceilings. Evidence: validated planner complexity is a routing
  signal in `src/orchestration/types.ts:107-115`; the audit found no cited
  durable shape-observation field or store in the inspected run/config sources.
  Gap: persist a measured shape key with observations.
- **Artefact — partial.** Duty: claims point to ledger/run/session/CI evidence.
  Evidence: verdict evidence is representable in
  `src/orchestration/types.ts:50-64` and run reports expose checkpoint/metrics in
  `src/orchestration/control-plane.ts:139-153`; evidence is not mandatory on all
  claims. Gap: require an artefact reference for every non-hypothesis claim.
- **Review stamp — partial.** Duty: only pipeline/standalone review writes the
  whole-tree stamp, not advice. Evidence: stamp checking is invoked in
  `src/cli.ts:1542-1543`; `requireStamp` is threaded through pipeline config in
  `src/orchestration/types.ts:307-318` and `src/orchestration/pipeline.ts:108`.
  The audit did not establish every standalone/advice path from these surfaces.
  Gap: one tested end-to-end rule distinguishing advice from stamp-writing review.
- **Frozen tree — partial.** Duty: stamp/gates bind to one tree and rebase
  invalidates them. Evidence: stamp checking validates the current digest in
  `src/stamp/cli.ts:9-18,70-79`; the current source does not establish rebase
  handling as an orchestrator operation. Gap: durable tree identity in readiness
  evidence.
- **Lane — partial.** Duty: own lane identity and reject another/blocked lane.
  Evidence: the record-addressed stop path verifies the recorded live pid, exact
  `--target-dir`, and the run's own command-line witness before signalling
  (`src/cli/runs-stop.ts:162-248`; verifier details at
  `src/orchestration/run-stop.ts:313-353`). A requested group stop is refused
  unless the record and live process prove the run is its own group leader;
  otherwise it names that the group may belong to the starting lane and signals
  nothing (`src/cli/runs-stop.ts:250-275`). The cross-target test asserts exit 3,
  liveness, and no stop witness (`test/runs-stop.test.ts:157-184`). This is a
  cross-lane process-stop guard, not proof of the full branch/worktree/console
  lane contract or blocked-lane rejection. Gap: validate durable
  branch/worktree/console ownership and blocked-lane state before other work
  mutations.

### K1 — named task state

- **K1.1 — partial.** Duty: exactly WIP/blocked/closed, with waiting inside WIP.
  Evidence: control-plane statuses include `queued`, `running`, `paused`,
  `awaiting_decision`, `cancelled`, `complete`, and `failed` in
  `src/orchestration/control-plane.ts:17-25`; no task-level three-state enum.
  Gap: map run outcomes to one durable task state.
- **K1.2 — partial.** Duty: no quiet stop. Evidence: wake failures leave wakes
  unhandled for a later nudge in `src/orchestration/wake.ts:196-207`, but there
  is no task-level next-action assertion. Gap: require a planned wake or decision.
- **K1.3 — partial.** Duty: name state, evidence artefact, and next action.
  Evidence: safe run status has status, verdicts, external limit, and IDs in
  `src/orchestration/control-plane.ts:376-390`; it has no required artefact/next
  action pair. Gap: add both to the status projection.
- **K1.4 — partial.** Duty: turn end does not close a task and restart resumes
  durable state. Evidence: `resume` reads and restores state in
  `src/orchestration/control-plane.ts:801-819`; wake startup scan is wired in
  `src/orchestration/orchestrator.ts:2121-2126` for durable runs. Gap: prove the
  same task-lifecycle rule for every execution path, not only durable runs.
- **K1.5 — partial.** Duty: closeout reports work, evidence, and cost, including
  failure. Evidence: run reports expose usage and checkpoint path in
  `src/orchestration/control-plane.ts:139-153`; no mandatory task-wide closeout
  schema was found. Gap: gate closure on a report containing all three.

### K2 — intake

- **K2.1 — partial.** Duty: name done, mode, shape, budget, ceilings, exclusions.
  Evidence: start input carries task, mode, and scope in
  `src/orchestration/control-plane.ts:358-363`; budget/ceilings/exclusions are not
  one intake record. Gap: persist and render that declaration.
- **K2.2 — partial.** Duty: orchestrator decomposes large work. Evidence:
  `decomposeTask` is exposed in `src/orchestration/orchestrator.ts:774-781`, and
  child specs are durable in `src/orchestration/control-plane.ts:964-1043` for
  the decomposition capability. Gap: trace and test decomposition for every
  applicable large-work intake path.
- **K2.3 — unexamined.** Duty: result-changing ambiguity is settled before work.
  Evidence inspected: the accepted rule requires restatement and correction at
  `docs/contracts/operator-flow.md:19-23`; the exact source search
  `git grep -n -E 'mode.?clarification|clarif.*mode|first.?use.*mode|ask.*mode' -- src test`
  returned only unrelated mode arguments/cache-retention text and no
  clarification implementation. This audit therefore cannot establish the
  intake gate. Gap if required: add an intake decision record and test.
- **K2.4 — absent.** Duty: agree budget before work. Evidence: the bounded search
  found no `taskBudget` or budget-agreement record; usage is reported after work
  (`src/orchestration/control-plane.ts:139-153`). Gap: require a pre-dispatch
  budget decision.

### K3 — turns and continuation

- **K3.1 — partial.** Duty: one provider call; text without a tool ends the turn.
  Evidence: console executes one `session.step` at
  `src/cli/console.ts:880-917`, but that wrapper call does not establish one
  provider call. The cited surface also does not establish that a textual report
  with no following tool call ends the turn, and no cited test proves either
  seam. Smallest closure: trace/test the provider boundary for one call, then
  assert a textual report makes zero subsequent tool invocations and settles.
- **K3.2 — met.** Duty: unfinished work continues inline or by wake path.
  Evidence: wake batches call `runTurn` in `src/orchestration/wake.ts:104-111,178-206`.
- **K3.3 — partial.** Duty: silence advances or asks for a decision. Evidence:
  pending wakes are re-read and drained in `src/orchestration/wake.ts:126-151`;
  no task-level no-motion decision is required. Gap: typed blocked outcome.
- **K3.4 — partial.** Duty: bounded continuations and blocked exhaustion.
  Evidence: `maxWakesPerTurn` is positive and bounded in
  `src/orchestration/wake.ts:113-123`; no `maxContinuations` was found by the
  bounded search. Gap: add the setting and exhaustion transition.
- **K3.5 — partial.** Duty: mode gates continuation. Evidence: transition choice
  is restricted to engine-offered transitions in
  `src/orchestration/orchestrator.ts:690-713`; control-plane decisions honor
  manual versus auto in `src/orchestration/control-plane.ts:709-748`, but the
  foreground transition path is not shown to consume `RunMode`. Gap: pass mode to
  transition authorization and persist the result.

### K4 — mode

- **K4.1 — partial.** Duty: settings-provided manual/auto, default manual.
  Evidence: `RunMode` exists and `StartRunInput` requires it in
  `src/orchestration/control-plane.ts:17,358-363`; config validation has review
  settings but no mode setting (`src/config/validate.ts:270-305`). Gap: resolve a
  project setting with default `manual`.
- **K4.2 — partial.** Duty: orchestrator sees/states mode.
  Evidence: mode is stored and exposed by `SafeRunStatus` in
  `src/orchestration/control-plane.ts:376-390`; console projection currently
  renders run lifecycle/metrics but not mode (`src/cli/console.ts:321-367`).
  The API condition is met, but operator-visible rendering is missing, so this
  clause has one overall `partial` verdict.
- **K4.3 — absent.** Duty: ask once, do not re-ask live auto. Evidence: no
  mode-clarification mechanism was found by the bounded search. Gap: durable
  first-use “asked” state and setting.
- **K4.4 — partial.** Duty: operator command changes mode and records provenance.
  Evidence: operator decision resolution is durable in
  `src/orchestration/control-plane.ts:751-784`, but no mode-change command or
  who/from/to/ground/conversation event was found. Gap: add that typed event.
- **K4.5 — absent.** Duty: orchestrator may lower, never raise, mode. Evidence:
  no mode mutation path was found by the bounded search. Gap: authorize only
  `auto` to `manual` internally.
- **K4.6 — met for run mode.** Duty: mode is durable. Evidence: `mode` is a
  field of `DurableRunRecord` and is written with the run in
  `src/orchestration/control-plane.ts:60-74,536-555`.

### K5 — delegation

- **K5.0 — partial.** Duty: announce cheapest rung and preserve role/review/pipeline
  boundaries. Evidence: trivial-edit reviewer cover is wired in
  `src/orchestration/orchestrator.ts:2026-2040`; no machine-required price
  announcement was found. Gap: record and render path choice before dispatch.
- **K5.0.1 — partial.** Duty: pipeline is earned by sequence, not size. Evidence:
  `triageControlPlaneTask` routes on contract/security/size/reversibility in
  `src/orchestration/control-plane.ts:170-185`; no durable sequence rationale.
  Gap: persist the reason.
- **K5.0.2 — partial.** Duty: bare role review is advice; pipeline/standalone
  review writes stamp; own edit gets review. Evidence: reviewer cover throws if
  no settled verdict in `src/orchestration/orchestrator.ts:1941-1961`, and stamp
  plumbing is present in `src/orchestration/pipeline.ts:108`; standalone parity
  was not established from inspected source. Gap: one integration test for all
  three paths.
- **K5.0.3 — absent.** Duty: offer cheaper options before escalation. Evidence:
  no price-options response was found by the bounded search. Gap: required path
  options before pipeline escalation.
- **K5.1 — partial.** Duty: role work stays with role except machine-bound own
  edit. Evidence: trivial guard wiring is present at
  `src/orchestration/orchestrator.ts:2026-2040`; the full one-file/five-line
  measurement is not established here. Gap: enforce and cite the write-boundary
  measurement.
- **K5.2 — partial.** Duty: dispatch carries goal, acceptance, bounds, budget,
  ceilings, shape. Evidence: `Plan` carries summary, requirements, affected files,
  and complexity in `src/orchestration/types.ts:185-199`; no complete dispatch
  envelope. Gap: require one.
- **K5.3 — partial.** Duty: narrow bounds and no rollback escape hatch. Evidence:
  affected paths are carried in `Plan` (`src/orchestration/types.ts:192-199`), but
  no width validator was established. Gap: validate dispatch width.
- **K5.4 — partial.** Duty: parallelize only independent work. Evidence: a
  relevant cross-lane process guard exists: `runs stop` verifies the run's own
  target/process witness before signalling (`src/cli/runs-stop.ts:162-248`),
  refuses an unproven shared process group because it may belong to the starting
  lane (`src/cli/runs-stop.ts:250-275`), and the cross-target test proves the
  refusal leaves the process alive (`test/runs-stop.test.ts:157-184`). That
  prevents this stop operation from crossing lanes, but it does not establish
  dispatch-time independence, version ownership, or file-conflict detection.
  Gap: add a durable lane/work-item ownership and conflict check before
  parallel dispatch.
- **K5.5 — absent.** Duty: widening scope is a new dispatch. Evidence: affected
  files are data, not a transition rule (`src/orchestration/types.ts:192-199`).
  Gap: parent-scope comparison and new dispatch ID.

### K6 — ceilings and learning

- **K6.1 — partial.** Duty: one bounded raise, prechosen failure branch, remembered
  number. Evidence: wake prompt requires one larger raise in
  `src/orchestration/wake.ts:43-51`, and validation rejects non-positive values in
  `src/orchestration/orchestrator.ts:260-284`; no remembered observation/branch.
  Gap: persist the raise observation.
- **K6.2 — partial.** Duty: configurable threshold, intake-pinned base, all enabled
  ceilings, zero disabled, budget excluded. Evidence: zero-disabled semantics and
  positive raise are explicit in `src/orchestration/orchestrator.ts:273-284`;
  `silentRaiseFactor` and intake pin are absent by the bounded search. Gap: add
  setting, pinned base, and per-ceiling measurement.
- **K6.3 — absent.** Duty: above threshold requires operator permission. Evidence:
  `RaisedStageLimits` has no permission field (`src/orchestration/orchestrator.ts:243-247`)
  and no permission path was found. Gap: require an authorization record.
- **K6.4 — partial.** Duty: exactly one silent raise then decomposition signal.
  Evidence: `decomposition_required` is a verdict literal in
  `src/orchestration/types.ts:26-36`, while wake resolution permits a raise in
  `src/orchestration/wake.ts:43-49`; no raise-count guard. Gap: durable count and
  second-exhaustion transition.
- **K6.5 — partial.** Duty: prove raise from coordinator metrics, not pause alone.
  Evidence: coordinator metrics are read in
  `src/orchestration/control-plane.ts:514-528`, while wake pauses also carry
  metrics (`src/orchestration/wake.ts:28-39`); no binding proves the raise source.
  Gap: require coordinator metric evidence on the raise.
- **K6.6 — absent.** Duty: learned value keyed by model, role/stage, shape.
  Evidence: the search does match `src/cli/resolve-config.ts:135` and
  `docs/contracts/stage-limit-calibration.md:61`; `nl -ba` shows the former
  explains the static `DEFAULT_ROLE_STAGE_LIMITS` value at
  `src/cli/resolve-config.ts:149-156`, while the latter is contract history.
  Neither is a durable learned-ceiling lookup/store: the source is a shipped
  default and the contract is prose. Gap: add durable keyed storage with
  shipped-default fallback.
- **K6.7 — absent.** Duty: second observation before rewriting learned value.
  Evidence: `docs/contracts/stage-limit-calibration.md:6-12,63-65` states the
  two-observation rule, but the inspected durable run record schema at
  `src/orchestration/control-plane.ts:60-94` has no learned-value or observation
  history field, and `src/cli/resolve-config.ts:124-156` only supplies static
  defaults. This is a contract/default, not durable learned state. Gap: require
  two matching observations in durable storage before rewriting the value.
- **K6.8 — absent.** Duty: closing words name required ceiling. Evidence: usage
  and stage metrics exist (`src/orchestration/control-plane.ts:139-153`), but no
  spoken ceiling summary. Gap: add it to mandatory closeout.

### K7 — waiting and waking

- **K7.1 — partial.** Duty: long work has wake path and activity is rendering
  only. Evidence: wake module explicitly separates state notices from activity
  (`src/orchestration/wake.ts:6-13`) and drains them in
  `src/orchestration/orchestrator.ts:2082-2126` for background state wakes.
  Gap: prove the wake/render separation for every long-work wake source.
- **K7.2 — met.** Duty: wake result reaches operator. Evidence: console renders
  started and settled wake turns in `src/cli/console.ts:779-801`.
- **K7.3 — met.** Duty: orchestrator does not poll; product watcher polls.
  Evidence: the product boundary is the named `BackgroundRunManager` watcher at
  `src/orchestration/background-runs.ts:324-332,1012-1031`, using `fs.watch` and
  explicitly directing recovery to polling at `:1027-1029`; orchestrator wake
  delivery is event-driven at `src/orchestration/orchestrator.ts:2082-2126`.
  The watcher is the product-side mechanism, not an orchestrator polling loop.
- **K7.4 — partial.** Duty: lost wake cannot look WIP; awaited item/since visible.
  Evidence: startup scan and durable pending handling are in
  `src/orchestration/wake.ts:136-151`; prompt includes coalesced notice time at
  `src/orchestration/wake.ts:38-40`, but no named awaited task condition. Gap:
  persist/render target and since time.
- **K7.5 — absent.** Duty: durable wait instrument for event/timer. Evidence:
  console has only a recovery label `wait` in `src/cli/console.ts:351-354`; no
  wait instrument was found by the bounded search. Gap: typed durable wait state.
- **K7.6 — absent.** Duty: precise durable event/timer condition. Evidence: no
  wait condition schema by the bounded search. Gap: persist event/deadline and
  object identity.
- **K7.7 — absent.** Duty: setting-bound timeout and action on expiry. Evidence:
  no `waitTimeoutMs` by the bounded search. Gap: positive setting and one-shot
  expiry outcome.
- **K7.8 — partial.** Duty: operator message interrupts wait immediately.
  Evidence: console exposes `interrupt` for active work at
  `src/cli/console.ts:899-910`; no wait state is available to interrupt. Gap:
  route input to durable wait cancellation.
- **K7.9 — partial.** Duty: fired/did-not-fire/unavailable outcomes. Evidence:
  unavailable wake state is explicitly reported in
  `src/orchestration/wake.ts:169-177`; no wait outcome enum. Gap: add all three
  outcomes plus unavailable.

### K8 — truthfulness and evidence

- **K8.1 — partial.** Duty: every run claim has path/run/line artefact. Evidence:
  verdict issues support location and evidence in `src/orchestration/types.ts:50-64`;
  fields are optional. Gap: require artefacts for claims.
- **K8.2 — met.** Duty: verdict comes from validated verdict/metric or says pending.
  Evidence: only three verdict literals are accepted in
  `src/orchestration/types.ts:26-36`, and settled verdicts are projected in
  `src/orchestration/orchestrator.ts:736-745`.
- **K8.3 — partial.** Duty: refusal/abort includes output and says unchecked.
  Evidence: safe authored error projection is implemented in
  `src/orchestration/orchestrator.ts:790-814`; no universal abort-output schema.
  Gap: require action/output on every refusal projection.
- **K8.4 — absent.** Duty: infrastructure defect needs second measurement/process.
  Evidence: no generic confirmation state by the bounded search. Gap: add a
  confirmation counter and transition.
- **K8.5 — unexamined.** Duty: read green from step list, not badge. Evidence:
  the cited quality contract requires declared gate reports
  (`docs/contracts/quality.md:67-82`), and result checks are typed in
  `src/orchestration/control-plane.ts:139-153`, but neither cited surface proves
  that CI status is read from a CI step list rather than a badge. Smallest
  closure: cite the source and test that parse/consume the CI step list and reject
  badge-only evidence.
- **K8.6 — partial.** Duty: correct own mistake openly with why. Evidence: planner
  correction wording names the validator failure and carries it into the retry
  at `src/orchestration/plan.ts:706-724` and
  `src/orchestration/session.ts:963-980`; the correction/retry behavior is tested
  in `test/orchestration.test.ts:3803-3869`. No universal event for every
  orchestrator self-correction was found by the correction/transcript search, so
  the general duty remains open.
- **K8.7 — partial.** Duty: ledger/coordinator/process tree outrank lagging record.
  Evidence: coordinator stage metrics are separately read in
  `src/orchestration/control-plane.ts:514-528`; no process-tree truth source was
  found by the bounded search. Gap: include a process witness.
- **K8.8 — partial.** Duty: mandatory task-wide cost report with remainder,
  ceilings, source, signature shape, including failure. Evidence: run usage and
  ledger-facing reports exist in `src/orchestration/control-plane.ts:139-153`;
  no task-wide mandatory closeout/remainder report. Gap: add and gate it.
- **K8.9 — partial.** Duty: declared gates, fresh stamp, and CI when available;
  unavailable CI is recorded, never substituted. Evidence: stamp requirement is
  resolved and passed to checks (`src/cli.ts:1542-1543`; `src/config/validate.ts:270-305`)
  and gate reports exist, but CI-unavailable artefact handling was not established.
  Gap: readiness evidence record.
- **K8.9.1 — partial.** Duty: prose-only relaxation is project policy, not
  orchestrator discretion. Evidence: product-change/quality documents state the
  policy; no machine classification consuming it was established. Gap: make the
  policy an input to readiness evaluation.
- **K8.10 — partial.** Duty: green PR means mergeable, gates, fresh stamp, and CI
  when available; advice is not stamp. Evidence: stamp/gate invocation exists in
  `src/cli.ts:1542-1543`; no single mergeability/readiness evaluator was found.
  Gap: compose one evidence result.
- **K8.11 — absent.** Duty: conflict blocks; rebase then reacquire evidence. Evidence:
  no rebase/mergeability operation in the inspected orchestrator surfaces and no
  matching bounded-search result. Gap: delivery operation that invalidates and
  reacquires evidence.

### K9 — authority

- **K9.0 — partial.** Duty: K9.1 defaults are settings; K9.2/K9.3 cannot be
  relaxed. Evidence: control-plane config has explicit defaults in
  `src/orchestration/control-plane.ts:194-223`, and decision mode is durable;
  no complete authority policy table. Gap: typed authority resolver.
- **K9.1.1 — partial.** Duty: dispatch within agreed budget. Evidence: project
  cost limit exists in `src/orchestration/control-plane.ts:194-223`; no agreed
  task budget. Gap: enforce intake budget.
- **K9.1.2 — partial.** Duty: silent raise within configured threshold. Evidence:
  positive raises are validated in `src/orchestration/orchestrator.ts:260-284`;
  no threshold setting. Gap: implement K6.2.
- **K9.1.3 — partial.** Duty: lower mode. Evidence: mode is durable
  (`src/orchestration/control-plane.ts:60-66`), but no mutation command. Gap:
  implement authorized lowering.
- **K9.1.4 — partial.** Duty: retry failed step within budget. Evidence: retry
  attempts and limits are durable in `src/orchestration/control-plane.ts:90-94`
  and `src/orchestration/control-plane.ts:1055-1097`; general budget authority is
  not established. Gap: centralize retry authorization.
- **K9.1.5 — absent.** Duty: merge green PR. Evidence: no merge operation found by
  the bounded search. Gap: gated merge action.
- **K9.1.6 — unexamined.** Duty: file tickets. Evidence checked with
  `git grep -n -E 'backlogBackend|backlog\\.create|authorizationSource' -- src test`:
  ticket-like backlog creation is wired at `src/cli.ts:2008` and
  `src/project-operations/run-coordinator.ts:1186-1201`, while the only
  `authorizationSource` hit is the operator decision field at
  `src/project-operations/run-coordinator.ts:66,1244-1255`. These checked
  surfaces do not establish authority to file a ticket, so this audit makes no
  filing-authority claim. Gap: identify and test the authority gate and its
  recorded mandate/result.
- **K9.1.7 — met within tool boundary.** Duty: read artefacts. Evidence: read/search
  tools are available to the role tool surface; unsafe external access is not
  inferred.
- **K9.1.8 — partial.** Duty: direct edit beyond one-file/five-line is explicit
  off by default. Evidence: trivial guard is wired at
  `src/orchestration/orchestrator.ts:2026-2040`; no configurable named bound was
  established. Gap: expose and enforce the flag/bound.
- **K9.2.1 — absent.** Duty: above-threshold raise needs permission. Evidence:
  no permission field on `RaisedStageLimits` (`src/orchestration/orchestrator.ts:243-247`).
  Gap: authorization record.
- **K9.2.2 — absent.** Duty: raise mode needs permission. Evidence: no mode mutation
  path by the bounded search. Gap: permissioned mode transition.
- **K9.2.3 — absent.** Duty: budget change needs permission. Evidence: no task
  budget mutation by the bounded search. Gap: durable budget decision.
- **K9.2.4 — partial.** Duty: cut started scope needs permission. Evidence: child
  scope is subset-validated in `src/orchestration/control-plane.ts:454-461,1014-1022`;
  no explicit scope-cut permission. Gap: record authorization.
- **K9.2.5 — absent.** Duty: profile setting change needs permission. Evidence:
  no settings mutation command by the bounded search. Gap: permissioned mutation.
- **K9.2.6 — absent.** Duty: irreversible outward action needs permission.
  Evidence: no outward-action authority gate in the bounded search. Gap: typed
  gate before publication/deploy/send.
- **K9.3.1 — partial.** Duty: never report unfinished as finished. Evidence:
  verdict union excludes success/unknown ambiguity
  (`src/orchestration/types.ts:26-36`) and reviewer exhaustion throws at
  `src/orchestration/orchestrator.ts:1955-1961` for structured verdicts. Gap:
  enforce the same unfinished-state guard on every outward status/report path.
- **K9.3.2 — partial.** Duty: never exceed direct-edit bound while flag off.
  Evidence: guard wiring exists (`src/orchestration/orchestrator.ts:2026-2040`),
  but configurable bound evidence is incomplete. Gap: machine-measured bound.
- **K9.3.3 — partial.** Duty: never work another/blocked lane. Evidence: the
  record-addressed stop command refuses a process whose argv does not carry the
  requested target directory or run witness (`src/cli/runs-stop.ts:223-248`,
  `src/orchestration/run-stop.ts:313-343`), and refuses `--group` unless the
  recorded/live group is the run's own pid (`src/cli/runs-stop.ts:250-275`).
  `test/runs-stop.test.ts:157-184` proves the cross-target refusal does not kill
  the other process. This guard covers cross-lane process stopping only; it does
  not establish branch/worktree/console ownership or blocked-lane rejection for
  general work. Gap: make those ownership and blocked-state checks durable and
  require them before work mutation/dispatch.
- **K9.3.4 — met for this audit.** Duty: do not edit contract to fit behavior.
  Evidence: the current intended modifications are this audit document,
  `CHANGELOG.md`'s real entry, and the reviewer-appended `docs/reviews/stamps.log`;
  none edits source or contract files. Landing K11.1 says code is corrected
  rather than contract (`orchestrator.md:389-390`).

### K10 — settings

- **K10.1 — partial.** Duty: default < profile < project < launch. Evidence: review
  settings parse defaults/strict values in `src/config/validate.ts:174-205,270-305`;
  no complete layered resolver was established. Gap: ordered source metadata.
- **K10.2 — partial.** Duty: absent defaults; unusable present file refuses.
  Evidence: parser documents absent-file defaults and rejects empty or malformed
  input in `src/config/validate.ts:174-186,188-205` for the inspected parser.
  Gap: prove the same refusal/default rule across every settings source and
  parser entry point.
- **K10.3 — partial.** Duty: effective value names source. Evidence: config contract
  promises source visibility, but parser returns values in
  `src/config/validate.ts:201-205`; source is not part of that result. Gap: return
  and render source.
- **K10.4 — absent.** Duty: setting change asks profile/project scope and blast
  radius. Evidence: no settings mutation UI/command by the bounded search. Gap:
  scoped mutation flow.
- **K10.5 — partial.** Duty: feature flags default on and explicit off. Evidence:
  provider admission and review defaults exist in `src/config/validate.ts:174-180,270-305`;
  no orchestrator feature-flag table. Gap: resolve each capability explicitly.

### K11 — contract and memory discipline

- **K11.1 — met for this audit.** Duty: audit divergence and fix code, not contract.
  Evidence: this document cites the landing contract without editing it and reports
  source gaps; landing rule is `orchestrator.md:389-390`.
- **K11.2 — met.** Duty: read current-base code, not ticket titles. Evidence: all
  implementation citations above came from current files; tickets are not evidence.
- **K11.3 — partial.** Duty: durable mandates, learned ceilings/evidence, outcomes.
  Evidence: mandate and outcomes are durable in
  `src/orchestration/control-plane.ts:39-94`; the stage-limit contract and
  static defaults do contain learned-ceiling references (`docs/contracts/stage-limit-calibration.md:6-16`;
  `src/cli/resolve-config.ts:124-156`), but the inspected durable record has no
  learned-ceiling observation history. Gap: add learned observation records.
- **K11.4 — partial.** Duty: long-lived decisions live in repository documents.
  Evidence: the governing material is in `docs/contracts/` and the landing
  contract, not this conversation, for the inspected decisions. Gap: inventory
  all long-lived decisions and verify each has a repository document.

### K12 — exclusions

- **K12 provider/billing — met as scope.** Provider behavior and billing were not
  claimed; provider availability is represented only as an external limit in
  `src/orchestration/control-plane.ts:52-58,900-913`.
- **K12 GitHub mechanics — met as scope.** Platform branch protection/API behavior
  was not claimed; mergeability remains an unexamined external input.
- **K12 delivery surface — partial.** Duty: PR/merge/stamp surface is project or
  profile policy and K8 applies on the chosen surface. Evidence: `requireStamp`
  is configurable and threaded (`src/config/validate.ts:270-305`;
  `src/orchestration/types.ts:307-318`); no delivery-surface evaluator. Gap:
  resolve policy into readiness.
- **K12 role internals — met as scope.** Role/model internals were not judged;
  only dispatch interfaces and evidence were audited.
- **K12 model choice/routing — met as scope.** Routing is represented by the
  separate `PipelineRouting` type (`src/orchestration/types.ts:238-245`) and was
  not treated as a contract behavior finding.

## 2. Text against accepted rules: true precedence conflicts only

### Execution-world meaning of “mode” — operator ruling required

Landing contract, complete relevant sentence:

> “The word is taken: in `docs/contracts/operation-modes.md` "mode" names the **execution world** (roles only, roles plus modules, direct editing). This contract uses "mode" for the `manual`/`auto` axis alone, and calls the execution world the **surface**.” (`origin/docs/orchestrator-contract:docs/contracts/orchestrator.md:54-58`)

Accepted operation-modes contract, complete relevant sentence:

> “The orchestrator's execution WORLD is stated to it, not inferred: the `run_role` tool description carries three live facts assembled by the machine from the resolved config -- the same facts the startup banner prints. Which worker roles this session can delegate and the model each dispatches on the default complexity; that they are the only callable names (an unrouted role fails with `invalid_role`); and which mode the session is in -- roles only, roles plus the enabled workflow modules, or direct editing when neither surface is registered.” (`docs/contracts/operation-modes.md:19-29`)

These require different naming/rendering actions: the landing text requires
`mode` to mean manual/auto and the execution world to be `surface`; the accepted
contract requires the execution world to be stated as `mode`. This List 2 entry
requires the operator's ruling; no ruling is available or made by this audit.
Resolution belongs to part 2/the lane, not this audit. No other true incompatible
instruction was established.

Polling and `review.require-stamp` are deliberately deleted from this list:
the landing contract assigns polling to the product watcher, while the operator-
flow wording describes a completion surface; and config explicitly makes stamp
requirement a project policy (`on`/`off`/`auto`). Those are not incompatible
required actions after the landing contract's policy qualification is read.

## Checks, boundary, and unknowns

Required commands were run after the rewrite:

- `bun run typecheck` — output `$ tsc --noEmit`; **exit 0**.
- `bun run check` — output `$ biome check src test scripts evals` and
  `Checked 458 files in 393ms. No fixes applied.`; **exit 0**.
- `bun run check:docs` — output `$ bun run scripts/check-docs.ts` and
  `documentation readability valid: architecture 2000 words (whole-document audit due)`;
  **exit 0**.
- `bun run check:release` — output `$ bun run scripts/check-release.ts` and
  `release metadata valid: 0.170.0 (2026-09-21, local clock)`; **exit 0**.
- `git diff --check` — no output; **exit 0**.

Only `docs/reviews/2026-09-21-orchestrator-contract-audit.md` was changed by
this rewrite. Pre-existing `CHANGELOG.md` and `docs/reviews/stamps.log` changes
were not modified. No contract, source, test, version, git, issue, or PR state
was modified.

Unexamined clauses remain K2.3, K9.1.6, and external/live parts of K8.7,
K8.9, K8.10, K8.11, and K12 GitHub mechanics: current repository source cannot
prove a live process tree, CI availability, mergeability, or provider billing.
K7.3 is `met` for the watcher/orchestrator boundary, and K8.6 is `partial` for
the tested planner correction path; neither is unexamined. Other gaps are
marked `unexamined`, `partial`, or scope-limited above rather than asserted as
facts.
