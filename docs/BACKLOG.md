# Backlog

Only unresolved work belongs here. Current behavior is in
[ARCHITECTURE.md](ARCHITECTURE.md); future design is in
[ROADMAP.md](ROADMAP.md).

## Current priority

- [next] **Provider admission, headless SessionManager and minimal Telegram driver**:
  first implement the `docs/contracts/provider-admission.md` provider/account
  concurrency gate: durable fair queue, global cooldown on provider limit, safe
  actionable status/errors, and cancellation. Then implement the 2026-09-14
  roadmap decision: safe allowed-root project bindings/creation,
  per-driver project/profile selection, durable Orchestrator sessions and event
  cursors, then the trusted personal-chat long-polling driver. Command schemas
  must provide argument validation and command-specific no-argument help with an
  example from one source.

- [next] **Cost-anomaly detector and scope block** (`src/ledger/`,
  `src/economics/`, `src/cli.ts`): implement
  `docs/contracts/cost-anomaly.md`. Derive per-token rate per
  `(provider, model)` from settled provider-reported usage, keep a durable
  baseline, confirm a threshold crossing over more than one observation, warn
  and refuse to START new runs in that scope until an explicit durable operator
  release re-baselines it. In-flight stages are never killed. Default on;
  threshold, minimum baseline samples, confirmation count, window, and scope
  granularity configurable. Per-stage `maxCostUsd` does not cover this: each run
  stays under its own ceiling while every run costs several times yesterday's
  rate.

- [next] **Durable shared CreditWallet reservations**: `profile estimate` v1 now
  supplies transparent empirical ranges and reads the latest provider-scoped
  balance. Add SessionManager-owned, restart-safe reservations, active-run usage
  reconciliation, provider balance adapters where explicitly configured, and
  fair allocation across every session sharing a provider/account scope.

- [next] **Durable Skills v2 provenance**: Skills v1 provides bounded built-in
  and project-local resolution plus explicit console/library selection and
  role-scoped delegated prompts. Persist immutable selected IDs, versions,
  source, digest, and exact prompt bytes in pipeline checkpoints/results so a
  resume never rereads mutated skill content.

- [next] **Canonical model aliases and suggestions**: make named execution
  profiles the normal CLI path, resolve stable aliases such as `codex-terra` to
  provider model IDs internally, list valid aliases programmatically, suggest a
  close alias for unknown input, and display both alias and provider ID in
  diagnostics. Orchestrator routing must select registry entries rather than
  authoring model identifiers.

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

- [next] **Named execution profiles and provider bindings**: a named profile is
  one inventory/routing policy plus private credential bindings for its enabled
  providers. Support explicit `auth login/list/switch` by profile and separate
  owner-only credential files, so `home` and `work` may each contain a distinct
  authorised Codex OAuth login alongside DeepSeek/OpenRouter bindings. Account
  scope is `(profile, provider)` for wallet/admission. Switching applies only to
  future work; existing durable runs remain pinned, and no automatic fallback or
  rotation occurs.

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
  Add a configurable decomposition guard: when a bounded Coder dispatch reaches
  its early evidence threshold without an implementation diff, pause it and
  create narrower sequential slices rather than retrying the same broad brief.
  Feed the resulting task-shape-specific outcome into routing confidence for
  `(role, model, complexity)` while retaining the original evidence and never
  globally demoting a model from one sample.

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

- [high] **Admit providers that require a custom request header**
  (`src/registry/types.ts`, `src/registry/validate.ts`, `src/registry/resolve.ts`):
  `ProviderConfig` declares only `id`, `api`, `baseUrl`, `credential`, and
  `models`, so a provider whose API mandates a non-auth header cannot be
  admitted at all. Measured 2026-09-15 against OpenCode Zen
  (`https://opencode.ai/zen/go/v1`): `GET /models` returns 200 on a valid key,
  while `POST /chat/completions` returns HTTP 400 `MissingSessionID` unless the
  request carries `x-opencode-session`; the same request with that header
  returns 200. Through ad-coder the role fails as an empty turn with a
  zero-usage ledger record and `stopReason: "error"`, naming neither the header
  nor the status. `pi-ai` already accepts `CreateProviderOptions.headers`, but
  `registerProvider` never passes any. Add a validated, secret-free declared
  header map, require per-request values (such as a run-scoped session id) to be
  derived by the resolver rather than stored in config, keep the existing
  unvalidated-`compat` boundary intact, and project a typed provider-rejection
  error that names the failing status instead of an empty turn.

- [medium] **Persist api-key credentials for any declared env-var provider**
  (`src/cli/auth.ts`, `src/registry/resolve.ts`): `ad-coder auth login` accepts
  only `--provider <openai-codex|openrouter>`, and `registerProvider` gates the
  stored-credential path on the literal `provider.id === "openrouter"`. Every
  other env-var provider an inventory can declare is therefore reachable only
  through a process environment variable, with no supported way to store its key
  outside the project. Generalize storage to any declared `kind: "env-var"`
  provider, keyed by provider id, preserving the credential-outside-target-dir
  boundary and the typed `missing_credential` preflight that names the variable.

- [medium] **A per-role model override must not silently reset the provider**
  (`src/cli/resolve-config.ts`): with a user inventory default in place,
  `config show` reports `inventoryProfile=openrouter-presets (default)` and the
  OpenRouter destination. Adding only `--coder-model <name>` drops the inventory
  and falls through to the built-in preset selection, reporting
  `provider destination "deepseek"` and then failing with `profile model "<name>"
  is not registered`. The operator asked to change one role and silently changed
  the destination for all of them. Either keep the selected inventory when a
  role override names a model it registers, or reject the combination with a
  typed error that names both the inventory and the override.

## Security and runtime boundaries

- [high] **Real tool sandboxing** (`src/runner/`): `targetDir` is only a
  starting cwd. Add out-of-process filesystem/network isolation for untrusted
  tasks; tool allow-lists are not a host sandbox.
- [low] **Result-content handling** (`src/runner/role-runner.ts`): document or
  narrow `RunRoleResult.result`, which can contain prompt/response detail and
  must not be returned or logged wholesale.

## Reliability and observability

- [high] **A usage-counter discrepancy must not destroy a completed role run**
  (`src/runner/runner.ts`): the `after_response` hook rejects any turn where the
  provider reports `reasoning > output`, records a `RangeError` in
  `usageFailure`, and rethrows it after the role has already finished all of its
  work and the tokens are already paid for. The mismatch is an accounting
  convention, not a defect in the result: OpenAI-style `completion_tokens`
  includes reasoning, while some providers report reasoning outside it, so the
  guard fires on a correct response. Measured 2026-09-14 on a MiniMax M3
  Reviewer run recorded in `docs/calibration-evidence.jsonl`
  (`reviewer-hidden-regression-v1`): over 40s of completed review discarded,
  $0.01636788 spent across 12 turns with no result returned, three of which
  reported reasoning above output (922>902, 1374>1306, 1656>1472). Per the
  error contract a counter discrepancy is an observation, not an
  unrecoverable boundary failure — record it as typed,
  safe, non-fatal usage-integrity metadata, keep the result, and reserve the
  fatal path for values that are actually unusable (negative, non-finite,
  unsafe-integer).

- [medium] **Expose built-in workflow tool identity in activity streams**
  (`src/observability/`, `src/orchestration/orchestrator.ts`): Orchestrator
  dogfood reports `run_pipeline` only as `custom` while it is active, hiding the
  selected execution mode until the final transcript. Project safe allowlisted
  built-in names without exposing third-party tool identifiers.

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
