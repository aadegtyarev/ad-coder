# Backlog

Only unresolved work belongs here. Current behavior is in
[ARCHITECTURE.md](ARCHITECTURE.md); future design is in
[ROADMAP.md](ROADMAP.md).

## Current priority

- [next] **Incremental pipeline context** (`src/orchestration/`,
  `src/context/`): implement scoped Planner reconnaissance, Coder fix handoffs,
  and repeated Reviewer verification. Keep a configurable full-context fallback
  for scope drift, large diffs, or insufficient context, and report its reason.
  Per-stage token/read/diff/context-strategy observability and durable
  provider-limit pause/resume are already delivered.

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
