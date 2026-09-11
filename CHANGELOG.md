# Changelog

All notable changes to ad-coder are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims at
[Semantic Versioning](https://semver.org/).

## [Unreleased]

The working core of the harness. Built on `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` 0.85.1, Bun + TypeScript, provable end to end with no
network (pi-ai's fauxProvider) and demonstrated live on DeepSeek.

### Added

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
