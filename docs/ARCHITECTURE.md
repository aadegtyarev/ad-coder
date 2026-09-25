# Architecture

## Purpose

ad-coder is a Bun/TypeScript harness running coding agents through a
reviewed pipeline: human CLI, programmatic API, persistent conversations,
daemon-free control plane. The headless core owns behavior; the CLI is only
an adapter. Bun runs TypeScript and tests; `@earendil-works/pi-agent-core` is
the harness, `@earendil-works/pi-ai` the model/provider adapters; state is
private JSON/JSONL under `.ad-coder/`. Invariants: `docs/contracts/`;
design: `docs/ROADMAP.md`; open work: `docs/BACKLOG.md`.

## System map

| Area | Location | Responsibility |
|---|---|---|
| CLI | `src/cli.ts`, `src/cli/` | Parse commands; render human/JSON; call headless APIs. |
| Authentication | `src/auth/` | Store OAuth/OpenRouter keys outside targets; secret-free status. |
| Registry/profiles | `src/registry/`, `src/profiles/`, `src/config/` | Resolve providers, models, routing, config from `models.yaml` (#513). |
| Portable user profile | `src/user-profile/` | Persist calibrated routing + append-only economics; deterministic JSON import/export/recording. |
| Project calibration | `src/project-calibration/` | Anonymous snapshot; a profile naming the resolved `models.yaml` consumes its routing unless an API switch disables it. |
| Stage-attempt accounting | `src/orchestration/session.ts`, `src/project-operations/run-coordinator.ts` | Persist metrics/role identity before a limit pause; resume keeps accepted economics. |
| Roles/prompts | `src/role.ts`, `src/prompts/`, `prompts/` | Validate roles; resolve built-in/project prompts; compose versioned Researcher briefs without persisting content. |
| Runner | `src/runner/` | Execute one role turn with target-rooted tools. |
| Context | `src/context/` | Enforce context budgets; optional ad-coder-owned compaction. |
| Ledger | `src/ledger/` | Record/report usage, cost, role, tool counts. |
| Activity observability | `src/observability/tool-activity.ts`, `src/cli/tool-activity.ts` | Lifecycle into a bounded headless stream; group/transport at the CLI boundary. |
| Workflow core | `src/orchestration/` | Run the plan, research, security, code, gates, review graph. |
| Durable waits | `src/orchestration/wait-service.ts`, `src/project-store/` | Persist typed bounded waits; hosts deliver ([waiting contract](contracts/waiting.md)). |
| Durable coordination | `src/project-operations/`, `src/project-store/` | Checkpoint runs; coordinate resume; manage follow-ups, publication. |
| Quality/exploration | `src/gates/`, `src/project-tools/` | Run bounded checks; Git-ignore-aware structural reconnaissance. |
| Web/media plugins | `src/web/` | Search, read pages, inspect images; capability routing. |

## Main execution paths

### One role

`runRole` drives one role with target-rooted tools and a numeric ledger.
Standalone `role` streams activity, removes pipeline submissions, writes
`starting` before session creation, checkpoints identity/task/usage/pauses,
writes `interrupted` on SIGINT/SIGTERM, validates resume against a raised
limit; recovery verifies ownership, takes the lease, never repeats a provider
op. Incremental reviewer context projects tracked diffs and validated
untracked UTF-8 files under one byte ceiling, credential lines redacted
first. Stage limits resolve built-in global, built-in role, caller global,
caller role; zero disables; they cover workflows and standalone `role`. A
failed Researcher dispatch leaves `research_rejected`: run ID and numeric
metrics, never provider content.

### Tool activity flow

Runner and conversation adapters publish correlated harness events via
bounded replay/queues; activity stays ephemeral, only drop counts and safe
aggregates reaching results/checkpoints. Metrics separate
systemPrompt/prompt/toolDefinitions request bytes. Console rendering shares
the channel: human mode groups repeated semantic activity, JSON mode
transports schema-v1 NDJSON records on stderr; backpressure is bounded,
visible, infers no lifecycle state; stdout carries no progress.

### Built-in pipeline

```text
plan -> research? -> security? -> code -> gates? -> review
                                 ^           |
                                 | rework    |
                                 +-----------+
```

The Planner submits a structured plan naming affected surfaces and contract
coverage; research crosses a bounded, strictly validated boundary persisting
only normalized provenance. The `gates` stage exists only when quality gates
are configured — shipped by default with seven declared project gates — and
a red gate returns its captured output to the coder, never review. The
Reviewer submits a structured verdict covering every applicable surface and
contract.

`createWorkflowSession` exposes the graph stepwise; `runPipeline` drives it
automatically; custom workflows reuse the substrate. The Orchestrator
mirrors those choices: `run_role` one specialist, `run_step` plus
`choose_transition` manual control, `run_pipeline` automatic completion (the
built-in module ships enabled; `--workflows` selects or excludes members;
dispatch takes a pre-read `complexity` tier). Results carry a durable run
ID; `resume_pipeline` reopens with the original task, reuses committed
stages, resumes after a raised budget.

### Conversation and orchestrator

`startConversation` keeps one durable harness session with per-turn ledger
listeners; `startOrchestrator` adds selected project/web/image plugins,
allow-lists holding only enabled plugin tools. Workflow modules contribute
tools only when enabled; disabling the opt-in `pipeline` module removes its
synchronous/stepped/background tools; `decompose_task` runs Planner alone.
The orchestrator routes work, never starts another orchestrator, and
receives host-registered tools by default.

`explore_project` gives code-reading roles a bounded, Git-ignore-aware,
content-free map; failures name a safe cause and next action. Web tools are
replaceable plugins; `web_read` preserves normalized links; `inspect_image`
sends pixels to a capable model or one bounded vision call. Web transport
validates DNS, peer address, redirects; private-network access needs an
explicit trusted override.

### Durable control plane

The control plane stores queued intents and workflow checkpoints in
`ProjectStore`; compare-and-swap rejects stale writers. After a stop,
control runs need explicit `resume`; provider limits, manual decisions,
decomposition, publication are durable states/events.

### Session manager

The SessionManager owns one shared durable Orchestrator conversation per
project; fronts reach it only via the owner-private Unix socket's peer-uid
check (`docs/contracts/session-manager.md`).

### Background runs

Session API: start, resume, status, events, result, cancel. CLI start
persists an owner-scoped request and launches a detached worker the owner
watches via atomic updates. Subscriptions give bounded content-free tail
hints; pages expose cursor/pending-work/dropped events; polling recovers
lost history or watcher failure; leases separate live from abandoned
workers. When the pipeline is enabled, Orchestrator conversations forward
these hints; the console renders allowlisted lifecycle notices on stderr;
notices never enter model context or trigger turns. Owner scope is not
authentication; execution is not a sandbox.

## State and trust boundaries

### Target project

`targetDir` selects the project and `.ad-coder/` state location. Tools begin
there, but shell access can leave it and reach the network; sandbox untrusted
projects externally. Prompt overrides under `.ad-coder/prompts/` are trusted
operator input replacing built-in prompts byte-for-byte; `AGENTS.md` is
never auto-inserted into role prompts.

### Credentials

Credentials come from the configured store or explicit environment accessor,
never the target's configuration; paths stay canonicalized, outside target
and Git metadata, privately permissioned, atomically updated without
following symlinks. Bun's startup dotenv destroys provenance, so the
environment accessor is disabled inside `targetDir`; OAuth and the private
store stay usable. A named `models.yaml` profile composes the registry and
role-routing profile that document declares, copying neither; only its
models resolve credentials. The CLI refuses profile selections mixed with
independent provider/registry/profile sources, naming them without URLs or
credentials; the JSON inventory is gone (#513).

### Persistent content

Ledgers hold identifiers and numeric usage, not prompts, responses, tool
arguments, headers; tool-activity projections enter no ledger or checkpoint;
externally sourced strings and records are bounded before retention.
Checkpoints persist validated state, bounded normalized research
provenance, per-stage provider/model labels, duration, token categories,
provider-reported cost, context strategy. Transcripts may contain
user/assistant content: sensitive local runtime data, Git-ignored.

## Configuration model

Provider data resolves to named models; profiles map each role and
complexity to one; per-run overrides win. The Planner uses the configured
default complexity before rating; later roles use the submitted rating.

Configuration follows `docs/contracts/config.md`: alternatives
configurable, defaults favor efficiency, limits default to zero unless a
safety ceiling says otherwise; capabilities ship enabled, flags turn them
off, `config show` reports every resolved value and source without
credentials. The Planner derives allowed IDs from validation's
`CONTRACT_INDEX`; Coder omits `explore_project`, Planner uses bounded
projections, Reviewer retains reconnaissance.

Each role controller meters admissions/input/cost/time. Closeout reserves
per stage — a time, model-turn, tool-turn, and input-token reserve — come
from `DEFAULT_STAGE_LIMITS` in `src/cli/resolve-config.ts`, overridable by
flags; zero disables each. `RunCoordinator` checkpoints `stage_limit` before
returning, so `drive --resume-run <id>` continues after a configured
increase; checkpoints bind the task digest (mismatches, unknown IDs fail);
`--retry-research` clears only a rejected research pause, keeping the
accepted Planner result.

## Context and recovery

ad-coder owns its context policy. Auto mode commits a durable entry: the
harness cuts the branch, ad-coder supplies the evicted head's summary;
disabled mode never summarizes, halting when the branch stops fitting.
Refusals use the effective ceiling `min(maxTokens, contextWindow)`, reported
without transcript content; retry on a larger window or lower budget;
cross-provider summarization needs explicit authorization.

Handoff is separate from transcript compaction; modes: `incremental`,
`full`, manual `off`. First review broad; later turns default to bounded
findings, response, contract, redacted diff evidence. Missing evidence,
sensitive paths, review-control/risk changes, path-list truncation, or
material diffs widen it with a stable reason. Untracked content past the
ceiling truncates UTF-8-safely; path list and measured size survive for
`material_diff`; only a failed measurement is `projection_failure`,
recorded separately, never "no changes". Workflow state keeps decision and
diff digest, never patches; a bounded untracked addition stays focused (its
path permits explicit role reads).

Ledgers record provider-reported cost, not recomputed. Every LLM path
crosses one layered `Models` boundary — provider admission outermost, then
session limits, cost-anomaly detection, tool-call recovery; each proxy
delegates inward, the wrapper applied LAST entered FIRST. Both seams
(`runRole`, `startConversation`) wrap identically — no front bypasses
admission with its own client; session limits meter cost/turns there
(including tool follow-ups); missing trustworthy usage poisons an enabled
cost budget.

Admission bounds CONCURRENCY and RETRY RATE per provider scope — the
provider-account label, never a credential — hashed by `admissionScopeKey`,
digest-only persisted. Ships ENABLED with finite `settings.yaml`
`provider-admission` defaults; `max-concurrent-per-scope: 0` disables it in
the wiring layer, which the module refuses. Structured provider-limit errors
pause the control plane before another dispatch; retry policy is
bounded/configurable, zero interval disables timers, completed phases never
repeat on resume.

## Publication and installation

Repository publication is an explicit headless policy: read-only preflight,
exact-head approval, isolated staging, local and CI gates, squash merge;
protected branches and unrelated dirty paths fail closed.

The supported development installation is a reviewed clone with a frozen,
script-disabled dependency install and `bun link`. Artifact smoke tests
pack, verify, and install the project without lifecycle scripts or ambient
release credentials, then run `ad-coder about` and help without touching
the operator's global install; the updater accepts clean tracking
checkouts, fast-forwards, frozen-installs, relinks.

## Rules that are easy to break

- Keep every capability reachable through a headless API; fronts stay thin.
- Preserve the workflow-substrate/built-in-pipeline distinction.
- Never persist secrets or raw research/provider payloads in ledgers or
  checkpoints.
- Treat project prompts as trusted overrides; never let a worker recursively
  invoke LDO or another orchestration pipeline.
- Put enforceable rules in contracts, current structure here, future design
  in ROADMAP, unresolved work in issues.
- Keep this file a map: algorithms and incident evidence live elsewhere.
