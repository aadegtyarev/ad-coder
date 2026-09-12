# ad-coder

A small, explicit **multi-provider agent harness**. It builds on
[`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
and puts context-window management, per-role/step cost accounting, and a
plan → [security] → code ⇄ review pipeline under your own control — so you can
run the same work on an expensive model where it pays off and a cheap one where
it doesn't.

Roles are presets over the harness (model + verbatim prompt + tool allow-list +
context budget). The allow-list is default-open: omit it and a role gets every
registered tool, set `[]` to deny all, or name an exact set. A role's system
prompt can be referenced by name via `resolvePrompt("coder", { projectDir })`.
The built-in pipeline and conversational orchestrator automatically use each
target project's `.ad-coder/prompts/<role>.md` when present, overriding the
shipped prompt byte-verbatim. These files are trusted operator configuration:
there is intentionally no opt-in, size, symlink, permission, or content cage in
this MVP. A ledger attributes real token cost — and which tools each response
requested — to each role, step and run.
The pipeline sequences roles with structured tool-call handoffs (the reviewer
submits a verdict; the planner a complexity and security surface). For chat-style
work there is a multi-turn substrate — `startConversation(config)` builds one
harness once and re-drives it turn after turn, keeping history on the durable
session branch with a per-turn ledger row. Context compaction is active end to
end: `auto` summarizes evictable history with the resolved cheap-tier model,
while `disabled-then-halt` refuses an over-budget turn without sending history
to a summarizer. `cache-aware` is reserved but fails loudly until its request-
assembly design is verified. `runRole` stays
the single-turn primitive. Built on Bun + TypeScript, proven with
no network (a faux provider) and demonstrated live on DeepSeek — a full feature
for a fraction of a cent.

> Status: the core harness and conversational orchestrator work end to end.
> The TUI and further operator tooling are on the [roadmap](docs/ROADMAP.md).

## Install

Requires **Bun 1.3+** (everything runs through Bun; the pi packages need
`node >= 22.19.0`, so do not use an older `node`).

```sh
bun install -g git+ssh://git@github.com/aadegtyarev/ad-coder.git  # install
bun update  -g ad-coder                                             # update
```

The repository is private; the install command uses your SSH-authenticated Git
access. For local harness development, run `bun link` in this checkout instead.

## Configure providers

Credentials come from your **environment** (never from the project ad-coder is
working on). Set the key for the provider(s) you use, e.g.:

```sh
export DEEPSEEK_API_KEY=...      # DeepSeek   — the CLI selects it on key presence
export OPENROUTER_API_KEY=...    # OpenRouter — the CLI selects it on key presence
```

The **CLI** picks a provider by env-var PRESENCE, in precedence order
`DEEPSEEK_API_KEY` → `OPENROUTER_API_KEY` → OpenAI-Codex OAuth (override with
`--provider`). OpenAI Codex uses OAuth, not an environment key.

Native OpenAI and native Anthropic are **not** auto-selected by the CLI from
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. Reach them through the **library**
presets `openaiCompatiblePreset` / `anthropicCompatiblePreset`, where you supply
the `baseUrl` and the credential env-var name yourself (see below).

The registry (`src/registry/`) ships exactly **five** provider presets:

- **`deepseekPreset`** — DeepSeek, key from `DEEPSEEK_API_KEY`.
- **`openrouterPreset`** — OpenRouter (dual-api; a model may override its own
  `api`), key from `OPENROUTER_API_KEY`.
- **`openaiCompatiblePreset`** — any OpenAI-compatible endpoint (LM Studio,
  vLLM, self-hosted). Caller supplies `id`, `baseUrl`, and the credential
  env-var name.
- **`anthropicCompatiblePreset`** — any Anthropic-compatible endpoint. Caller
  supplies `id`, `baseUrl`, and the credential env-var name.
- **`openaiCodexPreset`** — OpenAI Codex. **OAuth-based, not an env-var key**;
  the resolver delegates to pi-ai's shipped `openaiCodexProvider()`.

There is deliberately **no** separate native-OpenAI or native-Anthropic preset.
Reach **native OpenAI** through `openaiCompatiblePreset` with
`baseUrl: "https://api.openai.com/v1"`, and **native Anthropic** through
`anthropicCompatiblePreset` with `baseUrl: "https://api.anthropic.com"` — native
Anthropic this way gives full `cacheRetention` control (the project's
cache-control thesis). Every preset's base URL must be an absolute **https** URL.

See [docs/pi-capabilities.md](docs/pi-capabilities.md) for the per-provider
cache/cost facts.

### Context compaction

`resolvePipelineConfig` accepts `compactionMode`, `summarizerModel`, and
`allowCrossProviderSummarization`. The default is `auto`, with
`summarizerModel` defaulting to the cheap profile tier. The summarizer makes one
no-tool `Models.completeSimple` request through the same caller-supplied
credential registry; evicted prompts, code, and tool results are therefore sent
to that model. A different provider is rejected unless
`allowCrossProviderSummarization: true` is explicit.
Because this one-shot call bypasses harness hooks, its usage is not currently
included in the role ledger; the selected destination is nevertheless explicit
in the resolved policy.

Choose `disabled-then-halt` when history must never be summarized automatically.
An oversized turn then throws `ContextBudgetError` before the role provider is
called; there is not yet a public manual recovery command. `cache-aware` is an
accepted policy name but deliberately throws as unsupported rather than silently
changing behavior.

## Run

### Usage at a glance

```sh
ad-coder run   <script.ts>                                --target-dir <dir>
ad-coder role  <planner|coder|reviewer|security> "<task>" --target-dir <dir>
ad-coder drive "<task>"                                   --target-dir <dir> [--auto]
ad-coder console                                          --target-dir <dir> [--json]
```

Shared options for `role`, `drive`, and `console`:
`--provider <deepseek|openrouter|openai-codex>`,
`--strong-model`/`--mid-model`/`--cheap-model <name>`,
`--max-rounds <n>`, `--default-complexity <trivial|medium|complex>`.

**Seeing usage / help.** Run `ad-coder --help` (or `ad-coder -h`) for the
registry-derived command list, and `ad-coder <command> --help` (or `-h`) for a
command's arguments and options. Running `ad-coder` with no command — or an
unknown command or flag — prints the same root usage to stderr and exits
non-zero.


The canonical demo drives a real plan → [security] → code ⇄ review pipeline on a
clean throwaway directory:

```sh
DEEPSEEK_API_KEY=... bun run examples/pipeline.ts \
  "Create add.js exporting add(a,b) returning a+b (CommonJS). Minimal."
```

It prints the verdict, the rated complexity and security surface, and the cost
per phase (plan / security / code / review) from the ledger. Point it at your own
target directory with a second argument.

The `ad-coder run <script.ts> --target-dir <dir>` CLI loads and runs a workflow
module against a target directory; `examples/pipeline.ts` shows the library
`runPipeline` API the CLI is a thin front for.

Run any built-in role standalone with `ad-coder role <name> "<task>"
--target-dir <dir>`, where `<name>` is `planner`, `coder`, `reviewer` or
`security`:

```sh
DEEPSEEK_API_KEY=... ad-coder role coder "Add a --json flag to the CLI" \
  --target-dir ./my-project
```

The provider is resolved from the environment by env-var PRESENCE — precedence
`DEEPSEEK_API_KEY` → `OPENROUTER_API_KEY` → OpenAI-Codex OAuth — and the selected
provider and model are echoed to stderr (names only, never the key) before the
turn runs. Pass `--provider <deepseek|openrouter|openai-codex>` to choose
explicitly, `--strong-model`/`--mid-model`/`--cheap-model` to override the tier
models, and `--max-rounds`/`--default-complexity` to set the routing defaults.
The role runs with real `read`/`write`/`edit`/`bash` tool access rooted at
`--target-dir`; that directory is **not** a sandbox (a bash turn can `cd` out of
it and read any file the invoking user can), exactly as the `run` command
documents.

`ad-coder drive "<task>" --target-dir <dir>` drives the same pipeline one phase
at a time: it prints each turn's output and cost and, at every step, asks which
of the offered transitions to take (`advance`/`rework`/`stop`, empty for the
default). Pass `--auto` for the autonomous/machine path — the auto-driver walks
the graph exactly as `runPipeline` does, reading no input. The drive loop lives
in a library module (`driveWorkflow`) driven through injected input/output/error
streams, so it is scriptable with no TTY. Both `role` and `drive` now emit a
clear stderr warning when a turn produces empty text at zero cost (the provider
may need authentication, e.g. `codex login`) instead of two blank-looking lines.

`ad-coder console --target-dir <dir>` is the minimal dogfood console over the
headless `startOrchestrator` core. Each nonblank line is another turn on the same
persistent session; enter `/exit` or send EOF to close it. Human mode prints a
banner, prompt, and compact turn summary. Machine mode prints exactly one JSON
record per completed turn and no banner or prompt:

```sh
ad-coder console --target-dir ./my-project
printf 'show the current cost\n/exit\n' | ad-coder console --json --target-dir ./my-project
```

Input is limited to 65,536 UTF-8 bytes per line by default; change it with
`--max-input-bytes <n>`. An oversized line is rejected before it reaches the
model. Model-derived output has ANSI and other terminal control sequences
removed in both output modes. Provider credentials still come only from the
CLI process environment. `--target-dir` fixes the starting working directory,
but it is not a sandbox: the orchestrator and pipeline host tools are
unrestricted and can access anything the invoking user can. This unrestricted
execution is an explicit MVP choice.

Session generation limits are available programmatically as
`sessionLimits: { maxTurns?, maxCostUsd? }` and in the console as
`--max-session-turns <n>` and `--max-session-cost-usd <amount>`. Both default to
`0`, where `0` disables and only a positive value enables a limit. A turn is one
admitted call through a `Models` generation method, including tool follow-ups,
harness-visible retries, deferred requests/polls, and built-in compaction.
Provider-internal HTTP retries below that boundary are not separate turns.

Cost is the unrounded sum of settled assistant messages'
`usage.cost.total`. A positive threshold blocks the next admission when observed
cost is already equal to or above it; the admitted request that crosses it may
overshoot because its cost is not known in advance. Only one cost-unknown call
may be in flight, so overshoot is bounded to that request. A call that settles
without valid finite non-negative usage makes accounting terminal and blocks
later admissions. Consequently this is a pre-request threshold, not an absolute
spend cap. Custom opaque summarizers are rejected while either limit is enabled.
`show_cost` reports this authoritative session snapshot separately from the
existing per-step ledger totals.

Per-role model selection is optionally complexity-driven: pass a `routing`
({ profile, registry, defaultComplexity?, overrides? }) to `runPipeline` and each
role's model is chosen from the planner-rated complexity. Routing is optional —
omit it and each role runs on its configured `RoleSpec.model` exactly as before.

Project operations are available as a headless API. `validateFollowUp` and
`aggregateFollowUps` produce one strict union of contract, note, design-doc
drift, and backlog candidates with deterministic provenance. Documentation
routing remains available for inspection; `RunCoordinator` applies authorized
note/design-doc proposals with generated metadata-only content and stable
idempotency markers. `createBacklogStore`
selects exactly one authority: the target-local file backend by default, or the
GitHub issues backend when `projectOperations.backlogBackend` is `github` and an
argv-style executor plus repository mapping are supplied. Backlog claims carry
owner, run, branch, and lease timestamps through the queued → claimed →
in_progress → review/blocked → done lifecycle. Backlog persistence always
projects candidate prose to structural metadata. All new numeric limits default
to `0` (disabled).

Existing LDO-organized projects require no migration. `detectLdoProject`,
`previewLdoImport`, `importLdoArtifacts`, `inspectImportedLdoWork`, and
`resumeImportedLdoWork` discover `.codex/ldo/{plans,runs}` plus the existing
README/AGENTS/docs layout, preserve exact source bytes with observed and claimed
provenance, and import immutable digest revisions behind a durable manifest.
Detection and preview do not scaffold documentation or managed state; import
never edits `.codex/ldo` or project documentation. Imported model-authored text
is untrusted: resume requires an explicit trust decision for the exact SHA-256
digest, and a changed or missing source fails stale. Importer count, per-file,
and aggregate byte limits are configurable under `projectOperations.ldo`; each
defaults to `0` (disabled). Set positive limits before inspecting less-trusted
repositories.

`RunCoordinator` is the shared non-model lifecycle owner behind direct
`runPipeline`, `driveWorkflow`, and conversational orchestration. Pass
`coordinator: { runId }` in `PipelineConfig` to reopen an interrupted run; its
ProjectStore checkpoint resumes a prepared step, follow-up processing, operator
decision, contract re-review, or closeout without repeating completed effects.
Contract and ambiguous product decisions stop loudly for operator resolution.
Only a trusted programmatic/UI call to `resolveDecision` with `source:
"operator"` can commit a resolution; accepting a contract also requires exact
one-line rule text and triggers a reviewer-only pass before approval.

The non-interactive `ad-coder operations <action> --target-dir <dir> [--json]`
front exposes `publish-preflight`, `publish-start`, `publish-finish`,
`ldo-detect`, `ldo-preview`, `ldo-import`, `ldo-inspect`, and
`ldo-resume`, FollowUp validation/aggregation, documentation routing, every
backlog lifecycle operation, and GitHub capability/migration probes as JSON.
Pass candidate JSON with `--input <file>` or `--input -`; claim actions also use
`--owner`, `--run-id`, and `--branch`. LDO inspect/resume identifiers are
`plan:<ldo-id>` or `run:<ldo-id>`; import accepts
`{"trustDigests":["<sha256>"]}` only when the operator intends those exact
revisions to become executable.

Repository publishing defaults to the `local` gate (`bun test`). Preflight
discovers remote HEAD then `main`/`master`, captures its OID, and reports dirty
paths without initializing project state; start requires HEAD at that selected
base and creates a feature branch; finish commits only explicit paths via an
isolated index, pushes an explicit refspec, creates a structured PR, and squash
merges. Other gates are `ci`, `local-and-ci`, and `manual`. Empty/pending CI and
changed PR heads fail closed. `multiDeveloper: true` requires approval on the
exact head by someone other than the author and is unavailable for local-only
repositories. Local Git instead advances the unchanged base with one squash
commit while leaving HEAD and user files on the feature branch. Remote, bases,
protected branches, feature prefix, mode, gate, argv test command, approval
mode, and the output-retention limit are configurable. Its `0` default disables
truncation; a positive value retains at most that many bytes per output stream. Failures
leave recovery guidance.

`runPipeline` is the autonomous coordinator driver over a STEPPED engine you can
also drive yourself. `createWorkflowSession(config)` exposes the same plan → [security] →
code ⇄ review graph as an explicit `WorkflowState`: `step(state)` runs the one
pending role turn and hands back the available transitions (`advance`, `rework`,
`stop`) without committing one, and the pure `applyTransition(state, chosen)`
gives the next state — so a human-stepped UI or the conversational orchestrator
can decide each transition. `runPipeline` just takes the default transition
every step (`autoDriver`). Transition policy is a setting, not a constant: an
optional `WorkflowDefaults` (`onChangesRequested`, `autoAdvance`) defaults to the
autonomous behavior.

## Documentation

- [Agent and operator instructions](AGENTS.md) — durable working conventions and handoff routing
- [Architecture](docs/ARCHITECTURE.md) — components and how they connect
- [Roadmap & design decisions](docs/ROADMAP.md) — durable decisions, delivery status, and forward design
- [Backlog](docs/BACKLOG.md) — current priority and unresolved work
- [Contracts](docs/contracts/) — enforced project-wide rules
- [Reviews & incident receipts](docs/reviews/) — exceptional incident evidence and historical receipts
- [Cost economics](docs/cost-economics.md) — the pricing/optimization thesis, measured
- [pi capabilities](docs/pi-capabilities.md) — verified facts about the pi SDK this rests on
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE) © Alexander Degtyarev
