# Checkpoint — 2026-09-11

A resume-from-here snapshot. When in doubt, the canon is `docs/ROADMAP.md`,
`docs/ARCHITECTURE.md`, `AGENTS.md`, `docs/contracts/`, and `.claude/ldo-runs.json`.

## What ad-coder is
A standalone, multi-provider AI coding harness: scriptable workflows, in-house
context/cache economics (the centerpiece), per-role/step cost ledger, small prompts,
built-in + custom roles. Built as a thin layer over `@earendil-works/pi-agent-core`
0.85.1 (Bun + TS). Private repo: github.com/aadegtyarev/ad-coder (main, MIT).

## Built & committed (11 src modules, 177 tests, all green)
role · ledger (per-response usage + toolCalls) · context (budget + compactor +
pre-flight) · capabilities (matrix + metrics) · gates · runner (runRole, targetDir
boundary, tools-seam) · orchestration (runPipeline = plan→[security]→code⇄review;
submit_plan/verdict; **stepped engine**: WorkflowState + step()/applyTransition,
runPipeline is now the auto-driver over it) · registry (5 provider presets) ·
profiles (complexity routing) · prompts (resolve by name, project override) · cli.

**Human-in-the-loop CLI MVP reached:** `ad-coder role <name> "<task>" --target-dir`
(run any role standalone), `ad-coder drive "<task>" --target-dir [--auto]` (drive the
pipeline step by step: advance/rework/stop, or --auto = autonomous/machine),
`ad-coder run <script>`. Config resolves from env (provider by key presence,
overridable), no config file needed.

## Critical path (reordered) — position
DONE: prompts-as-files → conversation loop → **stepped substrate** → **human-CLI MVP**.
NEXT: (5) **orchestrator** — an autonomous driver ROLE (prompt at prompts/orchestrator.md)
on the conversation loop, with run_workflow/run_step/show_cost tools via the tools-seam,
driving the stepped substrate. MUST validate a model-chosen transition against the
offered set (untrusted model input — parse-and-gate). Then (6) **TUI** on pi-tui.

## Key decisions (all in docs/ROADMAP.md)
- **pi ecosystem:** standalone core on pi-agent-core (cache-economics needs control the
  pi SDK doesn't surface); REUSE pi-tui for the TUI; evaluate chord (API/multi-user/
  Telegram/plugins) + pi-telemetry (ledger) as libraries; never fork pi-coding-agent.
- **Workflow execution model:** stepped execution is the substrate; the human and the
  orchestrator are two swappable DRIVERS; a workflow = a self-contained module dir;
  the orchestrator is always present, auto/manual dials its authority.
- **Contracts (enforced by the LDO reviewer on every run):** `config.md` (everything
  configurable, efficient defaults), `architecture.md` (headless core + thin fronts,
  every capability reachable programmatically — friendly to humans AND machines).
- Big ROADMAP features queued: bootstrap (new project), init (adopt), sessions,
  multi-user, sandbox+wallet, publisher, workflows-module, in-project scratch,
  research phase, configurable compaction (cache-aware/disable), MCP/LSP seams +
  guided setup, web tools, common preamble, auditor+refactor-executor, doc-taxonomy.

## Pending / backlog
- **CI:** `.github/workflows/ci.yml` is on disk but UNTRACKED — needs the gh `workflow`
  scope (`gh auth refresh -h github.com -s workflow`, operator-only). Do NOT `git add -A`
  it before then. LDO feedback filed: aadegtyarev/ldo-ai#36 (opt-in agent tools).
- Minor: `driveCommand`/`roleCommand` duplicate ~15 lines of flag-parsing → a shared
  `buildPipelineConfig` helper. In docs/BACKLOG.md.
- LSP tool present but no server here (project is TS 7 native, no tsserver) — ad-coder's
  own LSP seam must be server/version-configurable.

## How work is done
Real changes go through `Workflow({ name: "ldo:ldo", args: { task, config: { models:
{ trivial/medium/complex: { recorder: "haiku" } } } } })`; planOnly first when the
approach isn't settled; every run tracked in `.claude/ldo-runs.json` + args in
`.claude/ldo-args/`. Verify each verdict yourself (tests/typecheck), commit
point-staged (never `git add -A` — the .github landmine), push. No runs in flight now.
