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

### Documentation ownership (implemented 2026-09-12)

The repository uses the durable handoff structure: README is orientation and
navigation; this roadmap owns decisions, delivery status, and forward design;
`ARCHITECTURE.md` is the concise current-system map; `BACKLOG.md` holds only
the current priority and unresolved work; `contracts/` holds enforceable rules;
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
  refuse a turn). Pi compaction stays disabled.
- **Compaction activation** — DONE. `auto` is the resolved default and uses the
  cheap-tier model through a one-shot no-tool summarizer; `disabled-then-halt`
  performs a full-branch refusal without summarization. `cache-aware` remains a
  fail-loud reserved mode until request assembly is verified. Pi compaction
  remains disabled because ad-coder owns the policy.
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
- A workflow runs in two modes: **autonomous** (`runPipeline` to completion, today)
  or **stepped** (run ONE step, hand control back). Stepped is the missing
  substrate — `runPipeline` is all-or-nothing today.
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
- **Path to MVP (reordered):** (1) stepped workflow substrate → (2) human-driven
  stepped CLI + standalone role runs ("plan, read, code, look, rework/review") →
  (3) the orchestrator as an autonomous driver on the SAME substrate → (4) TUI.
  Human-in-the-loop before autonomy: nearer, safer, and mostly composition of
  runRole + a thin stepped driver + a CLI. The orchestrator stops being a blocker
  for a usable MVP.
- **REQUIREMENT — composable isolation + plan-reuse.** Worktree isolation and
  plan-reuse MUST be COMPOSABLE, not mutually exclusive: a plan reviewed in one pass
  must be implementable in an isolated worktree in the next. ad-coder must NOT
  inherit LDO's resumePlan-XOR-isolate limitation (there, resuming a saved plan and
  running isolated are alternatives you pick between). Concretely: the reviewed
  plan artifact and the worktree target are independent inputs to a run, and the
  stepped engine (which threads an explicit `WorkflowState`) is the substrate that
  makes this natural — a plan produced by one driver/target is a value another can
  resume against a different target.
- **REQUIREMENT — breakpoint control.** A driver must be able to AUTO-ADVANCE
  through phases and PAUSE before any chosen phase (a breakpoint), then RESUME from
  any point. The `createOrchestrator` stepping seam already makes this reachable
  (`stepOnce` runs exactly one role turn and hands control back with the offered
  transitions; `chooseTransition` commits one); the missing piece is a **run-until-phase
  driver** — an auto-driver that walks the default edges like `autoDriver` but halts
  before a named target phase and returns control, so a caller/UI can set a
  breakpoint without hand-stepping every phase. Named as an explicit follow-on the
  stepping tools expose.

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
  `malformed_verdict` — both hard `OrchestrationError`s. The IMMEDIATE next
  follow-on on the same pattern was `submit_plan` (a planner emitting STRUCTURED
  complexity), now DONE (see below); its CONSUMER, complexity-aware model routing,
  remains open — see Profiles + complexity-aware model routing.
- **`submit_plan` structured complexity** — DONE. The optional planner can now
  emit STRUCTURED complexity (`trivial`/`medium`/`complex`) plus a summary by
  CALLING a `submit_plan` tool built per planner turn (via the `runRole` tools
  seam), mirroring `submit_verdict`. `parsePlan` is the authoritative strict
  validator (schema permissive at the `complexity` leaf). CRUCIAL soft/hard split:
  unlike the verdict, an ABSENT call is NOT an error — it leaves
  `PipelineResult.complexity` undefined and the run proceeds (there is NO
  `missing_plan`); only a MALFORMED call is a hard `malformed_plan`. This unit
  makes complexity AVAILABLE on `result.complexity` but deliberately does NOT wire
  it into model selection — that is the Profiles + complexity-aware routing
  follow-on below, which CONSUMES this signal.
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
  with no configured researcher role skips quietly. Depends on: the researcher role
  with web tools (tools-seam DONE; web tools + network-default-open both decided).
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

- **Profiles + complexity-aware model routing** — DONE (src/profiles/ + runPipeline routing). On top of the matrix. A profile
  is intent → matrix → model: `{ tier, maxOutput, cacheRetention }` per role,
  named intent (`cheap`/`max`) not a hard id, so it ports across providers. But a
  profile should be a FUNCTION OF COMPLEXITY, not a flat per-role table — route
  cheap models to simple features and strong models to complex ones, like LDO
  (a weak Coder on a complex feature buys extra review rounds, and a round is a
  full Coder+Reviewer pass, so the strong model is cheaper spent upfront where the
  work is). PREREQUISITE (now MET): the planner emits STRUCTURED complexity
  (trivial/medium/complex) via the `submit_plan` tool — DONE, surfaced on
  `result.complexity`. What remains OPEN here is the CONSUMER: this feature must
  read `result.complexity` and pick coder/reviewer models per `(complexity ×
  role)`. The signal exists; nothing selects models from it yet.
  ad-coder EDGE: the ledger already measures per-role/round cost, so routing can
  later be LEARNED from observation ("cheap coder averaged 2.3 rounds on medium
  features, strong 1.1 — which is cheaper end to end?") rather than only declared —
  static table to start, ledger data to refine. Ledger's per-lane attribution
  also lets one workflow run under two profiles and compare two JSONL files.
  Profiles come AFTER the matrix because they make decisions the matrix must
  justify.
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
  by `parseVerdict` — the filesystem-artifact first-cut is retired. **Next
  follow-on** on the same pattern: `submit_plan` / `rate_complexity`, a planner
  emitting structured complexity for complexity-aware model routing. Bootstrap caveat: a bug in the runner/orchestration corrupts
  its own development, so early self-hosting stays partial (narrow modules via
  ad-coder, risky core via LDO or human) and supervised; faux tests + human remain
  ground truth for the core.

- **Conversational orchestrator** — CORE DELIVERED (2026-09-11, `src/orchestration/orchestrator.ts`).
  The headless core + thin tool-front cut of the top interface layer: a chat that
  shapes the task, then drives the pipeline (stepped or autonomous). The one
  genuinely NEW primitive it needed — a multi-turn CONVERSATION LOOP — landed
  earlier as `startConversation`; this cut composes it. `createOrchestrator(deps)`
  is the headless core (the THIRD driver of the stepped engine, reachable WITHOUT
  the chat front): `runPipeline`/`beginStepping`/`stepOnce`/`chooseTransition`/
  `showCost`/`isStepping`, with the untrusted model-supplied transition KIND
  validated against the engine-authored offered set via `assertTransitionOffered`
  before `applyTransition` (the requirement the stepped-engine review surfaced).
  `buildOrchestratorTools(core)` is the four `defineTool` tools (run_pipeline,
  run_step, choose_transition, show_cost) via the tools-seam, profile-switchable
  like any role; `startOrchestrator(config)` assembles the conversational front over
  `resolvePipelineConfig` + `resolvePrompt('orchestrator')` + `startConversation`,
  sharing ONE ledger sink. The orchestrator prompt carries JUDGMENT only; mechanics
  (resume tracking, model routing, git staging) stay in the harness/config — gates
  over prompts. The transition guard (`DriveError`/`DriveErrorCode`/`assertTransitionOffered`)
  relocated DOWN to `src/orchestration/transition-guard.ts` so the headless core can
  depend on the guard without the CLI front; both drivers share one implementation,
  re-exported byte-for-byte from `src/cli/drive.ts`. FOLLOW-ONS (not built here):
  a `drive`-style CLI subcommand fronting `startOrchestrator`; the spawn/fork tools
  (spawn_subagent / fork, below); researcher/publisher tools (each brings its own
  credential/URL/egress surface — flag it when it lands); and the run-until-phase
  BREAKPOINT driver (below), which the `beginStepping`/`stepOnce`/`chooseTransition`
  seam already exposes.
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

- **Plugin registry (decided 2026-09-12)** — build on the existing `defineTool`,
  workflow and driver seams. A small manifest declares an entry module and the
  capabilities it provides (`tools`, `workflows`, `drivers`, event subscribers).
  Support local paths and ordinary npm packages with `add`, `enable`, `disable`,
  `list` and `doctor`; enabled plugin code is trusted operator configuration, like
  project workflows and prompt overrides. MCP is a general tool-source plugin;
  Telegram is a driver plugin over SessionManager and the daemon. Avoid a separate
  package ecosystem or plugin-specific session implementation.

## Open backlog (mechanical)

See docs/BACKLOG.md. Notably: ContextBudgetError should surface the effective
ceiling min(maxTokens, contextWindow) (minor); UsageDeltaTracker Map growth;
ledger JSONL retention policy.
### Control-plane notification contract

TUI, chat, and remote adapters consume the same durable event cursor. They may present runs in the
background without owning pipeline state; reconnecting from the last acknowledged sequence must
recover every terminal or operator-attention event. A separate always-on daemon remains optional.
