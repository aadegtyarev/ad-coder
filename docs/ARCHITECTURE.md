# Architecture

## Purpose

ad-coder is a Bun/TypeScript harness running coding agents through a
reviewed pipeline: human CLI, machine API, persistent conversations,
daemon-free control plane; headless core owns behavior, fronts adapt it.
`@earendil-works/pi-agent-core` is the harness, `@earendil-works/pi-ai` the
provider adapters; state is private JSON/JSONL under `.ad-coder/`.
Invariants: `docs/contracts/`; design: `docs/ROADMAP.md`; open work: `docs/BACKLOG.md`.

## System map

| Area | Location | Responsibility |
|---|---|---|
| CLI | `src/cli.ts`, `src/cli/` | Parse commands; render human/JSON; call headless APIs. |
| Authentication | `src/auth/` | Store OAuth/OpenRouter keys outside targets; secret-free status. |
| Registry/profiles | `src/registry/`, `src/profiles/`, `src/config/` | Resolve providers, models, routing, config from `models.yaml` (#513). |
| Portable user profile | `src/user-profile/` | Atomically persist calibrated routing + append-only economics; deterministic JSON import/export/recording. |
| Project calibration | `src/project-calibration/` | Bounded anonymous snapshot; a profile naming the resolved `models.yaml` consumes its routing unless an API switch disables it. |
| Stage-attempt accounting | `src/orchestration/session.ts`, `src/project-operations/run-coordinator.ts` | Persist metrics/role identity before a limit pause; resume keeps accepted economics. |
| Roles/prompts | `src/role.ts`, `src/prompts/`, `prompts/` | Validate roles; resolve built-in/project prompts; versioned Researcher briefs persist no content. |
| Runner | `src/runner/` | Execute one role turn with target-rooted tools. |
| Context | `src/context/` | Enforce context budgets; optional ad-coder-owned compaction. |
| Ledger | `src/ledger/` | Record/report usage, cost, role, tool counts. |
| Activity observability | `src/observability/tool-activity.ts`, `src/cli/tool-activity.ts` | Lifecycle into a bounded headless stream; group/transport at the CLI boundary. |
| Workflow core | `src/orchestration/` | Plan, research, security, code, gates, review graph. |
| Durable waits | `src/orchestration/wait-service.ts`, `src/project-store/` | Persist typed bounded waits; hosts deliver ([waiting contract](contracts/waiting.md)). |
| Durable coordination | `src/project-operations/`, `src/project-store/` | Checkpoint runs; coordinate resume; manage follow-ups, publication. |
| Quality/exploration | `src/gates/`, `src/project-tools/` | Run bounded checks; Git-ignore-aware structural reconnaissance. |
| Web/media plugins | `src/web/` | Search, read pages, inspect images; capability routing. |

## Main execution paths

### One role

`runRole` drives one role with target-rooted tools and a numeric ledger;
standalone `role` streams activity, drops pipeline submissions, writes
`starting` before session creation and `interrupted` on SIGINT/SIGTERM,
checkpoints identity/task/usage/pauses, validates raised-limit resumes;
recovery verifies ownership, takes the lease, never repeats a
provider op. Incremental reviewer context projects tracked diffs and
validated untracked UTF-8 files under one byte ceiling, credential lines
redacted first. Stage limits resolve built-in global/role, then caller
global/role, zero disabling, for workflows and standalone `role`; a failed
Researcher dispatch leaves `research_rejected`: run ID and numeric metrics,
never provider content.

### Tool activity flow

Runner and conversation adapters publish correlated harness events via
bounded replay/queues; activity stays ephemeral, only drop counts and safe
aggregates reaching results/checkpoints; metrics separate
systemPrompt/prompt/toolDefinitions request bytes. Human mode groups
repeated activity, JSON mode transports schema-v1 NDJSON on stderr;
backpressure is bounded, visible, infers no lifecycle state; stdout carries
no progress.

### Built-in pipeline

```text
plan -> research? -> security? -> code -> gates? -> review
                                 ^           |
                                 | rework    |
                                 +-----------+
```

The Planner submits a structured plan naming affected surfaces and contract
coverage; research crosses a bounded, strictly validated boundary persisting
only normalized provenance; the Reviewer submits a structured verdict
covering every applicable surface and contract. The `gates` stage ships by
default with seven declared project gates, existing only when configured; a
red gate returns captured output to the coder, never review.

`createWorkflowSession` exposes the graph stepwise; `runPipeline` drives it
automatically; custom workflows reuse the substrate; the Orchestrator
mirrors them (`run_role` one specialist, `run_step` plus
`choose_transition` manual control, `run_pipeline` automatic completion;
built-in module ships enabled, `--workflows` selects or excludes members,
dispatch takes a pre-read `complexity` tier); `resume_pipeline` reopens by
durable run ID with the original task, reuses committed stages, resumes
after a raised budget.

### Conversation and orchestrator

`startConversation` keeps one durable harness session with per-turn ledger
listeners; `startOrchestrator` adds selected project/web/image plugins,
allow-listing only enabled plugin tools; workflow modules contribute tools
only when enabled; disabling the opt-in `pipeline` module removes its
synchronous/stepped/background tools;
`decompose_task` runs Planner alone. The orchestrator routes work, never
starts another orchestrator, receives host-registered tools by default.

`explore_project` gives code-reading roles a bounded, Git-ignore-aware,
content-free map, failures naming safe causes and next actions; `web_read`
preserves normalized links, `inspect_image` sends pixels to a capable model
or one bounded vision call; web transport validates DNS, peer address,
redirects; private-network access needs an explicit trusted override.

### Durable control plane

The control plane stores queued intents and workflow checkpoints in
`ProjectStore`; compare-and-swap rejects stale writers. After a stop,
control runs need explicit `resume`; provider limits, manual decisions,
decomposition, publication are durable states/events.

### Session manager

`docs/contracts/session-manager.md` gates this: one durable Orchestrator
session per project, reached only through the SessionManager's
owner-private Unix-socket peer-uid check.

### Background runs

Session API: start, resume, status, events, result, cancel; CLI start
persists an owner-scoped request, launching a detached worker the owner
watches via atomic updates; leases separate live from abandoned workers.
Subscriptions give bounded content-free tail hints; pages expose
cursor/pending-work/dropped events, polling recovering lost history or
watcher failure. With the pipeline enabled, Orchestrator conversations
forward them; the console renders allowlisted lifecycle notices on stderr,
never model context or turns. Owner scope is not authentication; execution
is not a sandbox.

## State and trust boundaries

### Target project

`targetDir` selects project and `.ad-coder/` state location; tools begin
there, but shell access can leave it and reach the network; sandbox
untrusted projects externally. Prompt overrides under `.ad-coder/prompts/`
are trusted operator input replacing built-in prompts byte-for-byte;
`AGENTS.md` is never auto-inserted into role prompts.

### Credentials

Credentials use the configured store or explicit environment accessor,
never the target's config; paths stay canonicalized, outside target/Git
metadata, private-permissioned, atomically updated without
following symlinks. Bun's startup dotenv destroys provenance, disabling the
environment accessor inside `targetDir`; OAuth and the private store stay
usable. A named `models.yaml` profile composes the registry and
role-routing profile it declares, copying neither; only its models resolve
credentials.

### Persistent content

Ledgers hold identifiers and numeric usage, not prompts, responses, tool
arguments, headers; externally sourced strings and records are bounded
before retention.
Checkpoints persist validated state, bounded normalized research
provenance, per-stage provider/model labels, duration, token categories,
provider-reported cost, context strategy. Transcripts may contain
user/assistant content: sensitive local runtime data, Git-ignored.

## Configuration model

Provider data resolves to named models; profiles map each role and
complexity to one; per-run overrides win; the Planner uses the configured
default complexity before rating, later roles the submitted rating.

Configuration follows `docs/contracts/config.md`: alternatives
configurable, defaults favor efficiency, limits default to zero unless a
safety ceiling says otherwise; `config show` reports every resolved value
and source without credentials. The Planner derives allowed IDs from
validation's `CONTRACT_INDEX`; Coder omits `explore_project`, Planner uses
bounded projections, Reviewer retains reconnaissance.

Each role controller meters admissions/input/cost/time; closeout reserves
per stage (time, model-turn, tool-turn, input-token) come from
`DEFAULT_STAGE_LIMITS` in `src/cli/resolve-config.ts`, overridable by flags
(zero disables each). `RunCoordinator` checkpoints `stage_limit` before
returning, so `drive --resume-run <id>` continues after a configured
increase; checkpoints bind the task digest (mismatches, unknown IDs fail);
`--retry-research` clears only a rejected research pause, keeping the
accepted Planner result.

## Context and recovery

ad-coder owns its context policy; auto mode commits a durable entry (the
harness cuts the branch, ad-coder supplies the evicted head's summary);
disabled mode never summarizes, halting when the branch stops fitting.
Refusals use the effective ceiling `min(maxTokens, contextWindow)`, reported
without transcript content; retry on a larger window or lower budget;
cross-provider summarization needs explicit authorization.

Handoff is separate from transcript compaction; modes: `incremental`,
`full`, manual `off`. First review broad; later turns default to bounded
findings, response, contract, redacted diff evidence; missing evidence,
sensitive paths, review-control/risk changes, path-list truncation, or
material diffs widen it with a stable reason. Untracked content past the
ceiling truncates UTF-8-safely, path list and measured size surviving for
`material_diff`; only measurement failure is `projection_failure`,
never "no changes". Workflow state keeps decision and
diff digest, never patches; a bounded untracked addition stays focused (its
path permits explicit role reads).

Ledgers record provider-reported cost, not recomputed; every LLM path
crosses one layered `Models` boundary — provider admission outermost, then
session limits, cost-anomaly detection, tool-call recovery; each proxy
delegates inward, wrappers applied last-entered-first, identically at both
seams (`runRole`, `startConversation`), so no front bypasses admission with
its own client; session limits meter cost/turns there (including tool
follow-ups); missing trustworthy usage poisons an enabled cost budget.

Admission bounds CONCURRENCY and RETRY RATE per provider scope (the
provider-account label, never a credential), hashed by `admissionScopeKey`,
digest-only persisted. Ships ENABLED with finite `settings.yaml`
`provider-admission` defaults; `max-concurrent-per-scope: 0` disables it in
the wiring layer (the module refuses); retry policy is bounded/configurable,
zero interval disables timers, completed phases never repeat on resume.

## Publication and installation

Repository publication is an explicit headless policy: read-only preflight,
exact-head approval, isolated staging, local and CI gates, squash merge;
protected branches and unrelated dirty paths fail closed.

The supported development installation is a reviewed clone with a frozen,
script-disabled dependency install and `bun link`; artifact smoke tests
pack, verify, and install the project without lifecycle scripts or ambient
release credentials, then `ad-coder about` and help without touching
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
