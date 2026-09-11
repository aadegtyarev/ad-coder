# Checkpoint — 2026-09-11 (session 2)

Resume-from-here snapshot. Canon: `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`,
`AGENTS.md`, `docs/contracts/`, `.claude/ldo-runs.json`.

## What ad-coder is
Standalone multi-provider AI coding harness over `@earendil-works/pi-agent-core`
0.85.1 (Bun+TS). Centerpiece: in-house context/cache economics + per-role/step
cost ledger + small prompts + scriptable role/pipeline workflows. Private repo
github.com/aadegtyarev/ad-coder (main, MIT). Aiming at self-hosting.

## WORKFLOW RULES established this session (read first)
- **PR flow, NO direct pushes to main.** Every change goes via a branch/worktree
  and a PR; the operator merges. (Two commits — `958254a` drive-cost-fix,
  `c09e4ef` quality-layer — landed on main directly before this rule; left there
  by operator decision.)
- **Isolation.** Dev runs go in worktrees (`isolate: true`) or feature branches.
  LDO's `resumePlan` is mutually exclusive with `isolate` (bug #35 in
  aadegtyarev/ldo-ai) — so: reuse a reviewed plan → run on a feature BRANCH
  (no worktree); fresh plan → `isolate: true`. ad-coder's OWN design must NOT
  inherit this: isolation + plan-reuse must be composable (recorded in ROADMAP).
- **LDO `research: true` is flaky here** — the researcher's StructuredOutput
  `findings` field arrives malformed, exhausting retries (killed the OpenAI runs
  twice). Avoid `research: true`; supply facts directly or fix the LDO bug first.
- **Quality gate.** `bun run check` (Biome format+lint) must pass — enforced
  contract `docs/contracts/quality.md`; CI runs it.
- **Project routing** (every LDO call): recorder→haiku at all tiers.

## Built & on main since last checkpoint
- `958254a` fix(drive): per-step cost attributed by record POSITION, not a
  runId join (the join never matched: record.runId = harness op id, not the
  step/file runId). Red-green tested.
- `c09e4ef` chore(quality): Biome (`biome.json`) format+lint, whole tree
  formatted+lint-clean, `check`/`check:fix`/`format`/`lint` scripts, CI runs
  `bun run check`, new contract `docs/contracts/quality.md`. 178 tests green.
- Live dogfood proven: `ad-coder role coder` ($0.0035) and `drive --auto` full
  pipeline ($0.0206) both ran end-to-end on DeepSeek.

## IN FLIGHT / NEXT
- **Orchestrator (critical-path step 5)** — run `wf_3ae6dc25-81d` on branch
  `feat/orchestrator` (security phase; elevated). Headless `createOrchestrator`
  core + thin tools `run_pipeline`/`run_step`/`choose_transition`/`show_cost`;
  transition parse-and-gate (model-chosen edge is UNTRUSTED); guard factored to
  `src/orchestration/transition-guard.ts` (re-exported from drive.ts). WHEN IT
  FINISHES: verify verdict yourself (typecheck, `bun run check`, tests) → commit
  feat/orchestrator → push → PR → then STOP (operator directive).
- Naming taxonomy (consistent): **workflow** = substrate/scriptable-module;
  **pipeline** = the built-in plan→[security]→code⇄review flow. Orchestrator's
  autonomous tool is `run_pipeline`.

## Open PRs (await operator merge)
- **#1** docs/contracts/cli.md — CLI help auto-derived from one command registry.
- **#2** docs/BACKLOG.md — defer native OpenAI provider preset.
- **#3** README — usage-at-a-glance synopsis + 2 accuracy fixes (dormant
  compaction; CLI provider keys are deepseek/openrouter/codex only).

## QUEUED (after orchestrator merges, off updated main — shared-wiring conflicts)
1. **Summarizer / activate compaction** — plan READY (`wf_7336a47f-fd3`,
   planned): `createSummarizer` via pi-ai `Models.completeSimple` (one-shot, no
   harness); configurable CompactionMode {auto default | cache-aware | disabled-
   then-halt}; cache-aware = FAIL-LOUD follow-on (needs recon of pi request-
   assembly order first); disabled-halt via NEW `assertContextFitsBudget`
   (existing assertTurnFitsBudget only guards the tail); cheap-tier summarizer
   model default; wire into resolve-config + session + runner + conversation.
   THIS IS THE #1 READINESS BLOCKER: compaction is fully coded but DORMANT
   (Summarizer never constructed → every CLI path runs with no compaction).
2. **CLI --help implementation** — refactor cli.ts USAGE → registry + --help/-h
   (satisfies contract #1). No longer blocked (OpenAI dropped).
3. **Minimal console (step 5.5)** — thin REPL over `startOrchestrator`,
   formatted output — the dogfood bridge so the operator codes in ad-coder.
4. **TUI (step 6)** on pi-tui — operator writes it in ad-coder itself.

## Design requirements captured (land via orchestrator PR's ROADMAP)
- Composable isolation + plan-reuse (no LDO-#35 disease).
- Breakpoint control: a driver auto-advances and PAUSES before any chosen phase
  (run-until-phase), resumes from any point — control + convenience.

## Readiness to "start coding" (audited)
- Tools: only bash/read/write/edit (search/git via bash ok; NO web/LSP/MCP — pi
  doesn't expose web). Prompts: 6, adequate. Compaction: DORMANT (blocker #1).
- Docs: adopt LDO structure (already mostly true) — no migration.

## Providers
deepseek (live-tested), openrouter, openai-codex (oauth) wired. Native OpenAI
deferred (backlog #2). Creds ONLY from env, never targetDir/.env.

## How work is done
`Workflow({ name:"ldo:ldo", args:{ task, config:{ models:{ trivial/medium/complex:
{ recorder:"haiku" }}}}})`; planOnly first when approach unsettled; track every
run in `.claude/ldo-runs.json` + args in `.claude/ldo-args/<runId>.json`.
