# Architecture

## Purpose

ad-coder is a Bun/TypeScript harness for running coding agents through a
reviewed pipeline. It supports a human CLI, a programmatic API, persistent
conversations, and a daemon-free control plane. The headless core owns behavior;
the CLI is only an adapter.

This document is a map for contributors. Detailed invariants live in
`docs/contracts/`, accepted future design lives in `docs/ROADMAP.md`, and open
work lives in `docs/BACKLOG.md`.

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
| Authentication | `src/auth/` | Store credentials outside target projects and expose secret-free status. |
| Model inventories | `src/inventory/` | Validate and resolve a named atomic registry plus complexity-routing profile. |
| Registry and profiles | `src/registry/`, `src/profiles/` | Resolve providers, models, role routing, and effective configuration. |
| Roles and prompts | `src/role.ts`, `src/prompts/`, `prompts/` | Validate roles and resolve built-in or project prompts. |
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

`runRole` validates the target directory and role, creates tools and a ledger,
builds an agent harness, drives one model turn, and closes resources. The target
directory is a starting working directory, not a security sandbox.

The standalone `role` front uses the same target-local durable numeric ledger,
prints a narrowed usage envelope after completion, and streams the shared
bounded tool-activity projection while work is in flight. It exposes selected
built-in plugin tools but removes structured pipeline submission tools.
It checkpoints role, provider/model identity, task digest, status, cumulative
stage usage, and stage-limit pauses under
`.ad-coder/runs/standalone-<runId>.json`. `role --resume-run <id>` validates the
same role, model, and task, requires the exhausted limit to change, and resumes
the active durable lane operation under cumulative whole-stage budgets.

### Tool activity flow

Runner and conversation adapters attach to harness events before a turn starts.
The observability core assigns semantic categories, correlation and sequence,
uses category-only projection for raw tool arguments, then publishes through
bounded replay and subscriber queues. Activity remains ephemeral; only its drop
count and safe aggregate stage metrics cross result or checkpoint boundaries.
Those metrics include separate byte counts for the effective system prompt,
stage handoff prompt, and tool definitions, exposing every role's request weight
before provider-specific serialization.

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
the original task and reuses committed stages; stage-limit recovery still requires
the host configuration to raise or disable the exhausted budget.

### Conversation and orchestrator

`startConversation` keeps one durable harness session across turns and attaches
per-turn ledger listeners without replaying prior messages. `startOrchestrator`
adds the selected independent project, web, and image plugins (all three by
default; callers may select none or replace them). Named workflow modules
are validated by a registry and contribute tools only when explicitly enabled.
The shipped `pipeline` module is opt-in; disabling it removes all five of its
tools. `decompose_task` runs its Planner alone in an isolated workflow and cannot
dispatch Coder or disturb manual stepping. The orchestrator routes work; it does
not recursively start another orchestrator. Its tool policy is default-open, so
it receives every built-in and host-registered tool, including file editing and
shell execution.

`explore_project` is shared by every role that reads project code. In a Git
worktree it discovers tracked and untracked files through Git's standard exclude
rules; a bounded filesystem fallback is used outside Git. It reports metadata
and decomposition signals, never file contents. Web tools are plugin-shaped and
replaceable. `web_read` preserves normalized page and content-image links.
`inspect_image` returns pixels directly to an image-capable active model; for a
text-only model it makes a bounded one-shot call to the configured vision model
and returns the description as text. Default web transport pins each request to
its validated DNS address, checks the connected peer, and repeats validation for
redirects; private-network access remains an explicit trusted override.

### Durable control plane

The control plane stores queued intents and workflow checkpoints in
`ProjectStore`. Compare-and-swap versions reject stale writers. A stopped process
does not continue in the background; another process can explicitly resume the
first incomplete phase. Provider limits, manual decisions, decomposition, and
publication are represented as durable states and events.

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

Configuration follows `docs/contracts/config.md`: behavior with a reasonable
alternative is configurable, defaults favor efficient operation, and numeric
resource limits use zero to mean disabled unless a separate mandatory safety
ceiling is documented. `config show` exposes effective values and their sources
without returning credential material.

The Planner instruction derives allowed canonical IDs from validation's
`CONTRACT_INDEX`, avoiding speculative research and duplicate identifier sources.

Coder omits structural `explore_project` after Planner handoff. Reviewer retains
independent reconnaissance.

Each pipeline role stage owns a fresh `StageLimitController`. The runner meters
every model and tool admission, provider-reported input and cost, and elapsed
time; a deadline closes the active harness. `RunCoordinator` checkpoints a
`stage_limit` pause before returning, so completed earlier phases remain committed
and an operator can change the configured limit and resume the incomplete phase
with `drive --resume-run <id>`. The CLI prints the coordinator run ID and checkpoint
path on pause. New checkpoints bind to a digest of the original task; a mismatched
task or unknown resume ID fails instead of starting unrelated work.
An explicitly rejected Researcher result is retried with
`drive --resume-run <id> --retry-research`. This clears only a research pause and
re-prepares its durable dispatch; it preserves the accepted Planner result and
refuses use without an existing run.

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

Pipeline handoff context is a separate policy from transcript compaction. The
first Reviewer remains broad. Later Coder and Reviewer turns default to bounded
focused handoffs containing unresolved findings, the Coder response, affected
contracts, safe path/count metadata, and a bounded credential-redacted diff.
`incremental`, `full`, and `off` modes are configurable; `off` leaves breadth
under manual workflow control. Missing/truncated evidence, sensitive or untracked
paths, review-control changes, risk changes, and configured material-diff
thresholds widen the handoff with a stable reason. Only bounded metadata, a diff
digest, and the decision persist in workflow state and reports; raw patches do
not.

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

## Rules that are easy to break

- Keep every capability reachable through a headless API; fronts stay thin.
- Preserve the distinction between a workflow substrate and the built-in pipeline.
- Never persist secrets or raw research/provider payloads in ledgers or checkpoints.
- Treat project prompts as trusted overrides, but never let an ad-coder worker
  recursively invoke LDO or another orchestration pipeline.
- Put enforceable rules in contracts, current structure here, future design in
  ROADMAP, and unresolved work in BACKLOG.
- Keep this file a map. Move detailed algorithms and incident evidence to their
  canonical homes instead of appending them here.
