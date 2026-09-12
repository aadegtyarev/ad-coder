# Backlog

Only unresolved work belongs here. Current behavior is in
[ARCHITECTURE.md](ARCHITECTURE.md); future design is in
[ROADMAP.md](ROADMAP.md).

## Current priority

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

- [next] **Incremental pipeline context** (`src/orchestration/`,
  `src/context/`): implement scoped Planner reconnaissance, Coder fix handoffs,
  and adaptive Reviewer verification. The first review is a broad cold review;
  after `changes_requested`, pass only the findings, changed diff, preserved
  evidence, and affected contracts into a focused re-review. Escalate back to a
  full review only for scope drift, a materially large new diff, changed risk, or
  insufficient evidence, and report that reason. Match the speed and judgment of
  an effective conversational Orchestrator rather than blindly repeating whole
  prompts.
  Per-stage token/read/diff/context-strategy observability and durable
  provider-limit pause/resume are already delivered. Acceptance includes lower
  re-review latency and token cost without a worse escaped-defect rate, measured
  from the dogfood run rather than asserted.

## Security and runtime boundaries

- [high] **Real tool sandboxing** (`src/runner/`): `targetDir` is only a
  starting cwd. Add out-of-process filesystem/network isolation for untrusted
  tasks; tool allow-lists are not a host sandbox.
- [medium] **Process-cwd credential exposure** (`src/cli.ts`): ensure a target
  `.env` cannot become provider credentials through Bun's cwd loading; resolve
  credentials independently and refuse or clearly warn on unsafe overlap.
- [low] **Result-content handling** (`src/runner/role-runner.ts`): document or
  narrow `RunRoleResult.result`, which can contain prompt/response detail and
  must not be returned or logged wholesale.

## Reliability and observability

- [next] **Semantic tool-activity stream** (`src/runner/`, `src/conversation/`,
  `src/cli/`): implement the headless lifecycle-event contract in
  proposed contract in `docs/proposed-contracts/tool-observability.md`, activate
  it only when implementation conforms, then render a compact live `Explored` /
  `Read` / `Search` / `Edit` / `Run` / `Web` / `Inspect image` view in console
  and stable JSON events for machine clients. Preserve heartbeat as the no-event
  fallback and expose only bounded allowlisted metadata.
  Deliver this in a separate branch through ad-coder's own built-in pipeline as
  a dogfood evaluation. Record per-role model/thinking level, duration,
  input/cache/output/reasoning tokens, cost, review rounds, escaped defects, and
  accepted-result total so profile efficiency can be compared from evidence.

- [medium] **Distributed GitHub claims** (`src/project-operations/`): provide a
  built-in shared `GitHubClaimCoordinator`; mutations currently require an
  injected coordinator and fail closed without one.
- [low] **Usage tracker retention** (`src/ledger/usage.ts`): bound or release
  unique `UsageDeltaTracker` stream keys, or document why per-run lifetime is safe.
- [low] **Ledger retention** (`src/ledger/`, README): define an operator-facing
  retention/pruning policy for target `.ad-coder/ledger` files.
- [minor] **Context-budget diagnostics** (`src/context/budget.ts`): include the
  effective ceiling in `ContextBudgetError`.

## Product follow-ups

- [medium] **Orchestrator worker tools** (`src/orchestration/orchestrator.ts`):
  add bounded spawn/fork, researcher, and publisher wrappers on the existing
  custom-tool seam with explicit credential/URL/egress boundaries.
- [planned] **Multi-project and plugin frontends**: evaluate a SessionManager,
  optional daemon/event stream, trusted local/npm plugin registry, and Telegram
  driver after the daemon-free control plane settles.
- [planned] **TUI**: build a richer human front over the headless workflow/control
  APIs; it must not be the only path to any capability.
