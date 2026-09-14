# Backlog

Only unresolved work belongs here. Current behavior is in
[ARCHITECTURE.md](ARCHITECTURE.md); future design is in
[ROADMAP.md](ROADMAP.md).

## Current priority

- [high] **Reserve stage capacity for synthesis and verification**: expose
  remaining cumulative time/model/tool/token/cost budgets to the active role
  after tool turns. Input-token and four-turn reserves are delivered, and final
  requests expose no tools after closeout. The remaining work is a concise live
  budget projection for the role and activity stream.

- [high] **Bound Researcher network fallbacks and expose deadlines**: dogfood run
  `590cb775-8e9d-43a1-944b-4cc9873b9538` spent 60s and 120s in opaque failed
  `Run` operations while only heartbeat activity was visible. Apply per-request
  connect/read ceilings, remember failed domains for the run, and show the target
  plus remaining deadline in activity events.

- [high] **Make launcher cancellation process-group-safe**: launcher integrations
  must kill their full `npm -> sh -> bun` process group. The CLI itself maps
  SIGINT/SIGTERM to a resumable role pause and closes its in-process resources;
  ad-coder has no provider child process to signal, and cannot enforce the parent
  harness's process policy.

- [high] **Portable economic profile store** (`src/user-profile/`, `src/cli.ts`):
  add a private user-level store for named inventories, calibrated routing,
  append-only confirmed price/context/limit history, and observed subscription
  capacity ranges. Add secret-free versioned export, preview, and atomic import
  with explicit merge/replace conflict handling. Expose current values and
  provenance through the headless API and `config show`; keep credentials in the
  existing credential store.

- [high] **Portable project calibration snapshot** (`src/profiles/`,
  `.ad-coder/`): layer a bounded anonymous current economics snapshot and
  project routing override over the user baseline, retaining per-cell provenance.
  Never commit account identifiers, exact private activity timestamps, raw
  provider responses, or full user history.

- [high] **Calibrate role routing by accepted-result efficiency**
  (`src/profiles/`, `docs/cost-economics.md`): run like-for-like tasks through
  Luna, Terra, and Sol where supported, charging repair and re-review to the
  originating choice. Compare final gate quality, escaped findings, rounds,
  duration, fresh/cache/output/reasoning tokens, and provider cost before
  changing configurable `(role, complexity)` defaults. Quality gates remain
  identical for every routing choice.
  Build the first calibration corpus inside this repository (`evals/fixtures`,
  `evals/tasks`, `evals/runner`, `evals/scorers`) with versioned hidden defects,
  machine gates, gitignored raw outputs, and durable aggregate conclusions in
  `docs/model-calibration.md`.
  Add automatic layered resolution after the corpus stabilizes: a
  user-local calibrated inventory as the reusable provider/account baseline,
  then an explicit `.ad-coder/` project override with per-cell provenance in
  `config show`. Project observations must never silently rewrite the user base.

- [high] **Explicit durable-run inventory migration** (`src/inventory/`,
  `src/project-operations/`): named atomic registry/profile selection and safe
  inspection are delivered. Add an explicit audited action for moving a paused
  provider-limited run to another inventory; ordinary resume must never switch
  provider/model identity implicitly.

- [high] **Narrow role inputs at the tool and prompt boundaries**
  (`src/project-tools/`, `src/runner/`, `prompts/`, `src/orchestration/`): measure
  which tool fields, result bytes, prompt sections, and repeated handoff data each
  role actually consumes. Return bounded task-specific tool projections, keep
  role prompts focused on judgment, and supply scoped plan/findings/diff/contract
  context with a visible full-context fallback. Prove savings with comparable
  dogfood runs and unchanged Reviewer/gate outcomes. Coder and Reviewer now use
  focused-first test guidance and avoid repeated broad reconnaissance; bounded
  Planner reconnaissance now batches reads and fails closed on unresolved gaps.
  `search_project` now supplies a ranked, byte-bounded task projection including
  tracked modifications and untracked additions. Comparative dogfood and broader
  incremental cross-round handoff projections remain. Every stage now reports separate
  system-prompt, handoff-prompt, tool-definition, and total assembly bytes.
  `read_project` now batches up to eight exact line slices under one aggregate
  ceiling; comparative dogfood and incremental cross-round handoffs remain.

- [high] **Complete workflow-module extraction** (`src/workflows/`,
  `src/orchestration/`, `src/cli/resolve-config.ts`): conversational activation
  and tool removal are delivered, but the built-in pipeline's role/config
  resolver, prompts, graph implementation, and headless core still live in shared
  orchestration modules. Move that whole bundle behind the workflow manifest so
  a disabled module is not constructed while seeding a general conversation.

- [next] **Auditor role and periodic project-health dispatch**
  (`src/orchestration/`, `src/project-tools/`): wire the shipped cold-read Auditor
  prompt over `explore_project`. Persist drift counters and last-audit state,
  trigger at configurable size/churn/cross-boundary/release thresholds, and put
  evidenced violations, missing-contract proposals, and decomposition candidates
  through durable backlog/operator-approval paths. Then add the separate
  characterization-test-pinned refactor executor described in ROADMAP. Raw line
  counts never authorize refactoring.

- [next] **Incremental-context dogfood evidence** (`docs/cost-economics.md`): run
  a like-for-like multi-round scenario for the delivered focused handoff policy.
  Record verdict/gate quality, latency, turns, token categories, provider cost,
  selected/read files, diff sizes, strategy, and fallback reason. Do not claim
  savings until the comparison is measured. Scoped Planner reconnaissance and
  stable per-finding response identifiers remain follow-on work.

## Security and runtime boundaries

- [high] **Real tool sandboxing** (`src/runner/`): `targetDir` is only a
  starting cwd. Add out-of-process filesystem/network isolation for untrusted
  tasks; tool allow-lists are not a host sandbox.
- [low] **Result-content handling** (`src/runner/role-runner.ts`): document or
  narrow `RunRoleResult.result`, which can contain prompt/response detail and
  must not be returned or logged wholesale.

## Reliability and observability

- [medium] **Expose built-in workflow tool identity in activity streams**
  (`src/observability/`, `src/orchestration/orchestrator.ts`): Orchestrator
  dogfood reports `run_pipeline` only as `custom` while it is active, hiding the
  selected execution mode until the final transcript. Project safe allowlisted
  built-in names without exposing third-party tool identifiers.

- [high] **Role-specific stage-budget defaults** (`src/cli/resolve-config.ts`,
  `src/orchestration/stage-limits.ts`): global defaults currently allow Planner
  far beyond its prompt's normal budget. Add configurable per-role overlays and
  efficient defaults, preserving zero-disabled semantics. Dogfood evidence:
  Luna Planner produced no plan after 72.1 s, 13 model turns, 35 tool turns,
  293,212 input tokens, and $0.019080; its prompt expected roughly 12 tools.

- [high] **Account for failed-stage usage** (`src/runner/`,
  `src/project-operations/run-coordinator.ts`): a rejected Researcher consumes
  provider tokens and cost but contributes no entry to workflow `stageMetrics`.
  Persist safe partial numeric observations for failed and rejected stages so
  pipeline totals and calibration efficiency include unsuccessful work.

- [high] **Resume an interrupted role without repeating reconnaissance**
  (`src/orchestration/session.ts`, `src/project-operations/run-coordinator.ts`):
  a stage-limit checkpoint preserves the workflow phase but not the unfinished
  role-run identity, so retry creates a fresh role session. Persist the active
  stage run ID and resume its durable conversation after a raised limit; prove
  the Planner does not repeat completed reads. Rejected Researcher retry already
  preserves the accepted Planner result through `--retry-research`.

- [medium] **Complete activity-stream dogfood evidence**
  (`docs/cost-economics.md`): the interrupted run now has exact checkpoint,
  stage, token, duration, and cost evidence. Add Reviewer rounds and an accepted
  result after an independent review; do not estimate unavailable continuation
  worker usage.
- [medium] **Distributed GitHub claims** (`src/project-operations/`): provide a
  built-in shared `GitHubClaimCoordinator`; mutations currently require an
  injected coordinator and fail closed without one.
- [low] **Usage tracker retention** (`src/ledger/usage.ts`): bound or release
  unique `UsageDeltaTracker` stream keys, or document why per-run lifetime is safe.
- [low] **Ledger retention** (`src/ledger/`, README): define an operator-facing
  retention/pruning policy for target `.ad-coder/ledger` files.

## Product follow-ups

- [medium] **Orchestrator worker tools** (`src/orchestration/orchestrator.ts`):
  add bounded spawn/fork, researcher, and publisher wrappers on the existing
  custom-tool seam with explicit credential/URL/egress boundaries.
- [planned] **Multi-project and plugin frontends**: evaluate a SessionManager,
  optional daemon/event stream, trusted local/npm plugin registry, and Telegram
  driver after the daemon-free control plane settles.
- [planned] **TUI**: build a richer human front over the headless workflow/control
  APIs; it must not be the only path to any capability.

- [high] **Preserve paused-stage context and accounting across resume**
  (`src/orchestration/`, `src/runner/`): a manually driven Luna Planner paused at
  12 model turns, then repeated reconnaissance in a fresh role session after
  resume. Its $0.00690724 usage was absent from terminal `stageMetrics` and
  `total cost`. Persist partial stage metrics and resumable role context, or
  explicitly aggregate every attempt before reporting accepted-result cost.
