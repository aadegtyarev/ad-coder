# ad-coder

A small, explicit agent scaffold on [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core):
a **Role** is a validated preset over the harness options, a **Ledger** attributes
provider token usage and cost to a role, step and run, and a **workflow module**
is a plain object the CLI loads and runs.

It builds on `pi-agent-core` rather than `pi-coding-agent`, and it disables Pi's
own compaction (whose summarization prompt is a hardcoded constant) so the
context strategy stays in ad-coder.

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

## Security notes

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
