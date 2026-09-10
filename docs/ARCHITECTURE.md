# Architecture

## What this is

ad-coder is a small, explicit agent scaffold built on `@earendil-works/pi-agent-core`. It provides three primitives: a `Role` is a validated preset over harness options that pins a model, system prompt, and tool allow-list; a `Ledger` attributes token usage and cost to roles and runs as JSONL; and a workflow module is a plain object the CLI loads and executes. It builds on pi-agent-core rather than pi-coding-agent, and disables Pi's own compaction so the context strategy stays under ad-coder's control.

## Stack

- **Runtime:** Bun (TypeScript, no build step)
- **Agent framework:** @earendil-works/pi-agent-core@0.85.1
- **AI provider SDK:** @earendil-works/pi-ai@0.85.1
- **Database/state:** none; Ledger writes JSONL to disk
- **Testing:** bun:test, no network

## Components

- **Role (src/role.ts):** Validated preset containing name, provider, modelId, systemPrompt, activeToolNames array, and cacheRetention setting. Exports `defineRole()` to validate inputs and `toHarnessOptions()` to construct pi-agent-core's `AgentHarnessOptions` with compaction disabled and system prompt passed verbatim.
- **Ledger (src/ledger/):** Registers an after_response hook on a harness and appends one JSONL record per turn carrying that response's own token and cost numbers, plus role/step/run attribution. It records the per-response usage directly (pi-agent-core adds each row's usage to session totals at `harness/session/in-memory-storage-state.js:67`, which is only correct if the row is already per-response) and holds no per-stream counters. Records carry identifiers and numbers only — never prompt text, message content, or headers.
- **UsageDeltaTracker (src/ledger/usage.ts):** Pure function `diffUsage()` that subtracts consecutive Usage snapshots to derive per-turn deltas, plus a per-stream baseline map. Retained and exported for a genuinely cumulative source such as `message_update` (where `pi-ai` emits absolute values into one mutable `output.usage`), and deliberately not used on the after_response path (which is per-response). Handles optional fields (cacheWrite1h, reasoning) by conditional spread, and clamps negative deltas to 0 with an anomaly flag rather than emitting negative costs. `usageAmounts()` in the same file copies one reading into the ledger's shape through an explicit allow-list, building a fresh `cost` object so caller mutations do not alter already-written records.
- **Workflow module (src/workflow.ts):** Plain object contract: `{ name: string; run(ctx: WorkflowContext): Promise<unknown> }`. CLI loads a .ts file by path, validates the default export, and executes `run()`.
- **CLI (src/cli.ts):** Entrypoint `ad-coder run <script.ts>` that validates the path (requires a regular file, owned by current user, not world-writable), generates a runId via `crypto.randomUUID()`, instantiates a Ledger, invokes the workflow's run function, prints the result as JSON, and exits 0 on success or 2 on usage error.

## How they connect

A workflow module is loaded by the CLI, which constructs a Ledger with a generated runId and passes both to `run()`. Inside the workflow, the harness is instantiated with pi-agent-core's factory and a Role is converted to `AgentHarnessOptions` via `toHarnessOptions()`, which includes the model and compaction settings. The Ledger's `attach()` method registers an after_response hook on the harness that fires on every turn, records that response's own Usage (already per-response from the hook's settled message), and appends one JSONL record per turn to `.ad-coder/ledger/<runId>.jsonl`. The workflow returns a value, which the CLI prints as JSON.

## Key decisions

- **No compaction:** Pi provides built-in message summarization via CompactionSettings, but its prompt is a hardcoded constant. We disable it (`compaction: { enabled: false, ... }`) so ad-coder can own the context strategy.
- **Ledger reads provider cost, never recomputes it:** A record's cost is the provider's own reported `Usage.cost` block, copied field by field in a fresh object so a caller's later mutations do not alter an already-written record, never recalculated from tokens times a rate, so the audit trail cannot drift from provider billing.
- **Role is a preset, not runtime-mutable:** It is shaped to be additive in the future (budget, promptLimit, handoffPolicy fields can be added without breaking the harness Options type), but for now it is the minimal validated set that closes the gap between a provider model name and pi-agent-core's required harness options.
- **activeToolNames is emitted unconditionally:** An undefined field in AgentHarnessOptions grants all registered tools; an empty array is a valid deny-all. We emit activeToolNames always, never conditionally, so a role's intent is explicit.
- **Per-stream deltas, not per-role:** When `UsageDeltaTracker` is applied to a cumulative source it keys by `${runId}:${lane}` (stream identity), not by role, because two roles sharing a lane share the cumulative counter — keying by role would produce inflated first-turn deltas for each. The ledger write path records the reading directly with no diffing at all.
- **Filesystem sandboxing:** runId is validated against `/^[A-Za-z0-9_-]{1,64}$/`, ledger paths are resolved and required to stay inside the base directory, and record files are opened with O_NOFOLLOW to block symlink attacks.
