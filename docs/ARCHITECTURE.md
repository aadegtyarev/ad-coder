# Architecture

## Purpose

ad-coder is a Bun/TypeScript harness for running coding agents through a
reviewed pipeline. It supports a human CLI, a programmatic API, persistent
conversations, and a daemon-free control plane. The headless core owns behavior;
the CLI is only an adapter.

This document is a map for contributors. Detailed invariants live in
`docs/contracts/`, accepted future design lives in `docs/ROADMAP.md`, and open
work lives in GitHub issues indexed by `docs/BACKLOG.md`.

## Runtime and dependencies

- Bun executes TypeScript directly and runs the test suite.
- `@earendil-works/pi-agent-core` provides the agent harness.
- `@earendil-works/pi-ai` provides model and provider adapters.
- Project state is stored as private JSON or JSONL under `.ad-coder/`.
- No database or daemon is required.

## System map

| Area | Location | Responsibility |
|---|---|---|
| CLI | `src/cli.ts`, `src/cli/` | Parse commands, render human or JSON output, and call headless APIs. |
| Authentication | `src/auth/` | Store Codex OAuth and OpenRouter API-key credentials outside target projects and expose secret-free status. |
| Model inventories | `src/inventory/` | Seed, persist, validate, and resolve named registry/routing profiles. |
| Registry and profiles | `src/registry/`, `src/profiles/` | Resolve providers, models, role routing, and effective configuration. |
| Portable user profile | `src/user-profile/` | Atomically persist validated inventories, calibrated routing, and append-only economics; expose deterministic JSON import, export, and recording. |
| Project calibration | `src/project-calibration/` | Materialize a bounded anonymous snapshot at `.ad-coder/calibration.json`; matching inventories consume its routing unless an API switch disables it. |
| Stage-attempt accounting | `src/orchestration/session.ts`, `src/project-operations/run-coordinator.ts` | Persist partial metrics and role identity before a limit pause, then resume without losing accepted-result economics. |
| Roles and prompts | `src/role.ts`, `src/prompts/`, `prompts/` | Validate roles, resolve built-in or project prompts, and compose versioned model-inventory Researcher briefs without persisting content. |
| Runner | `src/runner/` | Execute one role turn with tools rooted at the target directory. |
| Context | `src/context/` | Enforce context budgets and optional ad-coder-owned compaction. |
| Ledger | `src/ledger/` | Record usage, cost, role, step, and tool-call counts without content. |
| Activity observability | `src/observability/tool-activity.ts`, `src/cli/tool-activity.ts` | Project harness lifecycle into a bounded headless stream; group or transport it at the CLI boundary. |
| Workflow core | `src/orchestration/` | Run the plan, research, security, code, and review graph. |
| Durable coordination | `src/project-operations/`, `src/project-store/` | Checkpoint runs, coordinate resume, and manage follow-ups and publication. |
| Quality and exploration | `src/gates/`, `src/project-tools/` | Run bounded checks and Git-ignore-aware structural reconnaissance. |
| Web and media plugins | `src/web/` | Search, read navigable pages, and inspect images with capability routing. |

## Main execution paths

### One role

`runRole` drives one validated role with target-rooted tools and a numeric ledger;
the target is a working directory, not a sandbox. The standalone `role` front
streams bounded activity, removes pipeline submission tools, and checkpoints
identity, task digest, usage, and pauses. Resume validates identity/task and an
increased exhausted limit. SIGINT/SIGTERM persist a resumable `interrupted` pause.

Incremental reviewer context projects both tracked diffs and validated untracked
UTF-8 files under one byte ceiling; credential-like lines are redacted before
the projection is handed to a role.

Stage limits resolve as built-in global, built-in role, caller global, then caller
role defaults; zero disables a limit. The selected role limits apply to workflows
and standalone `role`.

After a dispatched Researcher failure, `research_rejected` retains run ID and
numeric metrics, never raw provider content.

### Tool activity flow

Runner and conversation adapters publish categorized, correlated harness events
through bounded replay and subscriber queues. Activity stays ephemeral; only
drop counts and safe aggregate metrics reach results or checkpoints. Metrics
separate system-prompt, handoff, and tool-definition bytes.

Console rendering subscribes to that same channel. Human mode groups repeated
semantic activity, while JSON mode transports schema-v1 records as NDJSON on
stderr. Backpressure is bounded and visible. Neither renderer infers lifecycle
state, and result stdout does not carry progress.

### Built-in pipeline

The built-in pipeline follows this graph:

```text
plan -> research? -> security? -> code -> review
                                  ^          |
                                  | rework   |
                                  +----------+
```

The Planner submits a structured plan with affected surfaces and contract
coverage. Missing standards pause before code. Research results cross a bounded,
strictly validated boundary and only normalized provenance is persisted. The
Reviewer submits a structured verdict and must cover every applicable surface
and contract.

`createWorkflowSession` exposes the graph one step at a time. `runPipeline` is
the automatic driver for that one built-in workflow. Custom workflows use the
same substrate without becoming the built-in pipeline.

The conversational Orchestrator exposes the same execution choices: `run_role`
for one specialist, `run_step` plus `choose_transition` for manual workflow
control, and `run_pipeline` for automatic completion. Pipeline results include a
durable run ID and aggregate stage usage. `resume_pipeline` reopens that run with
the original task and reuses committed stages. After raising the budget, recovery
resumes its durable role lane without repeating work.

### Conversation and orchestrator

`startConversation` keeps one durable harness session and attaches ledger
listeners per turn. `startOrchestrator` adds selected project, web, and image
plugins. Role allow-lists include only enabled plugin tools. Named workflow
modules contribute tools only when enabled. Disabling
the opt-in `pipeline` module removes its synchronous, stepped, and background
tools. `decompose_task` runs Planner alone without disturbing manual stepping.
The orchestrator routes work, never starts another orchestrator, and receives
all host-registered tools by default.

`explore_project` gives every code-reading role a bounded, Git-ignore-aware map
without file contents. Failures name a safe cause and next action. Web tools are
replaceable plugins; `web_read` preserves
normalized links. `inspect_image` sends pixels directly to a capable model or
uses one bounded vision call. Web transport validates DNS, peer address, and
redirects; private-network access requires an explicit trusted override.

### Durable control plane

The control plane stores queued intents and workflow checkpoints in
`ProjectStore`. Compare-and-swap versions reject stale writers. Control runs
require an explicit `resume` after a process stops; provider limits, manual
decisions, decomposition, and publication are represented as durable states and
events.

### Background runs

The session API exposes pipeline start, resume, status, events, result, and
cancellation. CLI start persists an owner-scoped request and launches a detached
worker. The live owner watches atomic updates and refreshes status without
reconstruction.

Subscriptions provide bounded, asynchronous, content-free hints from the current
tail. Pages expose cursor position, pending work, and dropped events. Polling
recovers retained history or watcher failure. Limits bound queues, pages, and
retention; leases distinguish live workers from abandoned ones.

Orchestrator conversations forward these hints when the pipeline is enabled.
The console renders allowlisted lifecycle notices on stderr while remaining
available for input. Notices never enter model context or trigger turns. Owner
scope is not authentication, and execution is not a sandbox.

## State and trust boundaries

### Target project

`targetDir` selects the project and the location of `.ad-coder/` runtime state.
Tools begin there, but unrestricted shell access can leave it and reach the
network. Use an external sandbox when the project or task is untrusted.

Project prompt overrides under `.ad-coder/prompts/` are trusted operator input
and replace built-in prompts byte-for-byte. Files such as `AGENTS.md` are not
automatically inserted into role prompts, although an agent may read them while
examining a project.

### Credentials

Credentials come from the configured credential store or explicit environment
accessor, never from the target project's configuration. Credential paths are
canonicalized, kept outside the target and Git metadata, protected with private
permissions, and updated atomically without following symlinks.
The CLI cannot recover environment provenance after Bun's startup dotenv load.
It therefore disables the environment credential accessor whenever process cwd
is inside `targetDir`; OAuth and the external private store remain usable.

Named model inventories compose the existing registry and role-routing profile
without copying either implementation. Only the selected entry resolves provider
credentials. The CLI refuses to combine an inventory with independent provider,
registry, or profile sources, and its effective projection reports the selected
name without URLs or credential metadata.

### Persistent content

Ledgers contain identifiers and numeric usage, not prompts, responses, tool
arguments, or headers. Tool-activity projections enter no ledger or checkpoint;
every externally sourced event string and complete record is bounded before
retention or delivery. Workflow checkpoints persist validated state, bounded
normalized research provenance, and safe per-stage provider/model labels,
duration, token categories, provider-reported cost, and context strategy.
Conversation transcripts may contain user and assistant content and must be
treated as sensitive local runtime data; they are ignored by Git.

## Configuration model

Provider data resolves to named models. Profiles map each role and complexity to
a model. Per-run overrides win over profile entries. The Planner uses the
configured default complexity before it has produced a rating; later roles use
the submitted rating.

Configuration follows `docs/contracts/config.md`: reasonable alternatives are
configurable, defaults favor efficiency, and numeric limits use zero for disabled
unless a mandatory safety ceiling says otherwise. `config show` exposes effective
values and sources without credentials.

The Planner instruction derives allowed canonical IDs from validation's
`CONTRACT_INDEX`, avoiding speculative research and duplicate identifier sources.

Coder omits `explore_project`; Planner uses bounded projections; Reviewer retains
independent reconnaissance.

Each role controller meters admissions, input, cost, and time. Closeout reserves
30 seconds, 4 turns, 8 tool turns, and 100,000 input tokens by default; zero
disables each. `RunCoordinator` checkpoints `stage_limit` before returning, so
earlier phases remain committed and `drive --resume-run <id>` can continue after
a configured increase. Checkpoints bind the task digest; mismatches and unknown
IDs fail. `--retry-research` clears only a rejected research pause and preserves
the accepted Planner result.

## Context, usage, and recovery

ad-coder disables the framework's built-in compaction and owns its context
policy. Auto mode summarizes only the evicted head through a configured
summarizer. Disabled mode never summarizes and halts when the full branch no
longer fits. Context refusals use the effective ceiling
`min(maxTokens, contextWindow)`, including when a role is run with a smaller
runtime model window; the typed diagnostic reports that ceiling without
transcript content. Operators should select a model with a larger context window
or lower the role's context-budget settings before retrying. Cross-provider
summarization requires explicit authorization.

Pipeline handoff policy is separate from transcript compaction. The first review
is broad; later Coder and Reviewer turns default to bounded findings, response,
contract, path/count, and credential-redacted diff evidence. Configurable modes
are `incremental`, `full`, and manually controlled `off`. Missing or truncated
evidence, sensitive paths, review-control changes, risk changes, and material
diffs widen the handoff with a stable reason. Workflow state retains bounded
metadata, a diff digest, and the decision, never raw patches. An untracked
addition stays focused because its bounded path permits an explicit role read;
path truncation still widens the handoff.

The ledger records provider-reported cost rather than recomputing it. Session
limits are enforced at the shared model-call boundary, including tool follow-up
turns. Missing trustworthy usage poisons an enabled cost budget so retries cannot
bypass it.

Structured provider-limit errors pause the durable control plane before another
dispatch. Retry policy is configurable and bounded; a zero retry interval
disables timers. Completed phases and effects are not repeated on resume.

## Publication and installation

Repository publication is an explicit headless policy with read-only preflight,
exact-head approval, isolated staging, local and CI gates, and squash merge.
Protected branches and unrelated dirty paths fail closed.

The supported development installation is a reviewed clone with a frozen,
script-disabled dependency install followed by `bun link`. Artifact smoke tests
pack the project, verify integrity, install without lifecycle scripts or ambient
release credentials, and execute `ad-coder about` and help without changing the
operator's global installation.
The updater accepts clean tracking Git checkouts, then fast-forwards,
frozen-installs, and relinks.

## Rules that are easy to break

- Keep every capability reachable through a headless API; fronts stay thin.
- Preserve the distinction between a workflow substrate and the built-in pipeline.
- Never persist secrets or raw research/provider payloads in ledgers or checkpoints.
- Treat project prompts as trusted overrides, but never let an ad-coder worker
  recursively invoke LDO or another orchestration pipeline.
- Put enforceable rules in contracts, current structure here, future design in
  ROADMAP, unresolved work in issues.
- Keep this file a map. Move detailed algorithms and incident evidence to their
  canonical homes instead of appending them here.
