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
prompt can be referenced by name via `resolvePrompt("coder", { projectDir })` —
a project's `.ad-coder/prompts/<name>.md` overrides the shipped built-in, read
verbatim. A ledger attributes real token cost — and which tools each response
requested — to each role, step and run.
The pipeline sequences roles with structured tool-call handoffs (the reviewer
submits a verdict; the planner a complexity and security surface). For chat-style
work there is a multi-turn substrate — `startConversation(config)` builds one
harness once and re-drives it turn after turn, keeping history on the durable
session branch with a per-turn ledger row and the compactor for long chats;
`runRole` stays the single-turn primitive. Built on Bun + TypeScript, proven with
no network (a faux provider) and demonstrated live on DeepSeek — a full feature
for a fraction of a cent.

> Status: the core harness works end to end. The conversational orchestrator, a
> TUI, model/provider profiles, and more are on the [roadmap](docs/ROADMAP.md).

## Install

Requires **Bun 1.3+** (everything runs through Bun; the pi packages need
`node >= 22.19.0`, so do not use an older `node`).

```sh
bun install -g github:aadegtyarev/ad-coder      # install
bun update  -g github:aadegtyarev/ad-coder      # update to the latest
```

The repository is private; installing pulls it over your authenticated git /
`gh` credentials. For local development instead: `git clone`, then `bun install`.

## Configure providers

Credentials come from your **environment** (never from the project ad-coder is
working on). Set the key for the provider(s) you use, e.g.:

```sh
export DEEPSEEK_API_KEY=...      # DeepSeek
export OPENROUTER_API_KEY=...    # OpenRouter
export OPENAI_API_KEY=...        # native OpenAI via openaiCompatiblePreset
export ANTHROPIC_API_KEY=...     # native Anthropic via anthropicCompatiblePreset
```

OpenAI Codex uses OAuth, not an environment key.

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

## Run

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

Per-role model selection is optionally complexity-driven: pass a `routing`
({ profile, registry, defaultComplexity?, overrides? }) to `runPipeline` and each
role's model is chosen from the planner-rated complexity. Routing is optional —
omit it and each role runs on its configured `RoleSpec.model` exactly as before.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components and how they connect
- [Roadmap & design decisions](docs/ROADMAP.md) — what's built, what's next, and why
- [Cost economics](docs/cost-economics.md) — the pricing/optimization thesis, measured
- [pi capabilities](docs/pi-capabilities.md) — verified facts about the pi SDK this rests on
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE) © Alexander Degtyarev
