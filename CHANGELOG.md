# Changelog

All notable changes to ad-coder are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims at
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Added versioned portable user profiles with append-only economics history and
  always-JSON `profile show|export|import-preview|import-apply` CLI access.
- Added bounded `.ad-coder/calibration.json` snapshots, `profile snapshot`, and
  automatic project-calibrated routing for matching named inventories.
- Added typed, configurable closeout reserves for duration, model turns, and
  tool turns so bounded roles retain capacity to return their final result.
- Added an input-token closeout reserve and increased the default model-turn
  reserve from two to four after dogfood showed context-heavy turns and retried
  tool batches exhausting the prior closeout allowance.

- Added a headless named model-inventory layer and CLI selection that atomically
  pairs a provider/model registry with its role-by-complexity routing profile.

- Added native Orchestrator `resume_pipeline` support and safe aggregate stage
  usage/run identity in automatic pipeline results.
- Added `drive --resume-run` for stage-limit pauses, with actionable checkpoint
  output, unknown-run failure, task-binding protection, and rejection when the
  exhausted host budget was not raised or disabled.
- Added explicit `drive --resume-run <id> --retry-research` recovery for rejected
  Researcher output while preserving the accepted Planner result.
- Added configurable incremental pipeline retry handoffs, deterministic full-context
  fallback reasons, and durable per-stage handoff-strategy observability.
- Added `search_project`, a configurable ranked and byte-bounded task
  reconnaissance projection for all native pipeline roles.
- Added `read_project`, a configurable multi-file line-slice projection with
  one aggregate byte ceiling for every native pipeline role.
- Added a zero-disabled per-stage limit controller for duration, model turns,
  tool turns, input tokens, and provider-reported cost.
- Wired finite stage-budget defaults through the runner, durable coordinator,
  effective configuration, and CLI, with explicit resume of the incomplete stage.
- Added a bounded headless semantic tool-activity lifecycle stream, optional
  subscriptions, compact console grouping, and schema-v1 NDJSON progress on
  stderr with visible backpressure and subscriber drops.
- Added safe per-stage provider/model, thinking, duration, reasoning-token, cost,
  and context-strategy metrics to pipeline results and durable reports.
- Added per-stage UTF-8 byte measurements for the effective system prompt,
  stage handoff prompt, tool definitions, and their request-assembly total.

### Changed

- Standalone roles now checkpoint their run and can resume the same durable
  session and ledger with `role --resume-run` after a stage-limit pause or crash.
- CLI runs from inside `targetDir` now disable environment credentials so Bun's
  startup dotenv loading cannot import provider keys from the target project.
- Context-budget refusals now report their effective ceiling when a runtime model
  window is smaller than the role budget.
- Standalone `role` runs now persist their numeric usage ledger, print a safe
  usage envelope, stream semantic tool activity, and retain selected plugin tools.
- Pipeline `drive` runs now stream the same bounded semantic tool activity for
  every role stage.
- Planner now stops after one sufficient bounded evidence pass for tasks with
  explicit files and acceptance criteria, and ends immediately after submission.
- Coder now skips broad exploration after a concrete Planner handoff, edits
  existing files in place, and bounds repeated verification runs.
- Planner now uses only bounded structural, search, and batched-read project
  tools, removing redundant raw shell/read paths from its reconnaissance loop.
- Bounded normal Planner reconnaissance by batching independent reads and
  converting unresolved evidence into a research gate before Coder dispatch.
- Planner now specifies verification commands without executing suites, builds,
  linters, or formatters during normal reconnaissance.
- Security, Researcher, Coder, and Reviewer now use scoped batched search/read
  projections before any individual-file fallback.

### Security

- Hardened `read_project` against path replacement and post-stat file growth by
  using descriptor-relative no-follow traversal and a bounded descriptor read.
- Hardened activity projection against argument, identifier, terminal-control,
  custom-tool-name, and oversized-record disclosure; default web transport now
  pins validated public addresses and revalidates redirects.

### Fixed

- Reviewer verdict instructions now include the exact contract IDs required for
  each planned surface, so valid documentation-only reviews can self-correct.
- Preserved typed stage-limit failures across the model harness boundary and
  made `drive` report actionable stage pauses instead of pending decisions.
- Made `submit_follow_up` advertise discriminated variants and prevented invalid
  optional follow-up metadata from discarding a completed primary role result.

## [0.2.1] - 2026-09-12

### Changed

- Replaced the accreted architecture dump with a readable system map and added
  an enforced human-first documentation contract, configurable readability gate,
  and cold-reader planning/review procedure.
- Tightened the Orchestrator prompt, made its tool policy explicitly default-open
  over all registered tools, and added documentation audit triggers.
- Added plugin-shaped DuckDuckGo search and navigable page reading, content-image
  discovery, and capability-based image inspection with configurable vision-model
  routing for text-only roles.
- Added Git-ignore-aware `explore_project` reconnaissance for every code-reading
  role, isolated `decompose_task`, and Auditor/project-health contracts for
  evidence-based, test-pinned decomposition.
- Made the shipped pipeline an opt-in conversational workflow module selected by
  `--workflows pipeline`; disabled workflows register no tools, while standalone
  `drive` remains an explicit pipeline entry point.
- Exposed gate, exploration, web, media, and model-modality defaults as typed
  configuration instead of hidden behavioral constants.
- Added configurable stderr progress heartbeats and provider-request timeouts for
  long-running model-backed CLI operations.
- Added enforceable product-change, error-behavior, compatibility/release, and
  decomposition methods and made every delivery role apply their boundaries.
- Extended CI through a packed-artifact installation smoke.
- Added pipeline-independent `run_role` delegation so the Orchestrator can call
  every shipped specialist directly while workflow modules remain disabled.
- Defined the next-step headless tool-observability contract and recorded its
  compact human and structured machine renderers in the backlog.

## [0.2.0] - 2026-09-12

The working core of the harness. Built on `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` 0.85.1, Bun + TypeScript, provable end to end with no
network (pi-ai's fauxProvider) and demonstrated live on DeepSeek.

### Added

- **Public release discipline** — package version `0.2.0`, enforced SemVer and
  dated-changelog consistency, artifact version verification, public-clone
  installation guidance, and an explicit no-recursive-orchestration guard for
  every built-in role.

- **Durable Orchestrator control-plane foundation** — queued daemon-free starts,
  atomic request-key admission, reconstruction, safe status/list/tool views,
  cooperative cancellation, explicit auto/manual decisions, provider/session-limit
  pauses, scoped child decomposition, reports, breakpoints and reviewed-tree-bound
  publishing. The machine `operations` CLI exposes trusted control actions.
  Pipeline results now distinguish `approved` from `decomposition_required`
  while retaining the compatible `approved` boolean.

- **Project operations Increment 6** — configurable headless repository
  publishing with JSON preflight/start/finish operations, isolated explicit-path
  commits, local/CI/manual gates, exact-head approval, GitHub and local squash
  flows, dirty-work preservation, and base-movement recovery.

- **Project operations Increment 5** — migration-free LDO layout detection,
  non-destructive digest/provenance imports with explicit execution trust,
  durable inspection/resume, and detect/preview/import/inspect/resume JSON CLI
  actions. Enabled importer limits reject unsafe or oversized source artifacts
  before persistence; zero keeps each numeric limit disabled.

- **Project operations Increment 4** — a durable non-model RunCoordinator,
  structured per-turn FollowUps, operator decisions, accepted-contract re-review,
  idempotent closeout, and resume parity across all workflow drivers.

- **Project operations Increment 3** — strict, provenance-preserving FollowUps;
  proposal-only documentation routing; and one configured BacklogStore authority
  with file or opt-in GitHub issue persistence, lifecycle/lease claims, a
  read-only capability probe, and one-time migration advice. GitHub payloads use
  stdin and persist only a structural metadata projection.

- **Trusted target role prompts and contract-aware roles** — pipeline and
  conversational orchestration now activate `.ad-coder/prompts/<role>.md`
  overrides automatically and byte-verbatim. Planner, Coder, and Reviewer roles
  discover, carry, obey, and independently enforce applicable target-project
  contracts without requiring ad-coder's documentation filenames.

- **Session generation limits** — headless conversations and orchestrators accept
  zero-disabled turn and USD thresholds enforced across all Models generation
  paths, including nested workflow roles and built-in compaction. Console flags
  expose the same controller and typed exhaustion stops safely without a fake
  completion record.

- **Minimal human console** — `ad-coder console --target-dir <dir>` keeps one
  `startOrchestrator` session across turns, supports formatted and JSONL output,
  injected streams, `/exit`/EOF cleanup, terminal-control sanitization, and a
  configurable 65,536-byte default input-line limit. Host tools remain
  unrestricted by explicit MVP decision.

- **Activated context compaction** — `auto` now builds a one-shot, no-tool
  summarizer from the resolved cheap-tier model and is propagated through role,
  pipeline, CLI, conversation, and orchestrator paths. `disabled-then-halt`
  rejects a full over-budget branch before provider execution; `cache-aware`
  fails loudly pending implementation. Summaries retain untrusted-history
  provenance, cross-provider disclosure requires explicit opt-in, and repeated
  summarizer failures are circuit-broken.

- **Role** — a validated preset over the harness options (`defineRole(role,
  model)`): a verbatim system prompt, a per-role tool allow-list
  (`activeToolNames`), a `cacheRetention` policy, and a `ContextBudget`. Pi's own
  compaction is disabled so the context strategy stays in ad-coder.
- **Prompts as files** — `resolvePrompt(name, opts?)` resolves a SYSTEM prompt
  by bare name to a verbatim UTF-8 string, so a role can reference `"coder"`
  instead of embedding an inline `fs.readFileSync`. A project prompt at
  `<projectDir>/.ad-coder/prompts/<name>.md` overrides the built-in shipped at
  `prompts/<name>.md`; the file is returned unchanged (no trim, no normalize, no
  templating — it is the cacheable verbatim cache prefix). The name is validated
  against `/^[A-Za-z0-9_-]+$/` BEFORE any path is built (no dots, slashes or
  `..`), and failures are a typed `PromptError` (`invalid_name`/`not_found`)
  carrying only the name and the absolute paths tried — never file contents.
  Task/user-prompt templating is a follow-on.
- **Default-open tool allow-list** — `activeToolNames` is now OPTIONAL: an absent
  field means "every registered tool" (the harness default), a present `[]` is
  still a deny-all, and a present non-empty array is the exact set. Existing
  roles set the field explicitly, so only the previously-invalid absent case
  changes meaning.
- **Ledger** — attributes provider token usage and cost to role / step / run as
  JSONL. `usage` is per-response (not cumulative); cost comes from
  `Usage.cost` and is never recomputed. Records carry identifiers and numbers
  only — never prompts, responses, or headers.
- **Ledger tool-call observability** — each record now carries an optional
  `toolCalls` map (tool name → count) of the tools the model REQUESTED in that
  response, omitted when it requested none. Per-response granularity, names and
  counts only (never arguments or output); execution outcome (`isError`) is a
  documented follow-on via the `after_tool` hook.
- **Context management** — `ContextBudget` on every role validated against a
  caller-supplied `Model` (local / custom endpoints safe); a `ContextCompactor`
  (`transform_context` hook) with ad-coder's own summarization prompt; and an
  `assertTurnFitsBudget` pre-flight.
- **Capability matrix** — `deriveCapabilities(model)` (cost mode, cache
  controllability, context window, unit costs, out/in ratio), plus
  `cacheEfficiency` and `breakEvenReads` metrics.
- **Quality gates** — a data-declared `QualityGate` + a `GateRunner` with an
  injected command executor; format / lint / typecheck / in-process size gates.
- **Runner** — `runRole(params)` drives one turn through pi-agent-core in a
  **required, separate `targetDir`** (harness dir ≠ target dir; credentials only
  from the harness environment, never the target's). Custom tools are injectable
  via `tools?` (`defineTool` / `Tool`).
- **Conversation** — `startConversation(config)` (`src/conversation/`): the
  multi-turn substrate the conversational orchestrator will sit on. It builds ONE
  harness over ONE session, acquires the lane and attaches the compactor ONCE,
  and returns a `ConversationSession` whose `step()` re-drives that same
  `lane.prompt` seam turn after turn — history is retained on the durable Session
  branch tip, never replayed. Each turn gets a fresh per-turn `Ledger` sharing
  the one sink and attaches/unsubscribes its ledger + `tool_end` listeners inside
  a `finally` (so N turns emit exactly N ledger rows, never duplicated), narrows
  the settled record to `{status, assistantText, toolCalls, droppedRecords}`, and
  never closes the shared sink until `close()`. `runRole` stays the single-turn
  primitive; this reuses its seams (`runner.ts`/`pipeline.ts` untouched). The
  compactor is the payoff for long chats.
- **Orchestration** — `runPipeline(config)`: an optional planner → an optional
  Security phase → a coder ⇄ reviewer loop to `maxRounds`. The reviewer submits a
  structured verdict and the planner a structured complexity + security surface
  via tool calls (`submit_verdict`, `submit_plan`); an elevated security surface
  runs a threat-modeling Security phase whose mitigations thread into the coder
  and every reviewer turn. Per-phase cost is visible in the ledger.
- **Stepped workflow engine** — `createWorkflowSession(config)` exposes the
  plan → [security] → code ⇄ review graph as an explicit, inspectable
  `WorkflowState`: `step(state)` runs the ONE pending role turn and returns the
  post-turn state plus the `AvailableTransition[]` on offer WITHOUT committing
  one, and the pure `applyTransition(state, chosen)` yields the next state. A
  driver picks each transition — `advance`, `rework` (re-run the coder without a
  review in between), or `stop`. `runPipeline` is now the autonomous auto-driver
  over this engine (always take the default transition), byte-for-byte its prior
  behavior. Transition policy is a setting, not a constant: `WorkflowDefaults`
  (`onChangesRequested`, `autoAdvance`, plus `maxRounds`/`defaultComplexity`)
  each defaults to today's behavior. This is the substrate a human-stepped UI or
  the conversational orchestrator drives.
- **Provider registry** — `src/registry/`: plain-data provider + model config,
  a strict fail-loud `parseRegistryConfig` validator (https-only absolute base
  URLs, no embedded userinfo), and `resolveRegistry` turning declared data plus
  the harness environment into a pi `Models` collection with a stable-name
  lookup. Credentials resolve through an injectable env accessor by declared var
  NAME; a missing one throws `RegistryError('missing_credential', <NAME>)`. Five
  presets ship: `deepseekPreset`, `openrouterPreset`, `openaiCompatiblePreset`,
  `anthropicCompatiblePreset`, and the OAuth-delegated `openaiCodexPreset`.
- **Profiles** — `src/profiles/`: the composer layer above the registry that
  resolves a `(role, complexity)` cell — or a per-spawn `SpawnOverride` — to a
  registry model NAME and then to a live pi `Model<Api>`, plus an advisory
  `{ maxOutput, cacheRetention }`. A strict fail-loud `parseProfile` validator
  (five `ProfileRole`s including a forward-looking `recorder`, seen-Set duplicate
  detection on the `role:complexity` key), `resolveProfile` (which rethrows a
  registry `unknown_model` as `ProfileError('unknown_model')` so the layer
  presents one typed surface), and a provider-agnostic `buildDefaultProfile`
  builder. The advisory hints have no sink yet and nothing wires this into
  `runPipeline` — both are a deliberate follow-on.
- **Complexity-aware routing** — `runPipeline` now CONSUMES the profile/registry
  layers through an optional `PipelineConfig.routing`
  (`{ profile, registry, defaultComplexity?, overrides? }`): per-role model
  selection is driven by the planner-rated complexity — the planner (and any
  pre-complexity role) routes on `defaultComplexity` (default `'medium'`), and
  every later role on the planner's submitted tier, else that default; a per-role
  override wins over the `(role, complexity)` cell. Routing is optional and
  additive — absent, model selection is byte-for-byte the prior behavior (each
  `RoleSpec.model` over `config.models`).
- **Built-in role prompts** — `prompts/{planner,coder,reviewer,security}.md`.
- **Env-driven config resolution** — `resolvePipelineConfig(options)` builds a
  runnable `PipelineConfig` from the environment: it selects a provider by
  env-var PRESENCE (precedence `DEEPSEEK_API_KEY` → `OPENROUTER_API_KEY` →
  OpenAI-Codex OAuth, overridable with `provider`), builds the matching shipped
  preset's registry through the injected `env` accessor (a keyless env-var
  provider throws `RegistryError('missing_credential', <VAR-NAME>)` naming only
  the variable), routes strong/mid/cheap model NAMES through the default
  profile, and derives the context budget as a PERCENT of the smallest chosen
  model's window (never a hardcoded value) so one budget validates for every
  role. The selected provider and tier model names are echoed to stderr (names
  only, never a key) before the turn runs.
- **`ad-coder role <name> "<task>" --target-dir <dir>` subcommand** — runs a
  single built-in role (`planner`/`coder`/`reviewer`/`security`) standalone
  against a target directory, resolving the provider and models from the
  environment. Prints the role's final assistant text and the per-run cost;
  `--provider`, `--strong-model`/`--mid-model`/`--cheap-model`, `--max-rounds`
  and `--default-complexity` are validated at the argument boundary (bad input
  exits 2 with the usage string). The role runs with real read/write/edit/bash
  tool access rooted at the target directory — the target directory is NOT a
  sandbox (same posture as `run`).
- **`ad-coder drive "<task>" --target-dir <dir> [--auto]` subcommand** — drives
  the stepped workflow engine one phase at a time: it prints each turn's output
  and per-step cost and, at every step, reads which offered transition to take
  (`advance`/`rework`/`stop`). `--auto` swaps the human read for the auto-driver
  so the path reproduces `runPipeline` for scripting/CI. The drive loop lives in
  a library module (`driveWorkflow`, exported) driven through injected
  input/output/error streams, so it needs no TTY; a chosen transition is
  validated against the ones the step actually offered and rejected with a typed
  `DriveError('transition_not_offered')` otherwise. The same change adds a
  silent-no-op signal to both `role` and `drive`: a turn with empty assistant
  text and zero cost now writes a clear stderr warning (the provider may need
  authentication, e.g. `codex login`) instead of two blank-looking lines.
- **Packaging** — MIT license, CI (typecheck + tests on Bun), and one-command
  install/update from GitHub.

What's planned next lives in [`docs/ROADMAP.md`](docs/ROADMAP.md), not here — a
changelog records what changed, not what's still to do.
