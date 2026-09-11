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
- **Ledger** — attributes provider token usage and cost to role / step / run as
  JSONL. `usage` is per-response (not cumulative); cost comes from
  `Usage.cost` and is never recomputed. Records carry identifiers and numbers
  only — never prompts, responses, or headers.
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
- **Orchestration** — `runPipeline(config)`: an optional planner → an optional
  Security phase → a coder ⇄ reviewer loop to `maxRounds`. The reviewer submits a
  structured verdict and the planner a structured complexity + security surface
  via tool calls (`submit_verdict`, `submit_plan`); an elevated security surface
  runs a threat-modeling Security phase whose mitigations thread into the coder
  and every reviewer turn. Per-phase cost is visible in the ledger.
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
- **Built-in role prompts** — `prompts/{planner,coder,reviewer,security}.md`.
- **Packaging** — MIT license, CI (typecheck + tests on Bun), and one-command
  install/update from GitHub.

What's planned next lives in [`docs/ROADMAP.md`](docs/ROADMAP.md), not here — a
changelog records what changed, not what's still to do.
