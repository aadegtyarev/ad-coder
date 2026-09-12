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
git clone git@github.com:aadegtyarev/ad-coder.git
cd ad-coder
bun install --frozen-lockfile --ignore-scripts
bun link
ad-coder --help
ad-coder about
```

To update, inspect and pull the clone, repeat the frozen script-disabled install,
then refresh its local `bun link`. `ad-coder about --json` reports package
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

Then run the built-in reviewed pipeline. `--auto` takes default transitions and
is the non-interactive/scripted mode:

```sh
ad-coder drive "Make a small reviewed maintenance change" \
  --provider openai-codex --target-dir ./my-project --auto
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

Enter `/exit` or EOF to close it. `--json` writes one JSON record per turn.
Input defaults to 65,536 bytes per line; use `--max-input-bytes` to change it.
`--max-session-turns` and `--max-session-cost-usd` set session limits; `0`
disables either limit.

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
context-budget percentages, `--summarizer-model`, `--compaction-mode`, and
`--project-store-config`. Registry/profile JSON is explicitly selected trusted
data; the CLI never discovers configuration from `target-dir`.

Context compaction defaults to `auto`. `disabled-then-halt` refuses an
over-budget turn rather than summarizing it. Cross-provider summarization needs
`--allow-cross-provider-summarization true`; unsupported `cache-aware`
configuration fails loudly rather than degrading.

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
