# ad-coder

A small, explicit agent scaffold on [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core):
a **Role** is a validated preset over the harness options, a **Ledger** attributes
provider token usage and cost to a role, step and run, and a **workflow module**
is a plain object the CLI loads and runs.

It builds on `pi-agent-core` rather than `pi-coding-agent`, and it disables Pi's
own compaction (whose summarization prompt is a hardcoded constant) so the
context strategy stays in ad-coder. That strategy is now explicit and owned:

- Every `Role` carries a **`ContextBudget`** (`maxTokens`, `reserveTokens`,
  `keepRecentTokens`). `defineRole(role, model)` takes the target `Model` and
  validates the budget against that model's real `contextWindow` — the model is
  supplied by the caller, not looked up in a catalog, so a local or custom
  OpenAI-compatible endpoint (LM Studio, vLLM, self-hosted qwen) validates too.
- A **`ContextCompactor`** registers as a `transform_context` hook. When a turn
  is over budget it summarizes the evicted older head through an injected
  `Summarizer` seam, using ad-coder's own exported `SUMMARIZATION_PROMPT` (never
  Pi's), and rebuilds `[summary, ...recent tail]`. A summarizer failure is
  counted (`compactionFailures`) and warned once, never thrown — the harness
  aggregate would swallow a throw.
- **`assertTurnFitsBudget(role, messages, model)`** is a pre-flight (not a
  hook): it throws a typed `ContextBudgetError` when even the irreducible recent
  tail plus the reserve cannot fit under the ceiling — the one case compaction
  can never rescue.

## Requirements

Bun 1.3+. Everything runs through Bun -- the pi packages declare
`engines.node >= 22.19.0`, so do not run this project with an older `node`.

## Install

```sh
bun install                      # local development
bun install --frozen-lockfile    # CI: fail rather than resolve a new tree
```

`bun.lock` is committed on purpose. The direct pi dependencies are pinned
exactly, but their own dependencies use ranges, so the lockfile is what actually
pins the tree. `trustedDependencies` is declared empty in `package.json`, so
dependency install scripts are blocked by default and adding one shows up in a
diff (`bun pm untrusted` lists what is currently blocked).

## Checks

```sh
bun test            # no network, no provider calls, no API keys
bun run typecheck   # tsc --noEmit under a strict config
```

`moduleResolution` must stay `"bundler"`: the pi `.d.ts` files re-export with
explicit `.ts` extensions, which `node16`/`nodenext` resolution rejects.

## Usage

```sh
bun run src/cli.ts run examples/hello.workflow.ts
```

A workflow module default-exports `{ name, run(ctx) }`:

```ts
import type { WorkflowModule } from "ad-coder";

const workflow: WorkflowModule = {
  name: "hello",
  async run(ctx) {
    return { runId: ctx.runId };
  },
};

export default workflow;
```

The package is its own TypeScript source -- there is no build step, and
`exports` points at `src/index.ts`, which is what makes `from "ad-coder"`
resolve (in this repo too: `examples/hello.workflow.ts` imports it that way).
A consumer therefore needs a resolver that reads TypeScript: Bun, or `tsc`
under `moduleResolution: "bundler"`.

`ctx.ledger` is a `Ledger`; attach it to a harness's hooks with
`ledger.attach(hooks)` and it records one line per assistant turn.

The CLI writes `JSON.stringify` of whatever `run` returns to stdout, and exits
`2` on a usage or validation error, `1` on a failing workflow.

## The ledger

One JSONL record per turn under `.ad-coder/ledger/<runId>.jsonl`:

```json
{"ts":1757000000000,"runId":"...","lane":"main","role":"planner","step":"plan","provider":"anthropic","model":"claude-sonnet-4-5","stopReason":"stop","status":200,"usage":{"input":150,"output":40,"cacheRead":20,"cacheWrite":4,"totalTokens":214,"cost":{"input":0.006,"output":0.0085,"cacheRead":0.0003,"cacheWrite":0.0002,"total":0.015}}}
```

- Records carry identifiers and numbers only -- never a prompt, a message body
  or a response header map.
- Cost is the provider's own reported `Usage.cost`, copied field by field and
  never recomputed from tokens times a rate, so the ledger cannot drift from
  provider billing.
- `cacheWrite1h` is a subset of `cacheWrite` and `reasoning` is a subset of
  `output`; adding either to its parent double-counts.
- Each line carries that response's own numbers, not a difference against the
  previous line, so the lines of a file sum to the session total the same way
  pi-agent-core builds it. `diffUsage` and `UsageDeltaTracker` stay exported
  for a genuinely cumulative source such as the `message_update` event, where a
  reading that goes backwards yields clamped zeros plus
  `"anomaly":"non_monotonic"` rather than a negative cost.
- The directory is forced to mode `0700` and each file to `0600`; a symlink or
  a hard-linked path at the record location is refused rather than written to.
- If a write fails, the run continues but `ledger.droppedRecords` counts the
  loss, the first failure prints a warning, and the CLI reports the count at
  exit. A non-zero count means the audit trail has holes.

**Retention is yours.** `.ad-coder/` is gitignored and nothing prunes it: one
file accumulates per run. Delete or archive it on whatever schedule your
environment needs.

## The capability matrix

`deriveCapabilities(model)` turns a pi-ai `Model` into a small descriptor you
can decide against, as a pure function over a hand-buildable literal -- no
network, no keys:

```ts
import { deriveCapabilities, cacheEfficiency, breakEvenReads, reconcileRoleWithModel } from "ad-coder";

const caps = deriveCapabilities(model);
// { costMode, cacheControllable, contextWindow, cacheReadUnitCost, cacheWriteUnitCost, outInRatio }
```

- **`costMode` is three-way.** `per-token` when any cost field is nonzero (this
  is the reliable one -- it reads price, not host). Otherwise `local` when the
  baseUrl host is loopback/private (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`,
  `10.*`, `192.168.*`, `172.16-31.*`, `*.local`) or the provider looks local
  (`/lmstudio|vllm|local/i`); else `prepaid` (a plan whose catalog cost is all
  zero, so the ledger reads $0 against a real quota spend). The local/prepaid
  split is a best-effort, overridable heuristic; a baseUrl that will not parse
  is treated as non-local.
- **`cacheControllable`** is whether the model actually honors
  `Role.cacheRetention`: `model.api === "anthropic-messages" ||
  model.compat.cacheControlFormat === "anthropic"`. The predicate is
  api-OR-format on purpose -- the format alone is a false negative on native
  Anthropic, which honors cacheRetention with no `cacheControlFormat` field set.

Two metrics, computed from what the ledger already records:

- **`cacheEfficiency(usage) = cacheRead / (cacheRead + input)`** -- the fraction
  of read tokens served from cache; a drop flags a broken prefix. Both-zero
  yields 0.
- **`breakEvenReads(model)`** -- how many times a cached prefix must be re-read
  before the cache write pays for itself, from unit prices. Returns the numeric
  threshold, or `"always"` when writes are free (`cacheWrite === 0`), or
  `"degenerate"` when `input <= cacheRead`.

`reconcileRoleWithModel(role, model)` returns a `ReconcileWarning[]` (it never
throws): one `inert-cache-retention` warning when a role sets a non-`none`
`cacheRetention` on a model that cannot honor it, so the setting fails loud
instead of being silently ignored.

The empirical declared-vs-observed layer -- reconciling this static matrix
against what the first live response actually reports -- is a planned follow-up.

## Quality gates

Gates over prompts: a deterministic, mechanical check run BEFORE an LLM review
round costs no tokens, so anything a machine can decide (format-clean, lint,
typecheck, a file-size ceiling) should never be spent on a model turn. The model
reviews what a gate cannot.

A gate is DATA. Commands are config, not hardcoded, so the module is language-
and provider-agnostic:

```ts
import { GateRunner } from "ad-coder";
import type { QualityGate, CommandExecutor } from "ad-coder";

const gates: QualityGate[] = [
  { name: "format", kind: "format", autofix: ["prettier", "--write"], command: ["prettier", "--check"] },
  { name: "types", kind: "typecheck", command: ["tsc", "--noEmit"] },
  { name: "size", kind: "size", maxLinesPerFile: 500 },
];

const runner = new GateRunner({ executor });
const report = await runner.run(gates, ["src/a.ts", "src/b.ts"]);
// report.passed is the AND of all results; report.results names each verdict.
```

- The command runner is an **injected `CommandExecutor` seam**
  (`(argv, cwd) => Promise<{exitCode, stdout, stderr}>`), mirroring the ledger's
  sink. `GateRunner` never spawns a process itself, so the whole path is testable
  with a fake and nothing shells out. No real spawn executor ships in this
  module, and gates are not yet wired into ad-coder's own build.
- When a gate declares `autofix`, that argv runs FIRST (files mutated into shape)
  and then the `command` argv decides pass/fail by its exit code.
- The `size` gate runs **in-process** — no external tool. It reads each file only
  to count lines and fails one exceeding `maxLinesPerFile`, naming the file and
  its exact count.
- Every result's `output` is bounded (a fixed char cap plus a truncation marker),
  so a verbose or hostile tool cannot flood the report or a caller's next-turn
  context.

## Security notes

- **The gate runner only ever builds argv arrays, never a shell string**, and
  never interpolates file contents into a command. A `QualityGate`'s
  `command`/`autofix` are caller-declared argv; supplied file paths are appended
  as discrete trailing argv elements and handed straight to the injected
  executor (spawn-style, no shell). File contents are read only in-process by the
  size gate to count lines, never to build a command.
- **A workflow module runs in this process**, with the full environment,
  including any provider API keys. The path argument to `ad-coder run` is
  trusted input. The CLI refuses URL specifiers, symlinks, non-regular files,
  world-writable files and files owned by another user, and warns on a
  group-writable file -- those checks are hygiene, not a sandbox.
- **Whatever a workflow returns reaches stdout.** Do not return secrets.
  Provider errors are reported as `error.message` only, never as the whole
  error object, because SDK errors commonly attach request and response detail.
- **A Role's `activeToolNames` is its capability allow-list**, and it is
  emitted to the harness unconditionally: an absent field means *every*
  registered tool, so an empty array is a real deny-all and stays one.
  `systemPrompt` is passed through verbatim -- never composed, never a
  function.
- **Run with least-privilege ambient credentials.** `pi-ai` pulls the AWS, GCP
  and Google auth credential chains, so on a cloud host anything in this
  process can reach instance-role credentials over the metadata endpoint. That
  is inert while no tools are registered and becomes real blast radius the
  moment a role activates an exec or fetch tool.
