# ad-coder

ad-coder is a Bun/TypeScript harness for a reviewed coding pipeline:
plan → optional security review → code ⇄ review. It also offers standalone roles,
an interactive pipeline driver, a conversational orchestrator, and a daemon-free
durable control plane. The headless library is the core; the CLI is a thin front.

The MVP deliberately runs tools on the invoking host. Treat target projects and
their prompts as trusted unless you restrict tools or provide an external sandbox.

## Requirements and installation

Use Bun 1.3+ (the pi packages also require Node 22.19+). Use a local,
reviewable clone so dependency resolution stays frozen and no global package
installation is mutated:

```sh
git clone https://github.com/aadegtyarev/ad-coder.git
cd ad-coder
bun install --frozen-lockfile --ignore-scripts
bun link
ad-coder --help
ad-coder about
```

To update, inspect the clone and run:

```sh
git pull --ff-only
bun install --frozen-lockfile --ignore-scripts
bun link
hash -r
ad-coder about
```

This deliberately avoids `bun install -g <git-url>`: Bun 1.3 may reuse a stale
Git snapshot and its progress display can remain at `2/2` while resolving the
provider dependency tree. `ad-coder about --json` reports package
semver, source revision when Git metadata is available, and linked-development
state. The project does not claim or test a global install/update workflow.

The registry is the authoritative CLI reference: use `ad-coder --help` and
`ad-coder <command> --help` for the exact commands and flags.

## Provider and Codex OAuth setup

The automatic provider precedence is **DeepSeek → OpenRouter → Codex OAuth**.
Set an API-key provider, or authenticate Codex when neither key is present:

```sh
export DEEPSEEK_API_KEY=...
export OPENROUTER_API_KEY=...
```

Pass `--provider deepseek|openrouter|openai-codex` to override selection. Native
OpenAI and Anthropic keys are not selected automatically by the CLI; library
callers can use the compatible provider presets.

Codex uses OAuth, not `OPENAI_API_KEY`. Sign in once:

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

Then run the built-in reviewed pipeline. `--auto` takes default transitions and
is the non-interactive/scripted mode:

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

The built-in reviewed pipeline is an opt-in workflow module. Enable it in the
conversation only when wanted:

```sh
ad-coder console --provider openai-codex --target-dir ./my-project --workflows pipeline
```

Without `--workflows pipeline`, its `run_pipeline`, `decompose_task`, `run_step`,
`choose_transition`, and `show_cost` tools are not registered. Standalone
`drive` still explicitly selects the built-in pipeline. The general `run_role`
tool remains available either way and lets the Orchestrator invoke Planner,
Researcher, Security, Coder, Reviewer, or Auditor independently.

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

There is no daemon: stopped processes leave state for explicit `control resume`.
`operations` exposes the same control actions plus backlog, LDO import,
documentation routing, and repository publishing. Both commands are
machine-oriented JSON fronts; inspect their help before creating input JSON.

`run <script.ts> --target-dir <dir>` loads a local workflow module. It refuses
URLs, symlinks, world-writable files, and files owned by another user.

## Configuration

For Codex OAuth, current defaults use `gpt-5.6-sol` with medium thinking for
Coder and the same model with low thinking for the conversational Orchestrator.
Explicit profile, spawn, and model overrides take precedence;
`--orchestrator-thinking-level` changes the console setting.

The shared role/pipeline options include provider/model tier overrides,
`--registry-config`, `--profile-config`, per-role model overrides,
context-budget percentages, `--vision-model`, `--summarizer-model`, `--compaction-mode`, and
`--project-store-config`. Registry/profile JSON is explicitly selected trusted
data; the CLI never discovers configuration from `target-dir`.

Custom registry models declare `"input": ["text", "image"]` when they accept
images; omission intentionally means text-only.

To switch a complete account/provider model inventory atomically, put named
registry and routing-profile pairs in one trusted JSON file, then select one:

```sh
ad-coder config show --inventory-config ./inventories.json \
  --inventory-profile codex-secondary --json
ad-coder drive "Implement the change" --inventory-config ./inventories.json \
  --inventory-profile codex-secondary --target-dir ./my-project --auto
```

An inventory entry has `{ "name", "registry", "profile" }`; the top-level
object has `profiles` and an optional `default`. The pair is validated together,
and inventory options cannot be mixed with separate `--provider`,
`--registry-config`, or `--profile-config` sources. `config show` exposes only
the selected name and ordinary secret-free effective configuration.
Model-selection overrides are likewise rejected while an inventory is active;
budget, context, and execution-limit overrides remain available.
Built-in plugin groups default to `explore,web,vision`; select a subset with
`--plugins`, or pass `--plugins none`. Programmatic hosts may replace them with
their own `pluginTools`.

Model-backed `role` and `drive` commands announce their stage immediately and
print a heartbeat to stderr every 10 seconds. Change it with `--heartbeat-ms`.
Provider requests time out after 120 seconds by default; use
`--request-timeout-ms`. Whole stages also default to a 10-minute deadline, 32
model calls, 128 tool calls, 500,000 provider-reported input tokens, and $2 of
provider-reported cost. Override them with `--stage-max-duration-ms`,
`--stage-max-model-turns`, `--stage-max-tool-turns`,
`--stage-max-input-tokens`, and `--stage-max-cost-usd`; zero disables the named
limit. A reached limit durably pauses the incomplete stage with explicit recovery
guidance. Zero explicitly disables heartbeat or provider-request timeout. Tool activity
retention, subscriber queues, grouping, projection, event, line, and renderer
limits use the registry-derived `--tool-activity-*` options and appear in
`config show`. Zero disables only replay, grouping delay, close draining, and
heartbeat; mandatory safety ceilings stay positive. Progress never pollutes
machine-result stdout.

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

## Development checks

```sh
bun test
bun run typecheck
bun run check
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — current system map
- [Roadmap](docs/ROADMAP.md) — decisions and future work
- [Backlog](docs/BACKLOG.md) — unresolved work
- [Contracts](docs/contracts/) — enforceable rules
- [Changelog](CHANGELOG.md) — shipped history

## License

[MIT](LICENSE) © Alexander Degtyarev
