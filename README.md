# ad-coder

ad-coder is a Bun/TypeScript harness for a reviewed coding pipeline:
plan → optional security review → code ⇄ review. It also offers standalone roles,
an interactive pipeline driver, a conversational orchestrator, and a daemon-free
durable control plane. The headless library is the core; the CLI is a thin front.

The MVP deliberately runs tools on the invoking host. Treat target projects and
their prompts as trusted unless you restrict tools or provide an external sandbox.

## Requirements and installation

Use Bun 1.3+ (the pi packages also require Node 22.19+). Install the CLI globally
from the GitHub repository:

```sh
bun add -g github:aadegtyarev/ad-coder#main
ad-coder --help
ad-coder about
```

Then update it without remembering the package manager command:

```sh
ad-coder update
```

The updater updates the package that is actually running. A linked checkout gets
`git pull --ff-only`, `bun install`, and `bun link`; a GitHub install (one whose
directory carries Bun's `.bun-tag`) resolves GitHub `main`, installs its exact
commit SHA, then reads back the revision Bun actually recorded; a registry
install (`ad-coder` or the development channel `ad-coder-dev` from npm) first
resolves what the registry offers with `bun pm view <name> version`, then runs
`bun add --global --force <running-package>@latest` and verifies the version the
package root carries afterwards; an install already at the resolved version is
reported as current and installs nothing. A zero exit from `bun add` is never
treated as evidence: a stale global lockfile pin makes `bun add --force`
reinstall the previous version and still exit zero, which surfaces as
`install_mismatch` with the lockfile to repair, and `install_unverifiable` when
no installed version can be read at all. The updater never installs a package
whose name differs from the one running, and an identity it cannot establish is
`identity_unknown` rather than a guess.

ad-coder is published in two channels, and they install side by side because
they are two different binaries. `ad-coder` is the stable channel: a release,
published from a version tag. `ad-coder-dev` is the channel for developers --
the same CLI, published from every merge to `main`, versioned as the release it
carries plus the build number (for example `0.64.2-dev.19`):

```sh
bun add -g ad-coder-dev
ad-coder-dev --help
ad-coder-dev about
```

Install it with `bun add -g`, not `npm install -g`: `ad-coder-dev update`
resolves its channel through Bun and installs into Bun's global directory, so an
install placed by npm would be updated by a different package manager than the
one that put it there. The dev channel is a build of `main` -- it is how a
second developer gets current behaviour without cloning the repository, and it
is not what a user who wants a released version installs.

A linked checkout remains supported:

```sh
git clone https://github.com/aadegtyarev/ad-coder.git
cd ad-coder
bun install --frozen-lockfile --ignore-scripts
bun link
```

In linked mode, `ad-coder update` refuses dirty, detached, or untracked branches
and performs:

```sh
git pull --ff-only
bun install --frozen-lockfile --ignore-scripts
bun link
```

The registry is the authoritative CLI reference: use `ad-coder --help` and
`ad-coder <command> --help` for the exact commands and flags.

## Provider and Codex OAuth setup

The automatic provider precedence is **DeepSeek → OpenRouter → Codex OAuth**.
API-key providers can use an environment variable. OpenRouter may instead be
stored in ad-coder's private credential store:

```sh
export DEEPSEEK_API_KEY=...
export OPENROUTER_API_KEY=...
ad-coder auth login --provider openrouter
```

Pass `--provider deepseek|openrouter|openai-codex` to override selection. Native
OpenAI and Anthropic keys are not selected automatically by the CLI; library
callers can use the compatible provider presets.

Codex uses OAuth, not `OPENAI_API_KEY`, so it is the one provider whose
`models.yaml` row carries the reserved literal `credential: oauth` instead of an
env-var name. Sign in once:

```sh
ad-coder auth status
ad-coder auth login --method browser
# For a headless host:
ad-coder auth login --method device_code
ad-coder auth status --json
```

Credentials are held outside the project at
`$XDG_CONFIG_HOME/ad-coder/credentials.json` when that variable is absolute,
otherwise at `~/.config/ad-coder/credentials.json`. The store is owner-only,
locked, and atomically updated; status never returns a token. An absolute
`--credential-path` selects another private user-local file. Relative,
project, Git-metadata, and project-aliasing symlink paths are rejected.

Use `ad-coder auth logout` to remove the stored login. Missing or expired
credentials fail before a model request and direct you to `auth login`.
Because Bun loads dotenv files before application code, CLI runs whose process
working directory is inside the target disable all environment credentials.
OAuth and the private credential store remain available. Run from a directory
outside the target when intentionally using an environment-key provider.

## First run

Choose an existing target project. `console` defaults to the invocation working
directory; its explicit `--target-dir` overrides that default and `~/` is
resolved against the user home. Other role/pipeline commands require
`--target-dir`. Targets are realpath-resolved. A target is a starting
working directory, **not a sandbox**: a role with `bash` can leave it, read
files available to you, and use the network. Credentials remain outside the
target project; do not run untrusted tasks with unrestricted tools.

First run one role:

```sh
ad-coder role planner "Summarize this repository" \
  --provider openai-codex --target-dir ./my-project
```

The standalone roles are `planner`, `researcher`, `coder`, `reviewer`, `auditor`,
and `security`. Researcher and Auditor have independent profile cells and may be
overridden with `--researcher-model` and `--auditor-model`.
Each run writes a durable checkpoint. After a stage-budget pause, rerun the same
role and task with `--resume-run <id>` and a larger or disabled reported limit;
ad-coder reuses the existing session and ledger.
Provider/model identity and cumulative stage usage remain bound across resumes.

Portable user profiles have an always-JSON machine front. `show` includes the
private store path, `export` emits only the portable document, and imports are
explicitly previewed or applied:

```sh
ad-coder profile export > profile.json
ad-coder profile import-preview --input profile.json --mode merge
ad-coder profile import-apply --input profile.json --mode merge
ad-coder profile snapshot --inventory work --target-dir ./my-project
```

For subscription-credit calibration, append an account-free server balance
observation with `profile record --input <record.json>`. Use
`kind: "credit_balance"`, a stable provider/model scope, `unit: "credits"`, and
`source: "provider-measurement"`. Record the refill price separately as a normal
`price` record using `unit: "USD/credit"`; for a 500-credit refill costing $10,
the value is `0.02`. Two balance observations linked by `previousId` measure
credits consumed without exporting account identity or raw provider responses.

The snapshot contains only the selected inventory, calibrated routing, current
economics, and capacity ranges. A matching named inventory automatically uses
its project routing; API callers can set `useProjectCalibration: false`.

Validate and smoke-test the calibration corpus with
`bun run calibration:corpus -- smoke`.

Then run the built-in reviewed pipeline. Its workflow module is enabled by
default, and before any review round it runs the project's declared quality
gates — the shipped set is seven whole-project commands such as `bun run
typecheck` and `bun run check` — returning to the coder with captured output
while a gate stays red. A project that needs different checks substitutes its
own gate list through the pipeline configuration API. `--auto` takes default
transitions and is the non-interactive/scripted mode:

```sh
ad-coder drive "Make a small reviewed maintenance change" \
  --provider openai-codex --target-dir ./my-project --auto
```

If bounded Researcher output is rejected, inspect the checkpoint and retry only
that research dispatch without rerunning Planner:

```sh
ad-coder drive "Make a small reviewed maintenance change" \
  --target-dir ./my-project --resume-run <id> --retry-research --auto
```

When a planner role is configured, it must submit a structured affected-surface
and contract-coverage analysis. Missing analysis and unresolved research gaps
stop before coding; `--auto` does not bypass this requirements gate.

Without `--auto`, `drive` pauses after every role for a transition choice. A
standalone `role` is single-turn: its accepted `--max-rounds` has no effect,
while it limits pipeline review rounds.

Start a persistent conversational orchestrator with:

```sh
ad-coder console --provider openai-codex --target-dir ./my-project
```

Pass `--resume <run-id>` (or bare `--resume` for the most recent orchestrator
session) to continue a previous conversation instead of starting a fresh one:
the named run's durable session reopens, prior turns are back in context, and
`show_cost` stays cumulative over the earlier ledger. A run id that has no
ledger or session, or that is malformed, is refused before anything is
created.

Every shipped capability is enabled at startup: the conversation carries the
built-in pipeline module, its tools, and the skill catalogue without any flag.
`/start <task>`, `/list`, `/events <run-id>`, `/status <run-id>`,
`/result <run-id>`, or `/cancel <run-id>` manage detached work locally without
a model request. `/start` takes the rest of the line verbatim as the task and
detaches the run, so the dialogue stays yours while it proceeds. To turn a
capability off for one session, pass `--workflows=false` (or select or exclude
modules with `--workflows <names|^name>`); the background commands then report
as unavailable and name the switch that enables them. `--skills <names>` pins
an exact skill set in place of the catalogue, and `--no-skills` disables
skills entirely; a persistent switch lives in the user profile under
`capabilities` (see [Configuration](#configuration)). `ad-coder config show`
reports each capability's resolved state and where it came from.

Enter `/help` to list every console command with its arguments and an example.
The listing is rendered from the same command registry the console dispatches
from, and marks the background commands as unavailable whenever the session
was started with `--workflows=false`.

In an interactive terminal, press `Escape` to interrupt only the current
orchestrator turn. The conversation stays open and detached pipelines continue.
`/help`, `/interrupt`, and `/exit` are always available. `/interrupt` provides
the same turn-only interruption for scripted terminals.

With `--workflows=false`, the pipeline's `run_pipeline`, `decompose_task`,
`run_step`, `choose_transition`, and `show_cost` tools are not registered. Standalone
`drive` still explicitly selects the built-in pipeline. The general `run_role`
tool remains available either way and lets the Orchestrator invoke a worker
role independently; which roles this session actually has and on which models
is stated in that tool's description, assembled from the resolved routing the
startup banner prints.

Enter `/exit` or EOF to close it. While a turn runs, semantic `Read`,
`Search`, `Edit`, `Run`, `Web`, and `Inspect image` summaries appear on stderr.
Repeated activity is grouped; the heartbeat returns only after an inactive
interval. `--heartbeat-ms 0` disables heartbeat without disabling activity.

With `--json`, final turn records remain the only stdout output. Progress is
schema-v1 NDJSON on stderr: `tool_activity` records carry lifecycle, sequence,
role/run/operation/turn/tool-call correlation and safe bounded metadata;
`tool_activity_drop` reports core consumer or queue loss, while
`tool_activity_render_drop` reports bounded stderr transport loss. A nonzero
`droppedCount` means the view is incomplete, so slow consumers should reconnect
with replay or increase the documented `--tool-activity-*` limits.
Argument-derived labels are category-only by default. Commands, paths, queries,
URLs, prompts, contents, credentials, and arbitrary custom-tool names are omitted.
Expected console failures are stable `console_error` stderr records in JSON mode.

Library callers can pass a `ToolActivityChannel` to `runRole`, pipeline, or
conversation configuration, pass an `activityConsumer`, or call
`ConversationSession.subscribeToolActivity`. Subscribers are optional and
isolated: rejection and overflow cannot fail a role and are reflected in the
channel snapshot and turn/run drop count.

Input defaults to 65,536 bytes per line; use `--max-input-bytes` to change it.
`--max-session-turns` and `--max-session-cost-usd` set session limits; `0`
disables either limit.

The Orchestrator and every code-reading pipeline role can use
`explore_project`, a bounded structural view that follows Git's standard ignore
rules. The console also provides DuckDuckGo `web_search`, navigable `web_read`,
and `inspect_image`. If the active role is text-only, configure an image-capable
registered model with `--vision-model <name>`; otherwise image inspection fails
clearly instead of silently dropping pixels. `decompose_task` runs Planner only
when you want surfaces and contract coverage without starting implementation.

## Durable runs and operations

`control` is the JSON front for durable daemon-free pipelines. It starts,
inspects, resumes, cancels, triages, reports, publishes, resolves decisions, and
sets `run-until` breakpoints:

```sh
ad-coder control start --target-dir ./my-project --input request.json
ad-coder control list --target-dir ./my-project
ad-coder control status --target-dir ./my-project --id <run-id>
```

There is no daemon: control runs leave state for explicit `control resume`.
For detached execution, use the background API or CLI. The seven orchestrator
background tools are `start_pipeline`, `pipeline_status`, `pipeline_events`,
`pipeline_result`, `cancel_pipeline`, `resume_pipeline`, and the regular
`run_pipeline` completion path. The CLI equivalent is `background start|status|
events|result|cancel`; `background start` returns immediately and a detached
worker continues the run. Reconnect with the same `--owner-id`, consume events
using the exclusive `--after` cursor, and use the terminal result or
`resume_pipeline` recovery path after failure or operator attention. Events are
bounded, content-free lifecycle projections; ownership scopes access to a
private target-local record.

### Live background notices

For an operator who keeps `console` open while a detached pipeline runs, use
`console --owner-id <opaque-id>` (or its stable OS-identity
default). The console supplies the detached host launcher, so `start_pipeline` works and lifecycle,
stage, dropped-event, and terminal notices arrive on stderr while input remains
usable. In `--json` mode these are content-free
`background_events` NDJSON records on stderr; final turn records remain on
stdout. Notices never submit a model turn. A notice is only a bounded hint: when
it reports `pending` or `droppedEvents`, recover the complete ordered history
with `pipeline_events` (or `background events`) and its `nextCursor`; reconnect
with the same owner ID and poll `pipeline_status`, `pipeline_events`, and
`pipeline_result` after a console or process reconnect.

Library callers can subscribe with `BackgroundRunManager.subscribe(consumer)`
or `ConversationSession.subscribeBackgroundRuns(consumer)`. Each owner-scoped
notice contains only safe lifecycle metadata, is capped by the configured
mandatory `maxPageSize` and `maxPageBytes`, and returns an unsubscribe function.
Subscribers begin at the current tail; cursor polling remains the durable,
reconnect-safe source of truth. `--background-subscriber-queue-capacity` is a
mandatory positive 1–1024 safety ceiling (default 16) to absorb brief stderr
bursts without unbounded memory. The CLI/API accepts numeric limits. Ordinary
resource limits use `0` as disabled, while `maxPageSize` defaults to 32 events
and `maxPageBytes` to 16 KiB; both paging ceilings are mandatory positive
values. Programmatic detached callers inject a host launcher into
`BackgroundRunManager`; it receives the task, run ID, and effective limits, and
`startDetached` succeeds only after that launcher admits the worker. Launcher
failure records a content-free terminal failure with `inspect_events` recovery.
These features execute on the invoking host,
so target/task input is trusted only to the same extent as all other tools.
`operations` exposes the same control actions plus backlog, LDO import,
documentation routing, and repository publishing. Both commands are
machine-oriented JSON fronts; inspect their help before creating input JSON.

`run <script.ts> --target-dir <dir>` loads a local workflow module. It refuses
URLs, symlinks, world-writable files, and files owned by another user.

## Configuration

Routing is `~/.config/ad-coder/models.yaml` and behaviour is
`~/.config/ad-coder/settings.yaml` (or under `$XDG_CONFIG_HOME/ad-coder/`). Both
are ordinary YAML you edit by hand; `config show` prints what they resolved to
and which layer decided each value. With no `models.yaml`, the built-in Codex
defaults apply: `gpt-5.6-sol` at medium thinking for the Coder and at low
thinking for the conversational Orchestrator. Explicit profile, spawn, and model
overrides take precedence; `--orchestrator-thinking-level` changes the console
setting.

`models.yaml` has three top-level keys: `providers`, `profiles`, and an optional
`default` naming the profile a run uses when none is selected.

```yaml
providers:
  openrouter:
    enabled: true
    api: openai-completions
    baseUrl: https://openrouter.ai/api/v1
    credential: OPENROUTER_API_KEY
    models:
      "deepseek/deepseek-v4.1-flash":
        input: 0.15
        output: 0.6
        cacheRead: 0.003
        contextWindow: 200000
        maxTokens: 32768
  openai-codex:
    enabled: true
    api: openai-codex-responses
    baseUrl: https://chatgpt.com/backend-api
    credential: oauth
    models:
      "gpt-5.6-terra":
        input: 2
        output: 12
        cacheRead: 0.2
        cacheWrite: 2.5
        contextWindow: 200000
        maxTokens: 128000

default: fast
profiles:
  fast:
    orchestrator:
      - openrouter:deepseek/deepseek-v4.1-flash
    planner:
      - openrouter:deepseek/deepseek-v4.1-flash
    researcher:
      - openrouter:deepseek/deepseek-v4.1-flash
    summarizer:
      - openrouter:deepseek/deepseek-v4.1-flash
    auditor:
      - openrouter:deepseek/deepseek-v4.1-flash
    security:
      - openrouter:deepseek/deepseek-v4.1-flash
    coder:
      - openrouter:deepseek/deepseek-v4.1-flash
    coder@complex:
      - model: openai-codex:gpt-5.6-terra
        thinkingLevel: low
    reviewer:
      - openai-codex:gpt-5.6-terra
```

A provider block declares `enabled`, the `api` protocol, a `baseUrl`, the
credential REFERENCE, and one row per model keyed by the provider's own model id
-- that key is the name a route spells after the colon. `config migrate`
converts a stored `inventories.json` into this file; the stored inventory is no
longer a routing source, and ad-coder refuses loudly when it finds one without a
`models.yaml` beside it.

`credential` is a REFERENCE, never a secret: a bare word names the env-var the
resolver reads, and the reserved literal `oauth` selects the OAuth route whose
token lives in the credential store. Codex is OAuth-only -- there is no env-var
to name -- so `credential: oauth` is the only spelling that reaches it. An
enabled provider that declares no credential is refused by name.

A row key is the role (`coder`) or the tier override (`coder@complex`), and its
value is an ordered ladder: the first rung that can be served wins, so a
fallback is a second list entry. A rung is `provider:model`, or a mapping when
it also carries `thinkingLevel` (`off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`). A `role@complexity` row replaces the bare row for that tier and
may not exist without it. A profile a run selects must route every role that run
needs -- the eight are `orchestrator`, `planner`, `researcher`, `coder`,
`reviewer`, `auditor`, `security`, and `summarizer` -- and a run refuses by name
the `(role, complexity)` pair it could not resolve.

A provider whose API mandates a non-auth request header -- a routing or tenancy
marker -- declares it once on the provider, with `{{session}}` for an opaque
per-run identifier:

```yaml
  opencode-go:
    headers:
      x-opencode-session: "{{session}}"
```

`headers` is **not a credential channel**: values are literal config text sent
verbatim, so names that carry or displace authentication (`authorization`,
`x-api-key`, `cookie`, ...) and names the HTTP client owns (`user-agent`,
`content-type`, ...) are rejected. An API key belongs in `credential`.
`{{session}}` is stable for every model of a run and new for the next; it
carries no credential or project data, and an unknown placeholder is rejected
rather than transmitted literally.

A model may override `baseUrl` when one account fronts two request APIs under
different path prefixes, since each adapter appends its own suffix to whatever
base URL it is given. Both the provider and model forms are https-only. A model
row also accepts `tools`, `format`, and `concurrency`.

The shared role/pipeline options include provider/model tier overrides,
`--registry-config`, `--profile-config`, per-role model overrides,
context-budget percentages, `--vision-model`, `--summarizer-model`,
`--compaction-mode`, and `--project-store-config`. Registry/profile JSON is
explicitly selected trusted data; the CLI never discovers configuration from
`target-dir`.

The registry JSON form behind `--registry-config` adds what the YAML store
deliberately leaves out: a provider may name a shipped model `catalog` and take
ids, prices, context windows, token ceilings, base URLs and supported thinking
levels from the pinned pi-ai data rather than restating them, and a model may
declare `"input": ["text", "image"]` when it accepts images. Anything you
declare still wins, an id the catalog does not publish is rejected rather than
resolved with invented economics, and an account-scoped id such as an OpenRouter
`@preset/...` is admitted by marking it `"catalog": false` and supplying its
`cost` and `maxTokens` by hand. See
[provider catalogs](docs/provider-catalogs.md).

To switch a complete account/provider model inventory atomically, put named
registry and routing-profile pairs in one trusted JSON file, then select one:

```sh
ad-coder config show --inventory-config ./inventories.json \
  --inventory-profile codex-secondary --json
```

An inventory entry has `{ "name", "registry", "profile" }`; the top-level
object has `profiles` and an optional `default`. The pair is validated together,
and inventory options cannot be mixed with separate `--provider`,
`--registry-config`, or `--profile-config` sources, which likewise act only as
per-run overrides. `config show` exposes only the selected name and ordinary
secret-free effective configuration. Model-selection overrides are rejected
while an inventory is active; budget, context, and execution-limit overrides
remain available.
Built-in plugin groups default to `explore,web,vision`; select a subset with
`--plugins`, or pass `--plugins none`. Programmatic hosts may replace them with
their own `pluginTools`.

Model-backed `role` and `drive` commands announce their stage immediately and
print a heartbeat to stderr every 10 seconds. Change it with `--heartbeat-ms`.
Provider requests time out after 120 seconds by default; use
`--request-timeout-ms`. Whole stages also carry a deadline, a model-call ceiling,
a tool-call ceiling, and ceilings on provider-reported input tokens and cost. The
global defaults are 45 minutes, 144 model calls, 576 tool calls, 2,400,000 input
tokens, and $6, and every role except `orchestrator` overrides them with tighter
ceilings of its own — slice-planning, for instance, runs at 810,000 ms / 45 model
calls / 1,200,000 input tokens, and the coder at 2,160,000 ms / 90 / 1,920,000.
`config show` reports the global values and whether each came from a flag; the
per-role ceilings live in `DEFAULT_ROLE_STAGE_LIMITS` in
`src/cli/resolve-config.ts`, which is the table to edit to change a role's own
ceiling.

Passing a global `--stage-max-duration-ms`, `--stage-max-model-turns`,
`--stage-max-tool-turns`, `--stage-max-input-tokens`, or `--stage-max-cost-usd`
flag **replaces every role's ceiling** for that dimension with the one value
passed; it is a flattening override, not a floor, so raising the global cost
ceiling raises what the coder may spend and the planner too. Zero disables the
named limit. A reached limit durably pauses the incomplete stage with explicit
recovery guidance. Final-response reserves stop new tools before the hard limits;
configure them with the `--stage-final-response-reserve-*` options, whose defaults
protect 12 model turns, 90 seconds, 24 tool turns, and 300,000 input tokens inside
an enabled stage budget. A per-role ceiling can also be set by a host embedding
the pipeline (`roleStageLimits` in the pipeline config, which is the last overlay
and wins over both a role default and a global flag); there is no CLI flag for it
today. This is independent of context `--role-budget-percents`.
Zero explicitly disables heartbeat or provider-request timeout. Tool activity
retention, subscriber queues, grouping, projection, event, line, and renderer
limits use the registry-derived `--tool-activity-*` options and appear in
`config show`. Zero disables only replay, grouping delay, close draining, and
heartbeat; mandatory safety ceilings stay positive. Progress never pollutes
machine-result stdout.

### Capabilities and their resolved state

Every capability ad-coder ships is enabled at startup; a persistent switch, an
explicit launch parameter, and the built-in default resolve in that layered
order, and an explicit parameter beats the setting. It is reported in `config
show`, never silent:

```sh
ad-coder config show --json
```

The `skills` row names the resolved catalogue — id, version, source tier, and
digest per skill, plus an explicit `enabled` switch — and the `workflows` row
names the selected modules. Each row carries the source layer that decided it:
an explicit flag, the profile setting, or the built-in default.
`--workflows false`, a selective `--workflows <names|^name>` list,
`--skills <names>`, and `--no-skills` are per-run switches; their explicit
words also cross into a detached background worker verbatim, so what you typed
at the console is what the invisible process runs. The credential-source
launch parameter repeats the same way: when `--credential-path <file>` was
typed at the console, the detached worker resolves the same private credential
file (a path crosses the boundary, never a credential value); when it was not
typed, the worker resolves its own default file. The parameter is never
persisted into the profile or the run record.

To keep a capability off persistently instead of typing the flag every launch,
set it in the private user profile at `~/.config/ad-coder/profile.json`:

```json
{ "capabilities": { "skills": false } }
```

An explicit flag on the command line always outruns this setting, and the
resolved state stays visible in `config show`.

Context compaction defaults to `auto`. `disabled-then-halt` refuses an
over-budget turn rather than summarizing it. Every refusal measures the request
against the effective ceiling `min(maxTokens, contextWindow)`, so a runtime model
with a smaller window is reported accurately. Choose a model with a sufficiently
large context window or reduce the role's context-budget settings, then retry.
Cross-provider summarization needs `--allow-cross-provider-summarization true`;
unsupported `cache-aware` configuration fails loudly rather than degrading.

Target-local `.ad-coder/prompts/<role>.md` overrides are trusted operator
configuration, not an isolation boundary. Runtime state lives in
`<target-dir>/.ad-coder/` with its own ignore file; ad-coder does not modify a
target project's root `.gitignore`.

## Diagnose problems

Start with:

```sh
ad-coder --help
ad-coder auth status --json
ad-coder role --help
ad-coder control --help
```

On a headless host, retry OAuth with `device_code`. If the wrong provider wins,
remove a higher-precedence key from the process environment or pass `--provider`.
For rejected model/configuration names, inspect the selected JSON and command
help. An empty, zero-cost role response warns; missing Codex auth instead fails
before generation.

Inspect `<target-dir>/.ad-coder/` plus `control status`, `control report`,
and `control list` for durable-run diagnostics. Never publish credential files
or environment-variable values.

When a run refuses to start with a cost-anomaly block, the provider billed
materially more than the price you configured for that model, and new runs on
that `provider/model` scope are held until you accept the new price:

```sh
ad-coder cost status --target-dir <dir>
ad-coder cost release <provider>/<model> --target-dir <dir>
```

`cost status` reports every blocked scope with the amount charged, the amount
your configured prices predicted for the same responses, and the ratio between
them -- two numbers you can check against the provider's own invoice. Because
the comparison is against your declared price rather than against recent
traffic, a discount is never an anomaly and neither is a discount ending, and
the size or cache-hit rate of a response cannot move the ratio. A provider that
does not report what it billed is reported as having no charge data and is
never blocked. Block state lives under the project's
own `.ad-coder/`, so `--target-dir` is required and must name the project whose
run was refused. The block is per scope: other models keep running, and `cost
release` names a scope exactly as the refusal spelled it. Releasing a scope that
carries no block is reported as an error rather than silently succeeding, so a
mistyped scope cannot read as released while the real block stays up.

To read what a run actually cost — model calls, fresh, cached, and output
tokens, provider-reported spend, tool mix, per role, per model, and totals —
inspect its ledger from the project directory with:

```sh
cd <dir> && ad-coder ledger report
```

With no file arguments it reads every `.ad-coder/ledger/*.jsonl`
file, skipping malformed or still-being-written lines with a per-file count
instead of crashing or returning a silently empty total. The report carries
identifiers and numbers only: never task text, prompts, or tool arguments.

## Development checks

```sh
bun test
bun run typecheck
bun run check
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — current system map
- [Provider catalogs](docs/provider-catalogs.md) — declaring providers without hand-written prices
- [OpenCode Go economics](docs/opencode-go-economics.md) — what a subscription buys per model
- [Roadmap](docs/ROADMAP.md) — decisions and future work
- [Backlog](docs/BACKLOG.md) — index of the GitHub issues holding unresolved work
- [Benchmark role fitness](docs/benchmark-role-fitness.md) — what public
  benchmarks can and cannot say about routing a role
- [Contracts](docs/contracts/) — enforceable rules
- [Changelog](CHANGELOG.md) — shipped history

## License

[MIT](LICENSE) © Alexander Degtyarev
