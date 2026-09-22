# ad-coder roadmap & design decisions

Forward-looking companion to ARCHITECTURE.md (which describes current state).
Captures decided-but-unbuilt features so nothing is lost to a dropped session.
Rationale for the cost/economics claims lives in `docs/cost-economics.md`;
verified pi internals in `docs/pi-capabilities.md`.

## Guiding principle: gates over prompts

A prompt instruction ("keep files small", "don't leak secrets", "match the
style") is a soft constraint that competes with the task for the model's
attention and loses. Every quality/safety property in ad-coder is therefore a
**mechanical gate the model cannot talk past**, not an instruction: a hard
budget, a deterministic check, a structural invariant. The model may ignore the
intent all it wants — the gate fires afterward and returns the failure as the
next turn's input. This is why the industry replaced style guides with
formatters, and it is the through-line of every decision below.

## Module parallelism principle

Verified from the code (re-audited as the project grew): there are two kinds of
module. LEAF modules (ledger, context, capabilities, gates, role) stay disjoint —
they import no sibling, or only `role` type-only. COMPOSER modules (runner,
orchestration) deliberately import several leaves BECAUSE composing them is their
job (runner = role+context+ledger; orchestration = runner+ledger+role). That is
correct, not drift: a composer should depend on what it composes. The shared seam
is still the barrel (`src/index.ts`, 53 lines,
append-only export lines) + docs + `package.json`/`bun.lock` when deps change.
So: **a module is the unit of parallelism; the integration seam is thin and
serial.** Fan out on the leaves (write+test the module — the expensive 90%),
serialize the integration (wire the barrel + docs — trivial, append-only). A
change that touches only its own dir + the thin seam is a safe parallel
candidate; one that reaches into `role.ts` and `ledger.ts` at once is not.
Design to keep the seam thin (subpath exports / a generated barrel would remove
`index.ts` from the seam entirely). ad-coder should eventually detect
module-locality from the touched-file set to decide what can parallelize.

## Status

### Detached background pipelines (implemented 2026-09-13)

The seven pipeline tools and JSON `background` CLI support detached execution,
owner-scoped polling, bounded cursor events, terminal results, cancellation, and
lease-based stale-worker recovery. Numeric resource limits follow zero-disabled
configuration semantics; finite page, close-drain, and lease safety ceilings
remain enabled. The worker reuses the built-in pipeline while foreground
conversation turns remain available.

### Documentation ownership (implemented 2026-09-12)

The repository uses the durable handoff structure: README is orientation and
navigation; this roadmap owns decisions, delivery status, and forward design;
`ARCHITECTURE.md` is the concise current-system map; unresolved work lives in
GitHub issues that `BACKLOG.md` indexes; `contracts/` holds enforceable rules;
thematic operational knowledge belongs under `docs/notes/` while an existing
`docs/NOTES.md` remains compatible; and `reviews/` retains exceptional incident
evidence plus historical receipts. Routine verification belongs in durable run
state. Ignored harness state and chat history are never canonical project memory.

- **Project operations increment 1** — IMPLEMENTED. Built-in pipeline roles and
  the conversational orchestrator automatically resolve trusted target-local
  prompt overrides. Planner/Coder/Reviewer prompts now carry the independent
  contract discovery and enforcement duties needed for reusable target-project
  operation without requiring ad-coder's exact documentation layout.

- **Phase 0** — DONE (`55f32ff`). Role preset over AgentHarnessOptions; Ledger
  of per-turn usage attributed by role/step/run, cost from Usage.cost never
  recomputed, records carry identifiers+numbers only.
- **Ledger fix** — DONE (`90bdf67`). after_response usage is per-response, not
  cumulative (proven by revert-fails-tests). diffUsage/UsageDeltaTracker kept
  for the genuinely-cumulative message_update source.
- **Phase 1** — DONE (`9976aaf`). In-house context management: ContextBudget on
  Role validated against a CALLER-SUPPLIED Model (local/LM-Studio safe),
  ContextCompactor via transform_context with ad-coder's own prompt,
  assertTurnFitsBudget pre-flight (a function, not a hook — a hook throw cannot
  refuse a turn). The transform_context rewrite was later found not to shrink
  the session (#444); see the activation entry below.
- **Compaction activation** — DONE. `auto` is the resolved default and uses the
  cheap-tier model through a one-shot no-tool summarizer; `disabled-then-halt`
  performs a full-branch refusal without summarization. `cache-aware` remains a
  fail-loud reserved mode until request assembly is verified. Pi's own
  compaction is ENABLED and is the writer: ad-coder owns the policy by supplying
  the summary through the `before_compaction` hook, so the harness commits a
  durable entry and the session really shrinks (#444). The role's system prompt,
  tool definitions and skills catalogue never enter the summarizer — only
  dialogue history does. Invariants: `docs/contracts/compaction.md`.
- **Capability matrix** — DONE. `src/capabilities/capabilities.ts`:
  `deriveCapabilities(model)` yields a ModelCapabilities descriptor — cost mode
  (per-token when any cost field is nonzero; else local when the baseUrl host is
  loopback/private or the provider matches /lmstudio|vllm|local/i; else
  prepaid), `cacheControllable`, context window, cache read/write unit costs,
  out/in ratio. The corrected controllability predicate is `model.api ===
  "anthropic-messages" || model.compat.cacheControlFormat === "anthropic"` — NOT
  the format alone, which is a false negative on native Anthropic. Two pure
  metrics: `cacheEfficiency = cacheRead / (cacheRead + input)`; `breakEvenReads`
  (fable-5 = 1.4, `"always"` when cacheWrite is 0, `"degenerate"` when input <=
  cacheRead). `reconcileRoleWithModel` WARNS (never throws) when a role's
  cacheRetention is inert on its model. The empirical declared-vs-observed layer
  from the first live response is deferred.

- **Quality gates** — DONE (`b94b8e9`). `src/gates/`: a QualityGate declared as
  config { name, kind: format|lint|typecheck|size, command, autofix?,
  maxLinesPerFile? }; a GateRunner with an injected CommandExecutor seam
  (testable with a fake, no shelling out), autofix-first-then-check, in-process
  size gate, bounded fail-loud GateReport, argv-only (no shell string). Not yet
  wired into ad-coder's own build — a deliberate follow-up.
- **Minimal human console (step 5.5)** — IMPLEMENTED. `ad-coder console
  --target-dir <dir>` is a thin formatted/JSONL REPL over `startOrchestrator`,
  retaining one persistent session, bounding each input line by configurable
  UTF-8 bytes, sanitizing terminal controls, and closing once on every exit path.
  Unrestricted host-tool execution is accepted for this MVP; configurable
  session turn-count and cost thresholds are implemented at the shared Models
  boundary. The TUI is the next follow-up.
- **Historical delivery evidence (2026-09-12)** — The compaction activation
  delivery was squash-merged as `f110b26` after 197 passing Bun tests, `bun run
  check`, and GitHub CI; command-registry CLI help was squash-merged as
  `4ad5b78` after 199 passing Bun tests, `bun run check`, and GitHub CI. A later
  session-limit delivery recorded a full local Bun 1.3.0 run of 218 tests with
  zero failures before its subsequent review identified unproven edge-case
  coverage; see the dated review receipt for the final review status.

## pi ecosystem: reuse the libraries, do not fork the agent (decided 2026-09-11)

Prior-art recon of the pi ecosystem (`@earendil-works/*`, by badlogic). Decision:
build on the LIBRARIES, never on the agent product.

- Build on `pi-agent-core` (low-level core: the turn-level cacheRetention control our
  economics needs), NOT on `pi-coding-agent` (the full `pi` CLI agent). Forking that
  means endless upstream-chasing, and it deliberately SKIPS the pipeline / sub-agents /
  plan-mode that are ad-coder's differentiation. In pi's own philosophy ("minimal core,
  extend via packages, we skip sub-agents/plan-mode") ad-coder is exactly the
  opinionated workflow layer you build yourself — so we do, standalone.
- **Reuse `pi-tui`** (MIT, standalone — deps only marked + get-east-asian-width; no
  coupling to the agent) as the TUI component library. Its built-ins map to our TUI
  almost 1:1: SettingsList (every setting reachable), SelectList (session list), Editor
  + autocomplete (chat input + slash commands), Markdown (role output), Image (pasted
  images -> vision), Box/VStack/HStack/ScrollView (panels + live cost/context), Loader,
  bracketed paste, themes; differential flicker-free rendering. ad-coder's TUI renders
  OUR data (ledger stats, sessions, the conversation loop) through pi-tui's controls,
  not a hand-rolled renderer. Adding it is a normal low-risk lib dependency.
- **Evaluate `chord`** (app-composition runtime: services, RPC, replicated state,
  plugins — the substrate pi's own RPC/package modes use) for the machine-API /
  top-orchestrator+Telegram / multi-user / plugin layers. A framework-sized commitment,
  so adopt deliberately for those specific features, not as the foundation.
- **Evaluate `pi-telemetry`** (vendor-neutral span/event telemetry contracts,
  exportable to standard tracing) as the substrate UNDER the ledger/observability: a run
  is a span, a role turn a child span, usage/cost/toolCalls its attributes — exportable
  observability instead of only our JSONL, and possibly consuming spans pi-agent-core
  already emits.

- **pi-package / SDK-embed evaluated (spike, 2026-09-11) — NOT for the core.** pi ships
  an embeddable SDK `createAgentSession(options)` (single agent session: model, tools
  [default-open, like ours], customTools, injectable session/settings/resource loaders,
  compaction, extension/skill/prompt-template/theme system). Its `CompactionSettings
  { enabled, reserveTokens, keepRecentTokens }` is byte-identical to our ContextBudget —
  design-alignment validation. BUT it does NOT surface a cacheRetention knob, a pluggable
  compaction STRATEGY (so no cache-aware compaction), or multi-role/sub-agents (single
  agent, "pi skips sub-agents"). Embedding it for the core loop would surrender exactly
  the cache-economics control that is ad-coder's centerpiece — "less work" but loses the
  goal. So the CORE stays direct on pi-agent-core; a pi-SDK-backed runner could later be
  an OPTIONAL alternative backend, never the default. (Reassuring: our independently-built
  design matches pi's serious project — same compaction shape, default-open tools,
  injected seams, extension model.)

Net: standalone harness + our differentiation on pi-agent-core; reuse pi's libraries
(pi-tui now; chord / pi-telemetry evaluated per-layer); never fork the agent.

## Workflow execution model (decided 2026-09-11)

The unifying architecture under the orchestrator, stepped mode, and pluggable
workflows — one substrate, swappable drivers.

- A **role** is the atom. `runRole` already runs any single role STANDALONE — e.g.
  the reviewer alone on a small diff, with no plan and no coder. Nothing new needed
  for "run one role by hand".
- A **workflow** is a named composition of role-steps, packaged as a SELF-CONTAINED
  MODULE DIRECTORY that bundles its worker prompts + step graph + routing profile
  (`workflows/pipeline/` is the built-in plan→[security]→code⇄review; users drop
  their own under `.ad-coder/workflows/<name>/`, enable/disable per config). The
  registry pattern (providers, profiles) applies — a third registry. This is the
  [[workflows-module]] refined.
- A workflow runs in two modes: **autonomous** (`runPipeline` to completion) or
  **stepped** (run one step and hand control back). The stepped substrate is
  implemented: `createWorkflowSession`, `step`, and `applyTransition` own the
  graph, while `autoDriver`, the human `drive` CLI, and the orchestrator are
  drivers over the same engine.
- **Stepped execution is the substrate; WHO decides the next step is a pluggable
  DRIVER.** Two drivers: the **human** (manual — "ran the plan, read it, ran the
  coder, looked, sent it back or on to the reviewer") and the **orchestrator** (an
  autonomous driver role). The orchestrator is NOT privileged — it is one driver of
  the same stepped engine, not the only way to run a workflow.

  REQUIREMENT surfaced by the stepped-engine review: `applyTransition(state, chosen)`
  is a pure reducer that TRUSTS `chosen` today (its only caller, the auto-driver, is
  trusted code). When a MODEL drives — the orchestrator picking a transition — that
  input is UNTRUSTED. So the orchestrator-driver work MUST validate `chosen` against
  the transitions `step()` actually offered (reference/shape match) and throw on a
  forged or stale one, the same parse-and-gate discipline as parsePlan/parseVerdict.
  A model must not be able to silently corrupt the round/phase invariants.

- **The orchestrator is ALWAYS present; auto/manual is a dial on its AUTHORITY, not
  a separate UI.** You can always talk to it — discuss, ask it to run a specific
  step or review something. What the auto/manual switch changes is how much it
  DRIVES the pass: in `auto` it advances steps itself; in `manual` the human
  advances (a slash-command to run a named role, or a natural-language request to
  the orchestrator), and it runs the one step, shows the result, and waits. So the
  two "drivers" are not two modes you pick between — the orchestrator is the
  ever-present surface, and the human's authority over transitions is turned up or
  down.
- **With no workflow connected there are just the roles**, run individually (that
  is `runRole` + the human deciding what runs next) — which is exactly the shape of
  manual stepping. A workflow only adds a step-graph (the transitions) over the same
  roles.
- **Driver and cross-cutting roles** (orchestrator, researcher, the common preamble)
  live OUTSIDE any workflow — `prompts/roles/`, `prompts/common/`. Their prompts are
  a DIFFERENT CATEGORY from a workflow's worker prompts, which live inside the
  workflow module (`workflows/<name>/prompts/`). Project overrides mirror the tree
  under `.ad-coder/` via the resolvePrompt search path already built. (This means a
  future migration of today's flat `prompts/*.md` into the workflow-module layout —
  do it WITH the workflows-module build, not before; the resolver already supports
  the paths.)
- **MVP delivery status:** the stepped substrate, human `drive` CLI, standalone
  roles, autonomous orchestrator driver, and daemon-free durable control plane
  are delivered. The remaining human-front follow-up is a TUI; custom workflow
  modules/plugins and richer multi-project operation remain future work.
- **REQUIREMENT — composable isolation + plan-reuse.** Worktree isolation and
  plan-reuse MUST be COMPOSABLE, not mutually exclusive: a plan reviewed in one pass
  must be implementable in an isolated worktree in the next. ad-coder must NOT
  inherit LDO's resumePlan-XOR-isolate limitation (there, resuming a saved plan and
  running isolated are alternatives you pick between). Concretely: the reviewed
  plan artifact and the worktree target are independent inputs to a run, and the
  stepped engine (which threads an explicit `WorkflowState`) is the substrate that
  makes this natural — a plan produced by one driver/target is a value another can
  resume against a different target.

- **REQUIREMENT — managed worktree lifecycle.** Worktrees created by ad-coder
  live under the project-local ignored `.worktrees/` root, not beside the
  repository or in `.ad-coder/` runtime state. After a verified merge, the
  publisher safely removes only its own clean, inactive worktree from a parent
  context; it retains and reports anything it cannot prove safe to remove.

- **DECISION — terminal front.** Replace the line-oriented `console` front with
  `tui`, implemented directly on `@earendil-works/pi-tui` alongside the existing
  `@earendil-works/pi-ai` stack. Keep machine commands and JSON as a separate
  headless surface. Start with a sparse main-screen `plain` presentation; themes
  are visual-only, while a future Claude-like layout is an independently selected
  presentation profile.

- **DECISION — one machine API.** Replace public `drive`, `run_role`, and related
  operation-mode commands with `ad-coder api`; remove `--json` rather than carry
  two JSON conventions. `api` mirrors TUI controls exactly, including shared
  orchestrator conversation, role/agent/workflow dispatch, skills, ceilings, run
  control, and profile list/show/select. Profile selection changes the
  orchestrator route as part of the visible profile map; a session-level `/model`
  control can select another profile-reachable model for the orchestrator alone.
  The headless workflow primitives remain the implementation substrate behind
  both fronts.

- **REQUIREMENT — modular core and shared session choice.** TUI, API, Telegram,
  future web and Matrix fronts, VCS/workspace adapters, forge adapters such as
  GitHub or GitLab, workflows, tools, and event transports are optional modules
  around one headless core. They share durable session/run identities and cannot
  own private lifecycles. The SessionManager lists and switches accessible project
  sessions for TUI, API, and Telegram; switching waits for an active turn rather
  than cancelling it, and subsequent input uses the selected session.

- **REQUIREMENT — isolated parallel lanes.** With the Git workspace adapter,
  the operator or orchestrator can launch independent role or workflow lanes in
  separate managed worktrees and branches. Admission proves disjoint mutable
  scope or requires an explicit bounded merge plan and integration lane; all
  lanes retain independent budgets, review, resume, and outcome. A non-Git
  workspace permits parallel research but one mutable lane only.

- **REQUIREMENT — runtime inspection.** Operator and orchestrator share a
  read-only, redacted session inspector: session/run/lane state, role/model
  tokens and provider-reported costs, totals, effective ceilings/profile, and
  bounded diagnostics. TUI/API also expose harness name, SemVer version, enabled
  module capabilities, and concise help through the same core projection.

- **REQUIREMENT — quality bootstrap.** Quality setup defaults on. Once a stack
  is detected and before initial code mutation, the researcher proposes a
  language-appropriate tests/format/lint/static-analysis/build/security profile
  and asks the operator. An approved specialised bootstrapper configures and
  validates it; installation remains explicit authority. Offline research reports
  the limitation and offers installed-tool inventory or operator-provided gates.
  Changes to stack, framework, component, dependency class, or test surface mark
  the profile stale and require the same strategy review before related code work.

- **REQUIREMENT — complete, navigable settings.** Every behaviour-changing flag
  or parameter is a declared short setting with validation, default, group, and
  visible effective source. Profile and project files configure the same registry
  with project precedence. TUI/API list groups first, then a requested group's
  settings, so discovery and editing stay navigable rather than rendering a
  single unbounded configuration page.

- **REQUIREMENT — SDK-first lifecycle hooks.** Standard harness lifecycle events
  are exposed as versioned extension hooks. A selected SDK's native hooks are
  adapted where present; ad-coder supplies only the missing event points, with
  exact-once delivery. Trusted hook modules can observe, guard, or own a bounded
  transformation; ordering, enablement, failures, and resume are deterministic.

- **REQUIREMENT — pluggable compaction strategies.** The current summary strategy
  compacts dialogue only through the independently routed summarizer role at 70%
  of the active role's window, with a one-third-window summary cap and bounded
  retry. After exhausted summary retries it defaults to the active role's model,
  retaining the summarizer request boundary and emitting visible durable fallback
  evidence. Refactor selection behind `CompactionStrategy` before adding
  alternatives such as sliding-window retention or future algorithms; static role
  frame and durable lifecycle remain outside every strategy.

- **DECISION — release policy is pluggable, ad-coder uses strict SemVer.** The
  core lets a project declare its own compatibility/version policy. ad-coder has
  release and `dev` branches: release versions are final SemVer, while dev uses
  the corresponding next-version SemVer prerelease channel. Neither GitHub nor a
  particular branching model is a core requirement for another project.
  Until the project supports external users, deliberate API and behaviour breaks
  need no migration layer; they remain versioned and explicitly recorded.

- **REQUIREMENT — price reconciliation preserves availability.** Provider/model
  catalogue prices and explicit configured prices are references. Provider-billed
  observations create a separately inspectable calculation overlay, without
  rewriting either source. A configurable provider/model variance band produces
  prominent notices and session-end reporting, never a price-driven dispatch
  block or hidden reroute. Catalogue-refresh failure is visible and falls back to
  valid cache, configured, or observed data; otherwise accounting is unpriced.

- **REQUIREMENT — layered execution boundary.** Default execution remains open
  host authority, with only a best-effort guard against unmistakably broad
  destructive commands; it is not isolation. Replace direct construction of
  `NodeExecutionEnv` in standalone and conversation paths with one
  `ExecutionBoundary` factory for built-in and module tools. Then add a real
  sandbox provider that fails closed if unavailable; an optional LLM guard may
  follow it as policy assistance, never as the security boundary.

- **REQUIREMENT — background agent dispatch.** A TUI operator and the
  orchestrator can launch built-in, prompt-defined custom, or ad-hoc agents
  without blocking interactive input. Project prompt files create and remove
  custom role identities; grants remain policy, not prompt side effects. A profile
  supplies `agents.defaultModel` for custom/ad-hoc work, while the orchestrator
  may choose any reachable profile model and the operator may require one.

- **REQUIREMENT — operator command parity and run observation.** The TUI exposes
  every orchestrator execution action, plus local help, profile, ceiling, and
  skill-selection controls. The machine JSON API exposes the same capabilities
  and semantics. Argument-less controls are local help rather than model work.
  Every role, ad-hoc agent, pipeline, and workflow outcome wakes the orchestrator
  by default, including manually started work; the operator can disable only that
  observation, not durable run evidence or their own status.

- **REQUIREMENT — continuously available conversation.** The TUI editor never
  blocks: submitted messages enter durable FIFO state, start a turn immediately
  when idle, and otherwise reach the next turn. Run and timer wakes make the
  orchestrator print a short event/data-or-error/next-action summary. Material
  decisions are visible throughout WIP; a task is not reported complete before
  its durable closeout.

- **REQUIREMENT — universal resume.** Every orchestrator, role, agent, workflow,
  queue, timer, and wake state survives orderly exit and process interruption.
  Resume restores context and continuation state rather than making the operator
  reconstruct it. An in-flight action is reconciled from durable evidence; an
  ambiguous external effect pauses visibly instead of being duplicated or lost.

- **REQUIREMENT — estimate, probe, then decompose.** Before work, the
  orchestrator forecasts the entire selected development cycle, including its
  roles, workflow, review/rework rounds, routes, and budget reserve. A capacity
  or complexity signal permits one measured ceiling probe only when later roles
  remain funded; otherwise it causes decomposition. Planner/coder/reviewer
  complexity signals and review loops become durable, non-punitive feedback that
  the orchestrator can query before later estimates.

- **REQUIREMENT — policy-bounded execution choice.** Project settings override
  profile defaults for direct edits, required roles, required review, and the
  large-output delegation threshold. Direct edits are `off` or `reviewed`; the
  latter requires independent review and records the orchestrator's judgement
  rather than treating diff size as a safety proof. It may select only useful
  roles (for example, direct researcher or conflict-resolution coder) but cannot
  omit required review. It delegates high-output work to a specialist or `generic`
  agent to retain a compact orchestration context.
- **REQUIREMENT — breakpoint control (implemented).** Drivers can auto-advance
  through phases and pause before a chosen phase, then resume from durable state.
  The trusted `control run-until` action exposes this without requiring a caller
  to hand-step every transition; model-facing tools retain only the bounded
  transition authority described above.

## After that (designed, ordered)

- **End-to-end runner** — DONE. `src/runner/`: `runRole(params)` resolves a
  REQUIRED `targetDir` (harness-dir ≠ target-dir), builds `NodeExecutionEnv`-
  rooted `[bash, read, write, edit]` tools + a `FileLedgerSink` under
  `<targetDir>/.ad-coder/ledger/<runId>.jsonl` (the sink seam, not the cwd-
  confined `filePath`), projects the Role via `toHarnessOptions`, optionally
  attaches the compactor, and drives one `AgentHarness.create` →
  `lane('main').prompt` turn to a settled `OperationResultRecord`. Contracts
  settled: (1) target-dir separation via `resolveTargetDir` (realpath'd,
  symlinked-ledger-component refused); (2) credentials only from caller-
  configured `models`/`model` — never `process.env`/`<targetDir>/.env`, with a
  named cwd-inside-targetDir warning in the CLI; (3) `WorkflowContext.runRole?:
  RoleRunner` (additive, optional; `isWorkflowModule` untouched). `createRoleRunner`
  binds targetDir+models for workflows. CLI gains an optional `--target-dir`
  that wires `ctx.runRole` from `builtinModels()` (the CLI's own env). Proven by
  `test/runner.test.ts` with pi-ai's fauxProvider — zero network, no key. The
  bash tool is NOT confined to targetDir (it is a starting cwd, not a sandbox);
  real out-of-process sandboxing (seccomp/container/egress deny) remains a
  follow-up, with `activeToolNames` the current gate.
- **Runner tools seam** — DONE. `runRole`/`RunRoleParams` and `RoleRunner`/
  `RunRoleOptions` gained an OPTIONAL `tools?: Tool[]` that EXTENDS the built-in
  `[bash,read,write,edit]` set, plus `defineTool`/`Tool` (ad-coder's own tool
  surface, parallel to `defineRole`) and an `assertUniqueToolNames` collision
  guard (a custom tool colliding with a built-in or another custom tool throws a
  typed `RunnerError` code `tool_name_collision`, never silently shadowed).
  `activeToolNames` still filters the combined set uniformly. Absent `tools`
  reproduces prior behavior byte-for-byte. This UNBLOCKED the genuine
  `submit_verdict` tool-call verdict (now DONE — see Self-hosting) and per-role
  custom tools (e.g. the conversational orchestrator's run-pipeline / show-ledger
  tools).
- **`submit_verdict` tool-call verdict** — DONE. The orchestration reviewer now
  submits its verdict by CALLING a `submit_verdict` tool built per reviewer round
  (via the `runRole` tools seam) instead of writing a JSON artifact; the
  filesystem `.ad-coder/verdict/` scheme is retired. `parseVerdict` stays the
  authoritative strict validator (the tool's schema is permissive at the enum
  leaves), an absent call is `missing_verdict` and a failed validation is
  `malformed_verdict` — both hard `OrchestrationError`s. The next step on the
  same pattern, `submit_plan` for structured complexity, is also delivered; its
  complexity-aware routing consumer is described below.
- **`submit_plan` requirements governance** — DONE. A configured planner must
  submit STRUCTURED complexity (`trivial`/`medium`/`complex`), summary, project
  type, affected surfaces, and one contract-coverage decision per surface by
  CALLING a `submit_plan` tool built per planner turn (via the `runRole` tools
  seam), mirroring `submit_verdict`. `parsePlan` is the authoritative strict
  validator (schema permissive at the leaves). Malformed or incomplete coverage
  is `malformed_plan`; `missing_plan` is raised only when no attempt produced
  plan-shaped content at all, since a rejected submission is not an absent one;
  and a `research_required` decision enters a durable Research phase before
  coding. Both mandatory planner/reviewer handoffs now prefer the
  provider-native strict JSON-schema tool-call mode when available, while
  retaining portable fallback and authoritative parser validation. The planner
  fallback reads a bare, fenced or prose-embedded object and shares the retry
  budget between a rejected submission and a missing one.
  Inputs are bounded, IDs must be unique, and contract IDs resolve through a
  deterministic exported canonical index. Optional surface-analysis governance
  limits are production-configured with zero-disabled semantics and effective
  source provenance. Research uses separate mandatory positive transport and
  persistence ceilings, a strict response schema, independently loaded canonical
  contract evidence, and normalized secret-free provenance. Its deterministic
  intent is checkpointed before dispatch; ambiguous dispatches and validation
  failures become actionable durable pauses, with explicit operator resume. This unit
  makes complexity available on `result.complexity`; the Profiles +
  complexity-aware routing implementation below consumes this signal.
- **`submit_plan` securitySurface + conditional Security phase** — DONE. The same
  `submit_plan` call now also carries a `securitySurface` (`none`/`low`/`elevated`),
  strictly validated by `parsePlan` (schema permissive at the leaf; a bad value is
  a hard `malformed_plan`, never coerced or defaulted) and surfaced on
  `result.securitySurface`. On an `elevated` surface AND a configured `security`
  role (`PipelineConfig.roles.security?`), `runPipeline` runs a conditional
  Security phase (ledger `step: 'security'`): a read/bash-only threat-modelling
  role is driven with the task + plan summary + a fixed OWASP instruction, and its
  final text is threaded as hard mitigation requirements into the coder's round-1
  prompt and every reviewer prompt (as DATA, like `VerdictIssue.what` — no new
  sink). Elevated with no security role skips (a quiet stderr note) and proceeds.
  This first cut THREADS TEXT; the follow-on is a STRUCTURED `submit_security` tool
  (mirroring `submit_verdict`/`submit_plan`) so mitigations arrive as validated
  structured findings rather than free text.
- **Research surface + conditional Research phase** — the THIRD field the planner
  rates via `submit_plan`, beside `complexity` and `securitySurface`, following the
  same pattern as the Security phase above. WHO decides research is needed: the
  PLANNER rates it (fine — it reads the code and is the only one who can judge
  whether a feature reaches into an UNKNOWN CONTOUR), the ORCHESTRATOR/caller keeps
  a COARSE override (force it — LDO's `research: true` — or forbid). NOT
  orchestrator-only: the orchestrator triages before any code is read and is blind
  to per-feature contour familiarity. TWO MOMENTS: (1) BEFORE CODING — the plan is
  sound but implementation needs external facts, so a conditional Research phase
  runs (ledger `step: 'research'`, a researcher role with WEB tools) and its
  findings thread into the coder round-1 + reviewer prompts as DATA (like
  securityNotes, no new sink). Concrete case: about to add a REST API — research
  what's already available for the stack in use (e.g. Hono/Fastify + OpenAPI
  codegen) instead of hand-rolling on raw `http`; prior-art-before-building applied
  PER FEATURE. (2) BEFORE PLANNING / RE-PLANNING — the contour is unknown enough
  that the planner cannot ground a plan, so it marks research `required` with
  questions rather than emit a weak plan; the orchestrator runs the researcher and
  RE-PLANS with the findings. ECONOMICS = the "strong model upfront" argument: a
  wrong plan in unknown territory burns several wasted full Coder+Reviewer rounds;
  research is cheap insurance. BUILD is almost free — precisely the securitySurface
  pattern already shipped (planner-rated field → conditional phase → findings as
  data), and the researcher is the SAME role bootstrap uses (research at project
  start; this = research per feature inside an existing project). Soft/hard mirror
  submit_plan: an absent flag is not an error (only malformed is hard); `required`
  with no configured researcher role pauses durably before Coder dispatch. The
  current implementation sends only canonical surface/contract identifiers and
  never arbitrary task or planner prose. Broader research-provider integrations
  remain dependent on the researcher role with web tools (tools-seam DONE; web
  tools + network-default-open both decided).
- **Wire ad-coder's own gates** — the gates module exists but ad-coder still runs
  only typecheck+test on itself. Add a size gate + (when a formatter/linter is
  chosen) format/lint gates over the repo. Dogfooding the gates-over-prompts
  principle. Small.
- **Doc taxonomy** — organize docs by enforcement role, not genre: contract
  (addressable by trigger, injected into the role that touches its area) /
  decision record (immutable) / work item (backlog) / orientation (README) /
  executable process (a gate/test, never prose). Most "docs" should be a
  contract-with-a-trigger, an immutable decision, or — if enforceable — a gate,
  not freeform prose. Trust perimeters are contracts. ad-coder ships this as an
  opinionated default so users don't reinvent docs/ chaos.
- **REQUIREMENT — portable project practices.** Documentation, contract writing,
  decomposition, quality setup, and actionable error handling ship as named
  versioned practice bundles.
  `bootstrap` and `init` propose a preview from project evidence; the operator
  selects individual practices. A bundle is removable or replaceable without
  overwriting edited project assets, and its guidance follows the project's
  configured documentation language. See [project practices](contracts/project-practices.md).
- **Auditor role + refactor executor** — recognizing decomposition needs vs doing
  them safely, two tools. Auditor: a cold-read role triggered by a drift signal
  (size band, churn, drift-log-reaches-8) that surfaces decomposition candidates
  WITH EVIDENCE into the backlog, never acts. The size gate is the crude floor;
  the auditor is the judgment layer. Refactor executor: test-pinned —
  characterization tests first, refactor under green in small behavior-preserving
  steps, "did a test have to change?" is a visible justified event (extends the
  revert-and-restore proof), and LSP/AST moves (rename/extract, safe by
  construction) preferred over LLM regeneration. Large decompositions reshape the
  shared barrel/multiple modules, so they are NOT parallel-safe.
  The practice basis is recorded in
  [refactoring-practices.md](refactoring-practices.md).

- **Profiles + complexity-aware model routing** — DONE (src/profiles/ + runPipeline routing).
  These are two independent axes. A **profile** is a named replaceable execution
  context: one model inventory/routing policy plus its private credential binding
  for each enabled provider. For example, `home` may bind DeepSeek, OpenRouter,
  and a personal Codex OAuth credential, while `work` binds a separate Codex OAuth
  credential and any authorised work providers. A provider account scope is
  therefore `(profile, provider)`, never merely a model name; CreditWallet and
  ProviderAdmission keep those scopes separate. Switching profiles changes future
  work through the operator-facing stored routing source
  `~/.config/ad-coder/models.yaml`, which is the ONLY routing source: the stored
  `inventories.json` route is gone from the code (issue #513), so a file left on
  disk is read by nothing and there is no migration command to name. Profile
  changes affect future work without changing workflow semantics; a live or
  paused durable run remains
  pinned to its original profile. **Complexity** selects the most
  economically efficient model inside that active inventory. Quality is an
  invariant gate at every complexity, never an economy-versus-quality mode.
  Optimize expected total cost through acceptance, including repair and re-review;
  a stronger model is the economical choice whenever it avoids more downstream
  cost than its price premium. The planner emits structured complexity
  (trivial/medium/complex) via
  `submit_plan`, surfaced on `result.complexity`; routing selects each post-plan
  role from its `(complexity × role)` profile cell, with the configured default
  complexity as the fallback when the planner emits no structured signal.
  The Orchestrator supplies the initial/pre-plan complexity from mechanical task
  signals and calibrated project history; Planner refines it for later roles.
  Misclassification is observable through limit hits, rework rounds, escaped
  findings, and total accepted-result cost, and feeds later calibration.
  Calibration records three distinct values: Orchestrator's pre-read estimate,
  Planner's evidence-backed rating, and observed complexity from scope changes,
  limit hits, rounds, gates, and accepted-result cost. Corpus labels seed the
  Orchestrator; live Planner disagreement is project-local feedback, not an
  automatic truth or a silent rewrite of user calibration.
  A bounded Coder closeout with no edit evidence is also a first-class
  decomposition signal. Record the task shape and the `(role, model)` outcome,
  then require smaller sequential child slices for cross-surface work (for
  example persistence + worker assembly + prompt wiring) before another broad
  dispatch. It may lower that model's confidence for the matching task shape,
  but never declares a model globally incapable from one failed sample.
  **Current Codex product decision (2026-09-12):** the zero-config OAuth preset
  deliberately pins Coder to `codex-sol` with medium thinking at every complexity,
  Reviewer to `codex-terra`, and Recorder to `codex-luna`. Keep this until profile
  evals justify a change; do not infer that the generic Coder tier matrix should
  override the explicit Codex preset.
  ad-coder EDGE: the ledger already measures per-role/round cost, so routing can
  later be LEARNED from observation ("cheap coder averaged 2.3 rounds on medium
  features, strong 1.1 — which is cheaper end to end?") rather than only declared —
  static table to start, ledger data to refine. Ledger's per-lane attribution
  also lets one workflow run under two profiles and compare two JSONL files.
  The current single selected profile file is the substrate. Named, atomic
  named atomic profile switching remains a follow-on; it must never silently move
  an active durable run across providers or credentials.
- **In-repository model calibration suite (decided 2026-09-13)** — keep small,
  versioned, realistic evaluation repositories under `evals/fixtures/`, role and
  complexity tasks under `evals/tasks/`, headless execution under `evals/runner/`,
  and deterministic plus independent-review scoring under `evals/scorers/`.
  Raw provider outputs and run state stay gitignored under `.ad-coder/evals/`.
  The corpus exercises the harness on adversarial shapes; it does not rank
  models and does not seed a routing cell (see AGENTS.md, "Model routing"). Cover Planner localization, Researcher evidence,
  Security seeded vulnerabilities, Coder changes at all three complexities,
  Reviewer/Auditor hidden regressions, Orchestrator mode/complexity/escalation,
  and Summarizer fact retention. Score quality gates first, then total cost to
  acceptance including repairs and re-review. Calibration supplies a starting
  matrix for a new inventory; project-specific outcomes progressively refine it.
  The minimum coding corpus includes a trivial local change, a medium behavioral
  repair, a medium behavior-preserving refactor, and a complex cross-surface
  feature; reviewer-only hidden-defect work remains a separate measurement.
  Split fixtures into another repository only when their size or incompatible
  toolchains make the main repository materially harder to maintain.
  Bootstrap any new provider inventory from recorded provider guidance,
  provider benchmarks, and independent evals, then falsify that seed against the
  local corpus from the cheapest plausible model at low effort. Store the
  corpus-calibrated base in user configuration and layer project-calibrated
  `(role, complexity)` overrides from `.ad-coder/`, with source provenance in
  effective configuration and no cross-project mutation of the base. A profile
  may span providers; prefer cross-family Coder/Reviewer pairs when
  available to reduce correlated blind spots, and use provider-recommended
  within-family variants when a profile cannot span families. Routing never
  reaches outside the profile the operator authored.
  Economic calibration keeps token-billed API cost separate from subscription
  capacity. Prefer provider-reported request cost, retain a token-price estimate
  for reconciliation, and model context-window price tiers explicitly. For
  subscriptions, retain published limits when available and bounded observed
  ranges between confirmed rate-limit/reset events. Each confirmed change is an
  append-only dated record with source and confidence. The user profile owns the
  full history; a project stores only the current anonymous snapshot and its
  local routing override.
  Export/import moves a versioned user profile between machines. Export omits
  credentials, account identity, raw responses, transcripts, and precise private
  activity times. Import is previewable, validates the full artifact before an
  atomic write, and requires an explicit replace/merge conflict policy.
- **Project memory** — committed, machine-portable (laptop↔desktop via git).
  Decided: autonomy default `push` (agent commits+pushes), commits on the
  working branch (one `git pull` brings code+memory atomically). Non-negotiable
  structural invariants regardless of autonomy: secret-scan before write (built
  INTO ad-coder, not a dependency on an external scanner that may be absent on a
  given machine; gitleaks as optional augment), commit ONLY the memory namespace
  (never `git add -A`), per-file layout so cross-machine merges never conflict,
  never force-push. Block-and-shout on a detected secret, never auto-redact
  (a miss gives false confidence; a mangle corrupts memory). Live resume across
  machines is impossible (resumeFromRunId cache is in-process) — a checkpoint
  replaces it with an informed restart.
- **Parallel runs** — worktree-isolated independent features, Ledger already
  carries the `lane` dimension for per-lane cost attribution. Combines with
  profiles (different model per lane). Bounded by the module-parallelism
  principle: only file-disjoint work parallelizes cleanly.
- **Proxy / split-tunnel** — proxy traffic to remote model APIs while keeping
  local/LAN model servers direct. pi-ai supports this first-class:
  `ProviderRequestOptions.fetch` (per-request custom fetch) and `.env`
  (provider-scoped, takes precedence over process.env "for proxy variables",
  per its docstring); Bun honors HTTPS_PROXY/NO_PROXY natively (Node/undici does
  not without a ProxyAgent). KEY DESIGN: the proxy-bypass decision is the same
  `isLocalHost(baseUrl)` predicate already in capabilities.ts — NOT a NO_PROXY
  string (which can't do CIDR and is weakest exactly on the 10./192.168. LAN
  ranges isLocalHost already handles structurally). Note it is isLocalHost, NOT
  costMode==='local' (the latter also requires zero cost; a paid vLLM on the LAN
  must still bypass). So: EXTRACT isLocalHost into a shared exported predicate
  used by both costMode classification and proxy routing. ProxyConfig { url,
  bypass?: (model)=>boolean } with bypass defaulting to isLocalHost(baseUrl); the
  runner injects fetch/env per model. Composes with the runner (which owns
  request construction) — build it there or as a sibling. Limits: don't mix
  env-based and injected-fetch proxying; `fetch` injection does not affect
  WebSocket transports.
- **Sandbox + credential broker** — upgrades the runner's honest limit (targetDir
  is a starting cwd, not a jail). Prior art: the operator's
  github.com/aadegtyarev/claude-orchestrator (bwrap sandbox seeing only the work
  dir + own home, ~/.ssh and neighbors cut off; a host-side `vault` daemon that
  keeps secrets on the host and runs git/gh/curl with creds injected, the session
  seeing only a marker). ad-coder version, fitted to our DEFAULT-OPEN philosophy: (1) both are
  OPTIONAL INJECTED SEAMS — `Sandbox` (bwrap = Linux; microVM / macOS sandbox-exec
  / container / none behind the seam, never a hard dep) and a `Wallet`; (2) NETWORK
  IS DEFAULT-OPEN — an autonomous research/design agent reaches anywhere; an
  egress/host allow-list is OPT-IN only for hardened runs (NOT a default — pre-
  declaring hosts is the same enumerate-everything-is-fragile trap as the tool
  allow-list); (3) the WALLET is the single conscious secret-orchestration point
  with two modes — BROKER (runs git/gh on the host with the cred, returns the
  result, agent sees only a marker) and INJECT (puts CHOSEN secrets/env into the
  sandbox for the agent to use directly): "this run gets DEEPSEEK_API_KEY and
  GH_TOKEN, nothing else"; (4) honest residual (inject + open network = a
  compromised agent could exfil an injected secret) is managed by scoping WHICH
  secrets enter (prefer broker-mode for high-value creds; inject only what the run
  needs) + LEDGER-AUDITING every privileged op and injected secret — safety from
  conscious scoping + observation, NOT from egress limits. Composes with the
  runner credential boundary. The sandbox turns the runner targetDir from a
  starting cwd into a real jail. Needed before unsupervised runs on an untrusted
  task.
- **Task prompt templates** — system prompts as files are implemented: pipeline
  and orchestrator assembly automatically use trusted, byte-verbatim project
  overrides from `.ad-coder/prompts/`. The remaining gap is optional task/user
  prompt templating via pi's `loadPromptTemplates`; it must not alter the resolved
  system prompt's cacheable bytes.

- **Workflows module (pluggable flow-scripts)** — the LDO-style pipeline flow ships
  IN the harness but is OPT-IN: enable/disable the built-in flow, and let users author
  their OWN workflows. HALF-BUILT already: `ad-coder run <script.ts>` loads a workflow
  module (isWorkflowModule + WorkflowContext), so "write your own" partly exists as
  run-a-file. GAP = turn run-a-file into a WORKFLOWS REGISTRY, the same declare +
  resolve + presets shape as the provider registry and the profile module: built-in
  workflows as NAMED discoverable entries + project workflows (.ad-coder/workflows/*.ts,
  project overrides by name, mirrors the prompts-as-files search path) + a config to
  enable/disable the built-in flow + pick-by-name (not only by file path). The built-in
  pipeline becomes the DEFAULT workflow, not a hardcoded assumption. Slots after the
  orchestrator (the thing that chooses and drives a workflow).
- **`ad-coder bootstrap` — start a NEW project (research-first)** — the greenfield
  sibling of `init` below (which ADOPTS an existing project). LDO's `/ldo-bootstrap`,
  which THIS project itself came from: a conversational, research-first flow —
  (1) separate the problem from the proposed solution; (2) PRIOR-ART RESEARCH ("does
  it already exist? can we build ON something?") via a researcher role/subagent with
  WEB tools; (3) shaping questions, only the ones that FORK the stack; (4) propose a
  stack + phased roadmap, each choice with a rejected alternative; (5) `git init`
  locally + OFFER to create a repo; (6) hand the first Phase-0 task to the pipeline.
  KEY: the research step is the highest-LEVERAGE one because it runs BEFORE a line of
  code and can change the whole FOUNDATION — self-proven here (the prior-art search
  found the pi packages and turned "write a bespoke harness" into "build on an MIT
  SDK"). So research is first-class in bootstrap, never skipped. This is the
  GREENFIELD MODE of the conversational orchestrator; `init` is the ADOPT-EXISTING
  mode — two entry points. Depends on: the orchestrator (its mode) + a researcher
  role with web tools (tools-seam DONE; web tools + network-default-open both decided)
  + the git-init/offer-repo step (Publisher-adjacent). The first publish + repo
  bootstrap of ad-coder itself was done BY HAND this session; bootstrap automates it
  for the next project.
- **`ad-coder init` — adopt an existing project** (built by another harness, e.g.
  Claude Code). DISCOVER and DECLARE, never overwrite. Two tiers: (A) mechanical —
  adopt existing gates from the project's own configs (package.json scripts,
  eslint/prettier/ruff/tsconfig/go.mod/CI), matrix discovers providers, existing
  docs indexed onto the taxonomy (never rewritten), ad-coder adds its namespace
  alongside. (B) cold read — the auditor proposes orientation + contracts the code
  implies, as human-confirmed candidates. NOT a new mechanism: gates + auditor +
  matrix + taxonomy in discovery mode on a target tree. Depends on: gates (done),
  matrix (done), auditor.
- **Session persistence — DELIVERED (Increment 2)** — the runner's injected
  Session seam now defaults to ProjectStore-backed JsonlSessionRepo
  under <targetDir>/.ad-coder/sessions/ for durable, inspectable, forkable
  sessions; session identity = runId (= ledger key), so session + ledger +
  checkpoint = one addressable unit. Durable reload from disk IS possible (unlike
  LDO's in-process resume cache). The session is where compaction's effect lives.
  Small extension of the runner seam.

- **In-project scratch (working files + attachments) — FOUNDATION DELIVERED (Increment 2)** — a gitignored working-files
  area INSIDE the project (not external — knowledge and working material both stay
  in the project), for: agent drops/downloads a file, TUI-pasted images (fed to a
  vision model by path), and throwaway TEST SCRIPTS / SPIKES the agent writes AND
  runs (the recon-before-planning pattern that has already caught wrong assumptions
  twice). HOME: no new namespace — `.ad-coder/` is already the gitignored runtime
  dir (ledger/sessions); scratch is `.ad-coder/scratch/`. GITIGNORE MECHANIC: write
  `.ad-coder/.gitignore` containing `*` so the folder ignores its own contents and
  the project's own `.gitignore` is never touched. TWO trust postures: external
  content (downloads, pasted images) is inert data referenced by path; the agent's
  own spikes are meant to RUN — which is exactly where the sandbox matters (the
  spike runs inside the jail). Keying (decide when built): per-run
  (`.ad-coder/scratch/<runId>/`, symmetric with the ledger) vs per-session (chat
  attachments outlive a run) — likely both, same runId key as ledger/session.
- **Structured FollowUps + pluggable backlog — DELIVERED (Increment 3)** — one
  validated union now carries contract, note, design-doc-drift, and backlog
  candidates with deterministic provenance aggregation. Documentation routing
  returns safe fixed-template proposals. Exactly one BacklogStore is selected:
  ProjectStore-backed files by default or opt-in GitHub issues. Both persist only
  a structural metadata projection of candidate prose. A machine JSON CLI covers
  the same APIs, including the read-only capability probe and one-time migration
  advice. Shared-store claim serialization is supported; multi-host claiming without a shared
  ProjectStore is explicitly unsupported.
- **Run coordination and durable closeout — DELIVERED (Increment 4)** — every
  built-in driver now uses the same non-model `RunCoordinator`. Role turns may
  submit strictly validated FollowUp candidates; the engine adds unforgeable
  producer/run/branch provenance, aggregates every round, and checkpoints the
  workflow, pending step, effects, decisions, contract re-reviews, and terminal
  result with ProjectStore CAS. Notes, authorized existing design docs, and file
  backlog items close automatically with stable destination markers/IDs;
  contract and ambiguous product choices stop on durable operator decisions.
  Accepted one-line contracts are written exactly once and force a reviewer-only
  pass over the current implementation before approval can close. Numeric
  coordinator limits default to `0` (disabled).
- **Existing-LDO project adoption — DELIVERED (Increment 5)** — headless and
  machine-JSON operations detect the established `.codex/ldo` and documentation
  taxonomy without migration or scaffolding, preview without writes, and import
  version-1 plan/run artifacts as immutable digest revisions. Exact source bytes,
  observed provenance, artifact-claimed provenance, explicit digest trust, and a
  versioned manifest survive ProjectStore reconstruction. No source LDO artifact
  or project document is overwritten. Resume translates only supported stage
  combinations into the native workflow/RunCoordinator and rejects untrusted,
  changed, malformed, unsafe, oversized, or unsupported inputs. Numeric limits
  default to `0` disabled; trusted prompt overrides and the accepted no-sandbox
  MVP stance are unchanged. Distributed GitHub coordination remains later work.
- **Repository publishing — DELIVERED (Increment 6)** — headless and JSON
  operations implement remote-HEAD/main/master base discovery, feature branches,
  isolated explicit-path commits, local/CI/combined/manual gates, explicit push,
  structured PRs, exact-head external approval, and GitHub/local squash merge.
  Protected bases, dirty work, moving refs, empty CI, and changed PR heads fail
  closed with the feature branch and recovery guidance preserved.
- **Multi-user + pluggable backlog** — multi-user is the SAME conflict-avoidance
  as project memory (per-file records) + worktree isolation, under more writers;
  the ledger gains an actor/user dimension. The delivered BacklogStore remains
  single-host/shared-store for claims; a future distributed coordination design
  is required before advertising multi-host issue claiming.
- **Self-hosting** — move ad-coder's own development onto ad-coder (CLI-only, no
  TUI). Three rungs: (1) touches its own code (runner done + a live provider turn
  on a scratch change); (2) does a feature supervised — **DELIVERED**: `src/orchestration/`
  (`runPipeline`) wires optional-plan → code⇄review roles via `runRole`, with a
  strict reviewer verdict protocol; (3) self-hosts unsupervised (own gates +
  review as guard). The engine the MVP was missing — orchestration above
  `runRole` (sequence + code⇄review loop) + a reviewer verdict protocol — now
  ships: the reviewer submits its verdict by CALLING a `submit_verdict` tool
  built per reviewer round (via the `runRole` tools seam) and strictly validated
  by `parseVerdict` — the filesystem-artifact first-cut is retired. The planner's
  `submit_plan` structured complexity and its complexity-aware routing consumer
  are delivered. Bootstrap caveat: a bug in the runner/orchestration corrupts
  its own development, so early self-hosting stays partial (narrow modules via
  ad-coder, risky core via LDO or human) and supervised; faux tests + human remain
  ground truth for the core.

- **Conversational orchestrator** — CORE DELIVERED (2026-09-11, `src/orchestration/orchestrator.ts`).
  The headless core + thin tool-front cut of the top interface layer: a chat that
  shapes the task, then drives the pipeline (stepped or autonomous). The one
  genuinely NEW primitive it needed — a multi-turn CONVERSATION LOOP — landed
  earlier as `startConversation`; this cut composes it. `createOrchestrator(deps)`
  is the headless core (the THIRD driver of the stepped engine, reachable WITHOUT
  the chat front): `runPipeline`/`resumePipeline`/`beginStepping`/`stepOnce`/`chooseTransition`/
  `showCost`/`isStepping`, with the untrusted model-supplied transition KIND
  validated against the engine-authored offered set via `assertTransitionOffered`
  before `applyTransition` (the requirement the stepped-engine review surfaced).
  `buildOrchestratorTools(core)` exposes run_pipeline, resume_pipeline,
  decompose_task, run_step, choose_transition, and show_cost via the tools-seam, profile-switchable
  like any role; `startOrchestrator(config)` assembles the conversational front over
  `resolvePipelineConfig` + `resolvePrompt('orchestrator')` + `startConversation`,
  sharing ONE ledger sink. The orchestrator prompt carries JUDGMENT only; mechanics
  (model routing, git staging) stay in the harness/config — gates
  over prompts. The transition guard (`DriveError`/`DriveErrorCode`/`assertTransitionOffered`)
  relocated DOWN to `src/orchestration/transition-guard.ts` so the headless core can
  depend on the guard without the CLI front; both drivers share one implementation,
  re-exported byte-for-byte from `src/cli/drive.ts`. The `console` CLI subcommand
  fronts `startOrchestrator`. FOLLOW-ONS (not built here) are the spawn/fork tools
  (spawn_subagent / fork, below) and researcher/publisher tools (each brings its
  own credential/URL/egress surface — flag it when it lands). Durable
  `control run-until` breakpoint control is implemented.
- **Orchestrator triage** — trivial-edit-inline vs run-the-pipeline. A MECHANICAL
  FLOOR (a change touching a contract, a security surface, or a size threshold
  forces the pipeline regardless of how small it looks) + the orchestrator's
  JUDGMENT above it + post-hoc deterministic gates as a backstop. The orchestrator
  triages coarse (pipeline-or-not, before any code is read); the planner rates fine
  complexity INSIDE the pipeline. Resolves the chicken-and-egg: the coarse decision
  needs no planner, the fine one lives where the code is read.
- **Subagents & fork** — one primitive, the context source varies. A SUBAGENT is
  runRole with a fixed role (planner/researcher/coder) or an ad-hoc prompt the
  orchestrator composes. A FORK is a subagent that inherits the orchestrator's OWN
  context and model and returns only a summary — context economy: spin off a
  detour, keep only its conclusion, not its whole transcript. Unblocked by the
  runner tools-seam (done); the orchestrator gets spawn_subagent / fork tools.
- **Common preamble + orchestrator profile** — a short shared prompt preamble that
  ad-coder COMPOSES and prepends to every role's system prompt BEFORE handing the
  final string to the harness (so the verbatim/cacheable guarantee holds — the
  harness still sees one opaque string). This is where the CONTEXT-ECONOMY
  discipline lives ONCE (turns x context, carry-less-forward, grep-before-open,
  batch calls, cap output, don't re-read) instead of being triplicated across role
  prompts — it was deliberately held out of the 2026-09-11 prompt-fidelity pass for
  exactly this home. The orchestrator role itself is profile-switchable like any
  other. Cache-optimal: a stable preamble is a shared cache prefix.
- **Publisher role integration** — the headless policy is delivered; a future
  orchestrator wrapper can invoke it as ad-coder's /ldo-ship equivalent: tidy the work, create a
  branch, run the gates/tests as a HARD pre-publish check (a gate, not a prompt),
  open a PR, squash-merge. Its job is git/gh operations, so it needs PRIVILEGED
  tools via the tools-seam + ideally the credential broker (git push / gh pr run on
  the host with creds, the agent sees results not secrets). Can be a pipeline phase
  after an approved verdict or a standalone tool the orchestrator invokes. This
  session bootstrapped the first publish by hand; the Publisher automates it.

- **Configurable compaction (modes + disable + percent-of-window budget)** — DONE
  context management is the project's centerpiece, so its strategy is a first-class
  knob, not a hardcode (enforced by docs/contracts/config.md). Modes: (a) `auto` —
  summarize when the budget is exceeded; (b) `cache-aware` —
  compact in LARGE, INFREQUENT steps so the new `[system + tools + summary]` prefix
  stays stable across many following turns (editing the message-head invalidates
  the whole tail's cache, so the win is amortizing that to once-per-big-step and
  keeping the summary itself a re-cacheable stable prefix; the verbatim system
  prompt and tool defs are never touched); (c) `disabled -> halt` — never summarize
  silently, STOP and require an explicit manual clear/compact command
  (gates-over-prompts applied to context, for users who want no automatic edits to
  history). Auto and disabled-halt are implemented; cache-aware currently fails
  loudly pending the planned request-assembly reconnaissance. Also express the budget as a PERCENT of the model contextWindow
  (resolved to absolute tokens against the model) so one budget is portable across
  a 200k and a 32k model, keeping reserveTokens (room for the reply) as its own
  knob. Default to the most efficient mode. Recon first: verify pi's request
  assembly order (system -> tools -> messages) so the cache boundary is placed right.
  Self-hosting configuration now supports independent planner, security, coder,
  reviewer, orchestrator, and summarizer models. Model windows default to 200000
  but are overridable in either direction; each role derives its own percentage
  budget from its effective routed model. Until chunked/recursive summarization
  exists, auto mode rejects configurations whose summarizer window is below the
  maximum window reachable through routing cells, overrides, or orchestrator.
- **Pipeline-efficiency dogfood program (decided 2026-09-13)** — improve the
  built-in pipeline by running ad-coder's native roles on ad-coder itself,
  measuring each stage, and preserving useful partial work when a run is stopped.
  Optimize provider-weighted token cost, total input, wall time, and operator
  clarity without weakening contract coverage, security review, tests, or escaped-
  defect quality. Work in small independently reviewable slices. Before another
  expensive end-to-end run, provide durable whole-stage budgets and live usage.
  Then reduce repeated context at every source: make built-in and plugin tools
  return bounded task-specific projections instead of broad contents; narrow
  tool schemas and results so roles receive only fields needed for the current
  decision; keep role prompts short and move mechanics into code/contracts; and
  pass scoped plan, findings, diff, and contract excerpts between roles. Every
  optimization remains configurable, records its effective strategy and fallback,
  and falls back visibly to broader context when correctness requires it. Compare
  like-for-like dogfood runs before claiming savings, including Reviewer verdicts,
  gates, duration, turns, fresh/cache/output/reasoning tokens, and provider cost.
- **Incremental pipeline context (decided 2026-09-12)** — default to scoped
  handoffs between pipeline rounds instead of replaying a repository-wide working
  set. Planner starts from project orientation/docs and an incrementally maintained
  repository index, then opens only relevant modules; rebuilding that index on
  every plan is not an optimization. Broader reconnaissance remains available for
  architectural or poorly localized work. A Coder fix turn receives the original
  task, applicable plan excerpt and contracts, Reviewer findings, cumulative diff,
  and changed-file list, and reads other files on demand. A repeated Reviewer
  receives the prior verdict, the Coder's response per finding, the fix diff, and
  relevant contracts; it rechecks affected invariants rather than repeating the
  first audit. This is configured as `contextStrategy: incremental` and remains
  overridable. The engine automatically falls back to full context when files
  outside the accepted plan change, scope expands, contracts/design decisions
  change, the diff crosses its configured threshold, or a role explicitly reports
  insufficient context. Correctness wins over the optimization: fallback is
  visible in the run report and never silently weakens review. Per-stage telemetry
  records fresh input, cached input, output, selected/read files, diff size,
  strategy, and fallback reason so savings can be measured rather than assumed.
  Do not treat fresh input alone as paid usage: cached input can still have a
  discounted cost, and removing repeated context usually removes cached prefix
  tokens first while the new task/findings/diff tail remains fresh. Evaluate the
  optimization by provider-weighted input cost, total input, latency, and unchanged
  review quality; measure subscription-quota impact separately when the provider
  exposes it. The initial baseline is 450,913 fresh input tokens for the
  2026-09-12 LDO run, but no fresh-input target is an acceptance criterion until
  comparable runs establish one.
  The handoff-policy portion is delivered: the first review stays broad, later
  rounds default to focused unresolved-findings/evidence handoffs, and deterministic
  hazards widen review visibly. Strategy, threshold, and manual-control modes are
  configurable and the selected strategy/reason survive durable reporting. The
  baseline telemetry portion is also delivered: each completed stage exposes total,
  cached and fresh input, output, a bounded safe read-path sample/count, streamed
  cumulative Git diff bytes, and the resolved context strategy. Provider 429/quota
  exhaustion now pauses the durable run and resumes its existing coordinator
  checkpoint. Subscription lookup, fallback providers, context shrinking, and a
  measured like-for-like dogfood comparison remain outside this increment.
- **TUI — the human surface to everything, built for convenience** (Phase 3, after
  the orchestrator). Not a showcase: it EXPOSES the machinery already built,
  clearly and reachably. Chat with the orchestrator (images paste in later, fed to
  an AUTO/MANUAL mode switch (always visible) dials how much the orchestrator drives
    the pass; the orchestrator chat is ALWAYS available, only its influence changes.
    Run a role two ways: a SLASH/COMMAND with convenient names, grouped and sorted,
    OR a natural-language request to the orchestrator — it runs the step and shows
    the result. EVERY setting is reachable and clear in
  the TUI, not just configurable in code — model routing/profiles, compaction mode
  incl. disable->halt, percent-of-window budgets, providers, per-role tools; never
  buried. STATISTICS — the ledger made visible: live and historical cost per
  role/step/round/session, cache efficiency, break-even (the cost thesis is only
  real if the user can SEE it). SESSION LIST — browse, inspect, resume, fork.
  LIVE context/cache panel — usage vs budget, when compaction fired, hit ratio.
  Built on pi-tui. The bar is CONVENIENT, not merely functional.

- **Tool-source seams: MCP and LSP** — ad-coder has ONE tools-seam (a role gets
  tools via the runner's `tools?`); TOOL SOURCES are pluggable and feed it. Beyond
  the built-in bash/read/write/edit and custom `defineTool` tools, two source
  adapters (a client + tool adapters into the `Tool` surface — no new low-level
  machinery, they ride the existing seam):
  - **MCP seam** — connect MCP servers and expose their tools to roles. Opens the
    whole MCP ecosystem: a browser (Playwright MCP) to drive/debug a running web app
    (click, read console, screenshot — a general "drive the running app"), plus
    databases, GitHub, etc. RECON: does pi-agent-core support MCP natively? If yes,
    mostly config (declare servers); else ad-coder implements an MCP client +
    adapters. Untrusted: an MCP tool RESULT is data, never instructions; a server is
    a trust decision.
  - **LSP seam** — per-language code intelligence (typescript-language-server,
    pyright, gopls...) as role tools: precise go-to-def / find-references / type
    diagnostics / SAFE rename-extract refactors. Precise navigation beats grep
    (accuracy + context-economy); safe-by-construction refactors are exactly what
    the auditor + refactor-executor want (LSP/AST moves over LLM regeneration). LSP
    is editor-land, likely not in pi -> ad-coder implements an LSP client + adapters.
  - LAUNCH MODEL (both seams, decided): ad-coder does NOT bundle servers. A server is
    an external EXECUTABLE the user installs the normal way (npm/pip/go/rustup or a
    binary); ad-coder is a CLIENT that SPAWNS it as a subprocess and speaks its
    protocol (LSP: JSON-RPC over stdio; MCP: its transport). The per-language / per-
    server LAUNCH COMMAND is a setting (config-contract) with an efficient default:
    auto-discover the common one (LSP: prefer the project's own node_modules/.bin /
    venv over a global, so the server version matches the language version; then
    PATH), overridable in config. Enabling a server is a trust decision. They run on
    the host now, under the sandbox once it lands.
    COMPOSES FREE with what is built: default-open tools (a connected server's tools
    are auto-available unless narrowed), tool-call observability (the ledger already
    records toolCalls by name -> you SEE which MCP/LSP tools a role used), and the
    future sandbox+wallet (servers run under the sandbox; the wallet holds their
    creds; network-default-open covers a browser, hardened runs opt into limits).
    Both are also candidate capabilities ad-coder gives its OWN roles, not only
    tools used to develop ad-coder.
  - GUIDED SETUP (remove the install friction): the user should rarely type
    `npm i -D ...` by hand. The ORCHESTRATOR detects the project's stack and PROPOSES
    the useful servers (a TS project -> typescript-language-server; a web app ->
    Playwright MCP; Python -> pyright); on consent it runs the install (a
    package-manager command via bash) and REGISTERS the server in config — then
    auto-discovery finds it. The TUI settings mirror this: known-useful tools per
    detected stack as checkboxes (enable/disable) + an install button, the same
    "enabled servers" config underneath. Manual install stays the fallback. Installing
    is a TRUST decision (network + writes), so the orchestrator PROPOSES, never installs
    silently; later the install runs under the sandbox+wallet.

- **Web tools (fetch + search)** — pi ships NONE (built-ins are only
  bash/read/write/edit/error; `web_search` in pi-ai is Anthropic's server-side tool,
  provider-only/not portable). ad-coder provides its own on the tool-source model:
  **web-fetch** is a trivial built-in (HTTP GET via defineTool); **web-search** needs a
  backend, best via the MCP seam (Brave/Tavily/fetch MCP) or a small adapter over a
  configurable search provider (key = a setting). Needed by the researcher role +
  bootstrap prior-art research + guided tool setup.
- **Orientation notes as a cache; web research as the cache-miss that refills it** —
  reduce user burden and stop the orchestrator flailing. TWO layers (the project's own
  cache thesis applied to knowledge): (1) a committed project NOTES/orientation doc the
  orchestrator reads FIRST — cheap, project-specific ("where X lives, the tool we
  chose, a gotcha"); (2) web research (researcher role) as the CACHE-MISS path —
  current, graded "fresh AND time-tested" by the researcher's confidence. KEY: research
  REFILLS the notes — a durable finding is written back so next time it is a cheap
  note-read, not a re-paid search. Net: give the orchestrator bash (install) + web
  tools (research) + notes (orient) and it self-serves tooling setup on consent.
- **Machine-facing interface + top-orchestrator + Telegram bridge** — ad-coder must be
  drivable by a layer ABOVE it (prior art: the operator's
  github.com/aadegtyarev/claude-orchestrator — manage sessions, bridge to Telegram,
  control/observe from a phone). Requirement it imposes NOW: a machine-drivable surface
  (structured CLI I/O `--json` and/or an API/RPC server) plus an EVENT STREAM (step
  done, cost, verdict, need-input) the bridge relays. The remote human over Telegram is
  just ANOTHER DRIVER (or an approver of the orchestrator's proposals) — fits the
  swappable-drivers model and the auto/manual dial. Composes with sessions
  (browse/resume from the phone), the ledger (cost as a notification), consent, and the
  sandbox+wallet. This is the multi-user/remote surface. Enforced by
  docs/contracts/architecture.md (every capability reachable programmatically).

- **Durable Orchestrator control plane (re-decided 2026-09-12)** — the current
  increment is a headless, daemon-free queued run service over ProjectStore.
  `start` atomically records intent and returns; a live in-process scheduler or an
  explicit `resume`/pump advances work. Status/list/resume/cancel survive process
  reconstruction and commands serialize within one root tree. Auto mode is an
  advance mandate to decide from the task and durable project knowledge, with
  structured grounds and scope recorded for every decision; manual mode waits for
  an external operator channel. After `maxRounds: 2`,
  `decomposition_required` starts sequential child pipelines by default. A child
  requesting decomposition stops its sibling series and exposes full details.
  `autoDecomposition` independently enables the mechanism;
  `maxDecompositionDepth` defaults to 1 and 0 means unlimited;
  `maxChildPipelines` defaults to 8 and 0 means unlimited. Provider subscription/
  key availability and session budgets pause resumably rather than becoming review
  failures. A daemon/event stream remains a possible later multi-project feature,
  not a dependency of this control plane.

- **Provider admission + Session manager + Telegram driver (decided 2026-09-14)** —
  before a Telegram transport, introduce the headless, provider/account-scoped
  `ProviderAdmissionController` defined by `docs/contracts/provider-admission.md`.
  It admits every LLM generation request through finite configurable permits and
  a fair priority queue: interactive turns first, background work next, title
  generation last. It is not a physical provider connection pool. A structured
  provider-limit/429 response closes one shared cooldown gate using bounded
  retry hints so queued work does not stampede the provider. Its queue, cooldown,
  cancellation and recovery projection are durable for durable runs. The
  SessionManager owns the controller instance in managed operation, so every
  session sharing provider/account capacity competes fairly; the controller stays
  reusable by direct headless callers and does not depend on Telegram. The
  SessionManager then adds a small private local service over the existing
  `ProjectStore`, Orchestrator API, background-run control plane, and durable
  event cursor. It listens only on an owner-private Unix socket; console and
  Telegram are clients, never independent live-session owners. It owns safe
  durable bindings:
  `driverKey -> projectKey`, plus one project record
  `projectKey -> (targetDir, shared sessionId, profile)`. A project therefore
  has one shared durable Orchestrator conversation by default; Telegram, console,
  and later a group topic are views of that same conversation, not separate
  conversations. A front changes only its selected project. Switching a project's
  profile affects future work in that one shared conversation; existing paused
  runs never change provider/model identity implicitly.
  Project keys are immediate child directories of configured allowed roots;
  absolute paths, traversal, and escaping symlinks are rejected. It may create a
  new, non-existing safe-slug project beneath an allowed root, initialize Git,
  and create only the minimal ignored runtime scaffold. Shipped 0.146.0
  (issue #365, layer 2): the headless core and the owner-private Unix-socket
  transport, under `docs/contracts/session-manager.md`; the console-discovery
  and Telegram driver layers remain future slices over the same programmatic
  API.

  `ad-coder console` launched from a project directory first discovers the
  private Manager socket and resolves that directory's project binding. If the
  project's shared session exists, it shows its attachment, active turn and runs
  and offers to attach; if absent, it offers to create the project session. This
  makes the current-directory flow the normal path, not a separate command to
  remember. Direct process-owned console remains an explicit `--standalone`
  fallback when Manager is unavailable or deliberately disabled. A legacy live
  standalone session is detected through its durable lease and is never opened or
  stolen by Manager/Telegram. It appears as `standalone:<local>` in session lists;
  either front may request a handoff, but the standalone console accepts it with
  `:handoff accept` after its active turn settles. Then it persists/releases its
  session and Manager adopts the same durable session ID. New consoles always use
  Manager when it is available, so this compatibility handoff disappears from
  normal operation.

  Telegram v1 is an optional local long-polling driver in the same ad-coder
  process, calling this headless API directly rather than spawning/parsing a CLI.
  It has a credential-store/environment bot token, an explicit chat allowlist,
  and secret-free private bindings outside target projects. A personal chat is a
  switchable project dashboard; later a `(groupChatId, topicId)` binding becomes
  one fixed project room. `ad-coder console` initially lists open project
  sessions, their attached interface and active run/turn, then offers attach to
  one, attach to all selected sessions, or create a project. Telegram exposes
  the same `sessions` list. `attach <session>` moves interactive ownership from
  either interface to the requesting interface; it is not a process exit. A
  submitted active turn is never cancelled by transfer: the target is marked
  pending, both fronts see progress, and transfer completes when that turn
  settles. `detach <session>` releases the attached interface while runs and the
  durable conversation continue under the manager. Separate conversations are an
  explicit future opt-in, never the default. Before creating one, Manager lists
  every session and active run sharing its `targetDir` and recommends attaching
  to the default session. The safe alternate is a second read-only research
  session. A second write-capable session against the same Git worktree requires
  an explicit `shared-worktree` mode and a second confirmation naming the affected
  sessions/runs; it warns that stale context and overlapping edits can overwrite
  work. Manager serializes its own turns and exposes the conflict, but does not
  claim that serialization makes concurrent worktree writers safe. A separate
  Git worktree is the recommended route for independent mutable work.

  Every managed session has a stable ID, a short display name, and a name source
  (`generated` or `manual`). A new session starts as `New session`; after its
  first user message settles, a bounded title-only LLM call generates a concise
  name from that message asynchronously, without delaying the answer. Title
  generation model/effort/limit are configurable and default to the cheapest
  viable configured route. The result is length-limited, secret-screened and
  treated as untrusted display data; failure leaves the neutral fallback. A
  manual name is never replaced. `sessions` lists name plus short ID/project/
  attachment/run state; `/session rename <session> <name>` and
  `:session rename <session> <name>` set a bounded safe manual name. Their
  no-argument forms show command-specific syntax and examples.

  Attaching does not replay private raw transcripts into Telegram. It presents a
  safe catch-up card (project, profile, active turn, run statuses, cost and last
  activity) and offers paginated structured run history/status/result commands.
  An explicit `summary` command may ask the shared Orchestrator to describe the
  current work, making that new summary a normal durable turn. The driver relays
  durable background events from its acknowledged cursor and resumes safely after
  its own restart. It supports ordinary messages to the selected Orchestrator
  session plus project, profile, session attach/detach, run/status/resume/cancel
  commands. The same command schema backs bot slash commands and console colon
  commands, so both fronts provide the same project-management and run controls.
  No webhook, public listener, SessionManager-wide plugin registry, or multi-user
  policy is required for v1.

- **Empirical forecast + credit wallet v1 (decided 2026-09-14)** — `profile estimate`
  reads accepted secret-free calibration samples for one requested complexity and
  returns transparent optimistic/median/adverse reported-cost ranges and an
  explicit sample-count confidence. An optional
  explicit credits-per-USD conversion and the latest append-only provider-scoped
  `credit_balance` observation yield a budget status; unknown balance remains
  unknown, never guessed. Credit balances are shared by provider across model
  observations because the account capacity is shared. This v1 does not query a
  provider automatically, reserve credits, or claim cross-process allocation.
  The later SessionManager-owned wallet will add durable reservations for active
  runs and use ProviderAdmission to allocate fairly across all sessions.

- **Just-in-time orchestration skills v1 (decided 2026-09-14)** — implement the
  enforceable `docs/contracts/skills.md`: built-in and project-local trusted
  skills share a bounded manifest/instruction resolver; project skills live in
  `.ad-coder/skills/<id>/`. Shipped 0.34.0: every pipeline-capable command's
  shared `--skills` flag pins explicitly, the default set is the per-role
  catalogue loaded with `load_skill`, and `--no-skills` plus the profile's
  `capabilities.skills` turn the capability off; the resolver exposes
  version/source/digest and `config show` reports the resolved set.
  Resume-stable pipeline snapshots remain v2 work. First skills are architecture
  reconnaissance, task slicing, independent acceptance review, delivery
  calibration, and repository navigation. They replace
  permanent prompt bulk with role-scoped lazy instructions, never silent global
  injection.

  Every Telegram command with no required argument returns command-specific
  help including syntax and an example; it never infers or executes a default
  mutation. The same command schema supplies parser validation and help so they
  cannot drift.

- **Plugin registry (decided 2026-09-12)** — build on the existing `defineTool`,
  workflow and driver seams. A small manifest declares an entry module and the
  capabilities it provides (`tools`, `workflows`, `drivers`, event subscribers).
  Support local paths and ordinary npm packages with `add`, `enable`, `disable`,
  `list` and `doctor`; enabled plugin code is trusted operator configuration, like
  project workflows and prompt overrides. MCP is a general tool-source plugin;
  Telegram is a driver over SessionManager; avoid a separate package ecosystem or
  plugin-specific session implementation.

## Open backlog (mechanical)

See the repository's GitHub issues, indexed by docs/BACKLOG.md. Notably:
ContextBudgetError should surface the effective ceiling
min(maxTokens, contextWindow) (minor); UsageDeltaTracker Map growth; ledger
JSONL retention policy.
### Control-plane notification contract

TUI, chat, and remote adapters consume the same durable event cursor. They may present runs in the
background without owning pipeline state; reconnecting from the last acknowledged sequence must
recover every terminal or operator-attention event. A separate always-on daemon remains optional.
