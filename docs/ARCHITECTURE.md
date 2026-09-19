# Architecture

## Purpose

ad-coder is a Bun/TypeScript harness for running coding agents through a
reviewed pipeline. It supports a human CLI, programmatic API, persistent
conversations, and a daemon-free control plane. The headless core owns behavior;
the CLI is only an adapter.

This document is a map for contributors; invariants live in `docs/contracts/`,
accepted design in `docs/ROADMAP.md`, open work in GitHub issues indexed
by `docs/BACKLOG.md`.

## Runtime and dependencies

- Bun executes TypeScript directly and runs tests.
- `@earendil-works/pi-agent-core` provides the agent harness.
- `@earendil-works/pi-ai` provides model and provider adapters.
- Project state is stored as private JSON or JSONL under `.ad-coder/`.
- No database or daemon is required.

## System map

| Area | Location | Responsibility |
|---|---|---|
| CLI | `src/cli.ts`, `src/cli/` | Parse commands, render human or JSON output, and call headless APIs. |
| Authentication | `src/auth/` | Store Codex OAuth and OpenRouter API-key credentials outside target projects; expose secret-free status. |
| Model inventories | `src/inventory/` | Seed, persist, validate, and resolve named registry/routing profiles. |
| Registry and profiles | `src/registry/`, `src/profiles/` | Resolve providers, models, role routing, and effective configuration. |
| Portable user profile | `src/user-profile/` | Atomically persist validated inventories, calibrated routing, and append-only economics, with deterministic JSON import, export, and recording. |
| Project calibration | `src/project-calibration/` | Materialize a bounded anonymous snapshot at `.ad-coder/calibration.json`; matching inventories consume its routing unless disabled by an API switch. |
| Stage-attempt accounting | `src/orchestration/session.ts`, `src/project-operations/run-coordinator.ts` | Persist partial metrics and role identity before a limit pause, then resume without losing accepted-result economics. |
| Roles and prompts | `src/role.ts`, `src/prompts/`, `prompts/` | Validate roles, resolve built-in or project prompts, compose versioned model-inventory Researcher briefs without persisting content. |
| Runner | `src/runner/` | Execute one role turn with tools rooted at the target directory. |
| Context | `src/context/` | Enforce context budgets and optional ad-coder-owned compaction. |
| Ledger | `src/ledger/` | Records and reports usage, cost, role, and tool counts. |
| Activity observability | `src/observability/tool-activity.ts`, `src/cli/tool-activity.ts` | Project harness lifecycle into a bounded headless stream; group or transport it at the CLI boundary. |
| Workflow core | `src/orchestration/` | Run the plan, research, security, code, and review graph. |
| Durable coordination | `src/project-operations/`, `src/project-store/` | Checkpoint runs, coordinate resume, and manage follow-ups and publication. |
| Quality and exploration | `src/gates/`, `src/project-tools/` | Run bounded checks and Git-ignore-aware structural reconnaissance. |
| Web and media plugins | `src/web/` | Search, read pages, and inspect images with capability routing. |

## Main execution paths

### One role

`runRole` drives one validated role with target-rooted tools and a numeric ledger;
the target is a working directory, not a sandbox. The standalone `role` front
streams bounded activity, removes pipeline submission tools, and checkpoints
identity, task digest, usage, pauses. Resume validates identity/task and an
increased exhausted limit. SIGINT/SIGTERM persist a resumable `interrupted` pause.

Incremental reviewer context projects tracked diffs and validated untracked
UTF-8 files under one byte ceiling; credential-like lines are redacted before
the projection reaches a role.

Stage limits resolve as built-in global, built-in role, caller global, then caller
role; zero disables a limit; the selected role limits apply to
workflows and standalone `role`.

A failed Researcher dispatch leaves `research_rejected` with run ID and numeric
metrics, never raw provider content.

### Tool activity flow

Runner and conversation adapters publish categorized, correlated harness events
via bounded replay and subscriber queues. Activity stays ephemeral; only
drop counts and safe aggregates reach results or checkpoints. Metrics
separate system-prompt, handoff, and tool-definition bytes.

Console rendering shares that channel. Human mode groups repeated
semantic activity; JSON mode transports schema-v1 records as NDJSON on
stderr. Backpressure is bounded and visible; neither renderer infers lifecycle
state, and result stdout carries no progress.

### Built-in pipeline

The built-in pipeline follows this graph:

```text
plan -> research? -> security? -> code -> review
                                  ^          |
                                  | rework   |
                                  +----------+
```

The Planner submits a structured plan with affected surfaces and contract
coverage; missing standards pause before code. Research results cross a bounded,
strictly validated boundary; only normalized provenance is persisted. The
Reviewer submits a structured verdict covering every applicable surface
and contract.

`createWorkflowSession` exposes the graph one step at a time; `runPipeline` is
its automatic driver. Custom workflows use the same substrate without becoming
the built-in pipeline.

The conversational Orchestrator exposes the same choices: `run_role` for one
specialist, `run_step` plus `choose_transition` for manual control,
`run_pipeline` for automatic completion (the built-in module ships enabled;
`--workflows` selects or excludes members; dispatch accepts a pre-read
`complexity` tier). Results carry a durable run
ID; `resume_pipeline` reopens with the original task, reuses committed stages,
and resumes after a raised budget without repeating work.

### Conversation and orchestrator

`startConversation` keeps one durable harness session and attaches ledger
listeners per turn. `startOrchestrator` adds selected project, web, and image
plugins; role allow-lists include only enabled plugin tools. Named workflow
modules contribute tools only when enabled; disabling
the opt-in `pipeline` module removes its synchronous, stepped, and background
tools. `decompose_task` runs Planner alone without disturbing manual stepping.
The orchestrator routes work, never starts another orchestrator, and receives
host-registered tools by default.

`explore_project` gives every code-reading role a bounded, Git-ignore-aware map
without file contents; failures name a safe cause and next action. Web tools are
replaceable plugins; `web_read` preserves
normalized links. `inspect_image` sends pixels directly to a capable model or
uses one bounded vision call. Web transport validates DNS, peer address, and
redirects; private-network access requires an explicit trusted override.

### Durable control plane

The control plane stores queued intents and workflow checkpoints in
`ProjectStore`; compare-and-swap versions reject stale writers. Control runs
require an explicit `resume` after a process stops; provider limits, manual
decisions, decomposition, and publication are durable states and events.

### Background runs

The session API exposes start, resume, status, events, result, and
cancellation. CLI start persists an owner-scoped request and launches a detached
worker; the live owner watches atomic updates and refreshes status without
reconstruction.

Subscriptions provide bounded, asynchronous, content-free tail hints. Pages
expose cursor position, pending work, and dropped events; polling recovers
retained history or watcher failure. Limits bound queues, pages, and
retention; leases distinguish live workers from abandoned ones.

Orchestrator conversations forward these hints when the pipeline is enabled;
The console renders allowlisted lifecycle notices on stderr while staying
available for input. Notices never enter model context or trigger turns. Owner
scope is not authentication; execution is not a sandbox.

## State and trust boundaries

### Target project

`targetDir` selects the project and `.ad-coder/` runtime state location.
Tools begin there, but unrestricted shell access can leave it and reach the
network; use an external sandbox for untrusted projects or tasks.

Project prompt overrides under `.ad-coder/prompts/` are trusted operator input
and replace built-in prompts byte-for-byte; files such as `AGENTS.md` are not
automatically inserted into role prompts.

### Credentials

Credentials come from the configured credential store or an explicit environment
accessor, never the target's configuration. Credential paths are
canonicalized, kept outside the target and Git metadata, privately permissioned,
and updated atomically without following symlinks.
Bun's startup dotenv load destroys environment provenance, so the CLI disables
the environment credential accessor when cwd is inside `targetDir`; OAuth and
the external private store remain usable.

Named model inventories compose the existing registry and role-routing profile
without copying either; only the selected entry resolves
credentials. The CLI refuses to combine an inventory with independent provider,
registry, or profile sources; its projection reports the selected
name without URLs or credential metadata.

### Persistent content

Ledgers contain identifiers and numeric usage, not prompts, responses, tool
arguments, or headers. Tool-activity projections enter no ledger or checkpoint;
every externally sourced event string and complete record is bounded before
retention or delivery. Workflow checkpoints persist validated state, bounded
normalized research provenance, and safe per-stage provider/model labels,
duration, token categories, provider-reported cost, and context strategy.
Conversation transcripts may contain user and assistant content: treat them as
sensitive local runtime data, ignored by Git.

## Configuration model

Provider data resolves to named models; profiles map each role and complexity to
one; per-run overrides win over profile entries. The Planner uses the
configured default complexity before producing a rating; later roles use
the submitted rating.

Configuration follows `docs/contracts/config.md`: reasonable alternatives are
configurable, defaults favor efficiency, numeric limits default to zero
unless a safety ceiling says otherwise. Switchable capabilities ship enabled;
settings and flags turn them off, and `config show` reports every resolved value
and source without credentials.

The Planner instruction derives allowed canonical IDs from validation's
`CONTRACT_INDEX`, avoiding speculative research and duplicate identifiers.

Coder omits `explore_project`; Planner uses bounded projections; Reviewer retains
independent reconnaissance.

Each role controller meters admissions, input, cost, time. Closeout reserves
30 seconds, 4 turns, 8 tool turns, 100,000 input tokens by default; zero
disables each. `RunCoordinator` checkpoints `stage_limit` before returning, so
earlier phases stay committed and `drive --resume-run <id>` continues after a
configured increase. Checkpoints bind the task digest; mismatches and unknown
IDs fail. `--retry-research` clears only a rejected research pause, preserving
the accepted Planner result.

## Context, usage, and recovery

ad-coder owns its context policy. Auto mode commits a durable entry: the harness
cuts the branch, ad-coder supplies the summary of the evicted head; disabled
mode never summarizes and halts when the full branch no longer fits. Context
refusals use the effective ceiling `min(maxTokens, contextWindow)`; the
diagnostic reports that ceiling without transcript content. Retry with a
larger-window model or a lower budget; cross-provider summarization needs
explicit authorization.

Pipeline handoff is separate from transcript compaction. The first review
is broad; later Coder and Reviewer turns default to bounded findings, response,
contract, path/count, and credential-redacted diff evidence. Modes:
`incremental`, `full`, and manual `off`. Missing or truncated evidence,
sensitive paths, review-control or risk changes, and material diffs widen the
handoff with a stable reason. Workflow state keeps bounded
metadata, a diff digest, and the decision, never raw patches. An untracked
addition stays focused (its bounded path permits an explicit role read);
path truncation still widens the handoff.

The ledger records provider-reported cost rather than recomputing it. Every
LLM generation path crosses one layered `Models` boundary — provider admission
outermost, then session limits, cost-anomaly detection, tool-call recovery;
each proxy delegates inward, so the wrapper applied LAST is entered FIRST.
Both seams (`runRole`, `startConversation`) wrap identically; a front cannot
bypass admission with its own client. Session limits meter cost and turns
there, including tool follow-ups; missing trustworthy usage
poisons an enabled cost budget so retries cannot bypass it.

Admission bounds CONCURRENCY and RETRY RATE per provider scope: the scope is
the provider-account label — never a credential — hashed by `admissionScopeKey`,
only the digest persisted. It ships ENABLED with finite defaults from
`settings.yaml`'s `provider-admission` section; `max-concurrent-per-scope: 0`
disables it in the wiring layer, which the module refuses (a controller without
concurrency admits nothing).

Structured provider-limit errors pause the durable control plane before another
dispatch. Retry policy is configurable and bounded; a zero retry interval
disables timers. Completed phases and effects are not repeated on resume.

## Publication and installation

Repository publication is an explicit headless policy: read-only preflight,
exact-head approval, isolated staging, local and CI gates, squash merge.
Protected branches and unrelated dirty paths fail closed.

The supported development installation is a reviewed clone with a frozen,
script-disabled dependency install and `bun link`. Artifact smoke tests
pack the project, verify integrity, install without lifecycle scripts or ambient
release credentials, and run `ad-coder about` and help without touching the
operator's global installation.
The updater accepts clean tracking checkouts, then fast-forwards,
frozen-installs, and relinks.

## Rules that are easy to break

- Keep every capability reachable through a headless API; fronts stay thin.
- Preserve the distinction between a workflow substrate and the built-in pipeline.
- Never persist secrets or raw research/provider payloads in ledgers or checkpoints.
- Treat project prompts as trusted overrides; never let an ad-coder worker
  recursively invoke LDO or another orchestration pipeline.
- Put enforceable rules in contracts, current structure here, future design in
  ROADMAP, unresolved work in issues.
- Keep this file a map: detailed algorithms and incident evidence belong in
  their canonical homes.
