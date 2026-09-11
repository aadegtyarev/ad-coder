<!-- BEGIN ldo -->
<!-- ldo:version 2.42.0 -->
## LDO — development workflow

This project uses LDO. Match the work to its size; don't invoke the pipeline for
what doesn't need it, and don't hand-edit around it for what does.

- **Trivial** (typo, one-liner, config value, obvious bug): just do it inline.
- **Real change** (feature, refactor, bug fix, multi-file): run the pipeline —
  `Workflow({ name: "ldo:ldo", args: { task: "<the task>" } })`. It plans, implements,
  reviews, and proves the result. For a change touching auth, secrets, user input,
  or crypto, add `security: true`. For one needing outside knowledge, `research: true`.
- **New project** is a conversation first: `/ldo-bootstrap "idea"`.

**Track every pipeline call in `.claude/ldo-runs.json`** so an interrupted run can
resume instead of restarting cold — see `/ldo-resume` for the exact protocol
(write the full `args` object to `.claude/ldo-args/<runId>.json` right after
calling, then record the `runId`, the `transcriptDir` the tool result hands
back, and that reference in the tracking entry, and update its status when the
result comes back; resuming needs both the run id and the real args, and the
tracking entry alone doesn't carry them). At the start of this session, before
anything else, check that file for any entry whose status is not one of
`approved`, `changes_requested`, `planned`, `error`, `abandoned`, `shipped`,
`completed` or `failed` — `running`, `interrupted` and anything unrecognised all
mean an earlier session may have been interrupted mid-run. If any exist, follow
`/ldo-resume`'s recovery steps rather than leaving them unmentioned.

When working inline, keep the discipline: read before editing, write or update a
test for any behavior change, and update README/CHANGELOG for user-facing changes.

For any report or handoff: verdict first, evidence not assertion, name what you're
unsure of. See `/ldo-agent-ux`.

Models route automatically, the same at every tier: Opus plans, writes and
threat-models; Sonnet reviews. A weak Coder buys review rounds, and a round
costs a full Coder and Reviewer pass — so the strong model goes where the work
is. To change that, pass the routing on the call —
`Workflow({ name: "ldo:ldo", args: { task: "...", config: { models: { complex: {
reviewer: "opus" } } } } })`. Keep any project-specific routing in this block so
it's applied on every run.

**Project routing:** the recorder runs on `haiku` at every tier — pass
`config: { models: { trivial: { recorder: "haiku" }, medium: { recorder: "haiku" }, complex: { recorder: "haiku" } } }`
on every run.

A single-task run edits the working tree directly by default — no commit, no
branch. Pass `isolate: true` on the call to run it in a separate worktree instead
and leave your tree untouched.

**When the approach isn't settled, make the first call with `planOnly: true`** —
a task that reframes a problem, touches a contract, or spans layers. The run
stops after Plan and hands the plan back instead of implementing it; correct
the approach there, then re-issue the same task without the flag. Four restarts
of one task, every restart a design correction, is what this replaces.

**This block is a snapshot of the LDO version that wrote it.** The
`<!-- ldo:version -->` stamp on its first line says which, and every pipeline
run logs its own version. When the two disagree the block is stale — re-run
`/ldo-init` after updating or reinstalling the LDO plugin; it replaces the
block in place and carries the drift log below over unchanged. The stamp is a
hint for you, not a check: nothing in the pipeline reads it.

**Docs drift log.** Append a line here after each user-facing change. When the
list reaches roughly eight, offer to run `/ldo-docs-audit` and `/ldo-code-audit`
— full cold reads that catch documentation drift and code accretion (bloated
files, comment sprawl, duplicated logic) no single diff reveals — then clear
the list. Offer; don't run either unasked.

<!-- ldo:features -->
- Initial scaffold: `ad-coder run <script.ts>` loads a workflow module, `Role` presets validate harness options, and a `Ledger` records per-turn token and cost deltas as JSONL under `.ad-coder/ledger/`.
- Ledger records each response's own usage instead of a difference between turns (after_response usage is per-response in pi-agent-core 0.85.1); the JSONL field is now `usage`, not `delta`, and `diffUsage`/`UsageDeltaTracker` remain exported for cumulative sources.
- 2026-09-11: Quality-gates module (`src/gates/`) exported from `ad-coder`: data-declared `QualityGate` config, injected `CommandExecutor` seam, `GateRunner` running autofix-first-then-check with bounded output plus an in-process size gate, and a fail-loud `GateReport`. Not yet wired into the build.
- 2026-09-11: ad-coder owns context management. `Role` carries a `ContextBudget`; `defineRole(role, model)` now takes the target `Model` and validates the budget against its `contextWindow` (caller-supplied, so local/custom endpoints validate). New `ContextCompactor` (`transform_context` hook, own `SUMMARIZATION_PROMPT`) and `assertTurnFitsBudget` pre-flight exported from `ad-coder`.
- 2026-09-11: Capability-matrix module (`src/capabilities/`) exported from `ad-coder`: `deriveCapabilities` yields a descriptor with a three-way `costMode` (per-token / local / prepaid) and the corrected `cacheControllable` predicate (api `anthropic-messages` OR compat `cacheControlFormat === "anthropic"`, not format alone). Two pure metrics `cacheEfficiency`/`breakEvenReads`, and `reconcileRoleWithModel` warning (never throwing) on inert cacheRetention. The empirical declared-vs-observed layer is deferred.
- 2026-09-11: End-to-end runner (`src/runner/`) exported from `ad-coder`: `runRole`/`createRoleRunner` construct a live harness, root the bash/read/write/edit tools at a REQUIRED `targetDir` and land the ledger under it, and drive one turn to a settled result. Credentials come only from caller-configured models (never `<targetDir>/.env`); `targetDir` is a starting cwd, not a sandbox. `WorkflowContext` gains an optional `runRole`; the CLI gains an optional `--target-dir` that wires it from the CLI's own environment.
- 2026-09-11 (fix): README.md example corrected — `ctx.runRole()` is not a call signature; the method is `ctx.runRole.runRole(role, model, prompt)`. Added clarification that `nodeDirectory` is not a sandbox and credentials come only from the harness environment, never from targetDir. Documented symlink refusal in ledger path component checks.
- 2026-09-11: Orchestration module (`src/orchestration/`) exported from `ad-coder`: `runPipeline` composes the single-turn runner into an optional-plan → code⇄review loop capped by `maxRounds`. The reviewer emits a strict JSON `Verdict` artifact it WRITES (the runner has no tool-injection seam, so a `submit_verdict` tool call is a deferred follow-up); `runPipeline` reads+validates it per round — missing/malformed is a hard `OrchestrationError`, `changes_requested` feeds the coder's next prompt, exhausting `maxRounds` returns `approved:false` (never thrown). Per-round cost separates via ledger steps `plan`/`code:N`/`review:N`.
- 2026-09-11: Runner gained an OPTIONAL `tools?` injection seam. `runRole`/`RunRoleParams` and `RoleRunner`/`RunRoleOptions` accept custom tools that EXTEND the built-in `[bash,read,write,edit]` set; new `defineTool`/`Tool` (ad-coder's own tool surface, parallel to `defineRole`) and an `assertUniqueToolNames` collision guard (typed `RunnerError` code `tool_name_collision`, never silent shadowing) are exported from `ad-coder`. `activeToolNames` still filters the combined set uniformly; absent `tools` is byte-for-byte prior behavior. This UNBLOCKS the genuine `submit_verdict` tool-call verdict and per-role custom tools (e.g. the conversational orchestrator's run-pipeline / show-ledger tools) but does NOT itself rewire the orchestration verdict — that stays the next follow-on.
- 2026-09-11: Orchestration reviewer verdict is now a `submit_verdict` TOOL CALL (the filesystem-artifact first-cut retired). Each reviewer round builds a fresh per-round `VerdictCapture` holder + `buildSubmitVerdictTool` (via the `runRole` tools seam) and reads it after the turn: no call → `missing_verdict`, failed strict `parseVerdict` → `malformed_verdict` (both hard `OrchestrationError`s), a captured verdict drives approve/changes_requested (last-wins). The tool schema is permissive at the enum leaves so `parseVerdict` stays the gate; the reviewer role must list `submit_verdict` in `activeToolNames`. New exports `buildSubmitVerdictTool`/`SUBMIT_VERDICT_TOOL_NAME`/`VerdictCapture`. Next follow-on on the same pattern: `submit_plan`/`rate_complexity`.
- 2026-09-11: Optional planner can now emit STRUCTURED complexity via a `submit_plan` TOOL CALL (mirrors `submit_verdict`). New `src/orchestration/plan.ts` (`SUBMIT_PLAN_TOOL_NAME`, `PlanCapture`, strict `parsePlan`, `buildSubmitPlanTool`, `formatPlannerInstruction`); `Complexity`/`Plan` types, `malformed_plan` error code, and an optional `PipelineResult.complexity`. SOFT signal: an absent call leaves `result.complexity` undefined and the run proceeds (no `missing_plan`); only a MALFORMED call is a hard `malformed_plan`. Deliberately NOT wired into model selection — that is the complexity-aware routing follow-on that consumes it. New exports `buildSubmitPlanTool`/`SUBMIT_PLAN_TOOL_NAME`/`PlanCapture`/`Complexity`/`Plan`.
- 2026-09-11: `submit_plan` gained a `securitySurface` (`none`/`low`/`elevated`, strictly validated by `parsePlan`, surfaced on `result.securitySurface`), plus a conditional Security phase in `runPipeline`. On an `elevated` surface AND a configured optional `security` role (`PipelineConfig.roles.security?`, read/bash-only), a threat-model turn (ledger `step: 'security'`) runs and its final text threads as hard mitigation requirements into the coder's round-1 prompt and every reviewer prompt (as DATA, no new sink); elevated with no security role skips (quiet stderr) and proceeds. New `SecuritySurface` type export and `prompts/security.md`. First cut THREADS TEXT; a structured `submit_security` tool is the follow-on.
<!-- /ldo:features -->
<!-- END ldo -->
