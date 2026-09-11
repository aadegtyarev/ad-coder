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
- **Prompts as files** — roles reference prompts by name from files, not only
  inline strings. Both prompts already exist (Role.systemPrompt verbatim; the task
  prompt via runRole) — the gap is storage. Resolve at the boundary (name → file →
  verbatim string → Role) keeping Role.systemPrompt a resolved string (protects the
  verbatim/cacheable property). Search path: built-in prompts (shipped) < project
  prompts (.ad-coder/prompts/ in targetDir), project overrides by name. System
  prompt = raw file read (byte-preserving, no templating — it is the cache prefix);
  task prompt = templatable via pi's loadPromptTemplates. Fail loud on an
  unresolvable name. Fits "small prompts + built-in and custom roles". Small.

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
- **Session persistence** — a policy on the runner's existing seam
  (`session = params.session ?? MemorySessionRepo`). Swap to JsonlSessionRepo
  under <targetDir>/.ad-coder/sessions/ for durable, inspectable, forkable
  sessions; session identity = runId (= ledger key), so session + ledger +
  checkpoint = one addressable unit. Durable reload from disk IS possible (unlike
  LDO's in-process resume cache). The session is where compaction's effect lives.
  Small extension of the runner seam.

- **In-project scratch (working files + attachments)** — a gitignored working-files
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
- **Multi-user + pluggable backlog** — multi-user is the SAME conflict-avoidance
  as project memory (per-file records) + worktree isolation, under more writers;
  the ledger gains an actor/user dimension. Backlog becomes a pluggable
  BacklogStore seam (like the ledger sink): file-backed (default, offline, solo)
  and issues-backed (opt-in, multi-user, via `gh` — dodges the merge conflict a
  shared BACKLOG.md has with many writers). The auditor emits candidates to
  whichever is configured; also answers "where do dev notes go". Depends on:
  memory.
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

- **Conversational orchestrator** — the top interface layer and the critical path
  to a usable MVP: a chat that shapes the task, then drives the pipeline
  (stepped or autonomous). The one genuinely NEW primitive it needs is a multi-turn
  CONVERSATION LOOP — the runner drives a single turn; the orchestrator holds
  context across many. Everything else is composition of what exists: an
  orchestrator ROLE (prompt already at prompts/orchestrator.md) with its own TOOLS
  (run_pipeline, show_cost/ledger, spawn) via the tools-seam, profile-switchable
  like any role. After the role + triage land, a CLI dialog already works; the TUI
  is a skin on top. The orchestrator prompt carries JUDGMENT only; mechanics
  (resume tracking, model routing, git staging) stay in the harness/config — gates
  over prompts.
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
- **Publisher role** — ad-coder's /ldo-ship equivalent: tidy the work, create a
  branch, run the gates/tests as a HARD pre-publish check (a gate, not a prompt),
  open a PR, squash-merge. Its job is git/gh operations, so it needs PRIVILEGED
  tools via the tools-seam + ideally the credential broker (git push / gh pr run on
  the host with creds, the agent sees results not secrets). Can be a pipeline phase
  after an approved verdict or a standalone tool the orchestrator invokes. This
  session bootstrapped the first publish by hand; the Publisher automates it.

- **Configurable compaction (modes + disable + percent-of-window budget)** —
  context management is the project's centerpiece, so its strategy is a first-class
  knob, not a hardcode (enforced by docs/contracts/config.md). Modes: (a) `auto` —
  summarize when the budget is exceeded (today's behavior); (b) `cache-aware` —
  compact in LARGE, INFREQUENT steps so the new `[system + tools + summary]` prefix
  stays stable across many following turns (editing the message-head invalidates
  the whole tail's cache, so the win is amortizing that to once-per-big-step and
  keeping the summary itself a re-cacheable stable prefix; the verbatim system
  prompt and tool defs are never touched); (c) `disabled -> halt` — never summarize
  silently, STOP and require an explicit manual clear/compact command
  (gates-over-prompts applied to context, for users who want no automatic edits to
  history). Also express the budget as a PERCENT of the model contextWindow
  (resolved to absolute tokens against the model) so one budget is portable across
  a 200k and a 32k model, keeping reserveTokens (room for the reply) as its own
  knob. Default to the most efficient mode. Recon first: verify pi's request
  assembly order (system -> tools -> messages) so the cache boundary is placed right.
- **TUI — the human surface to everything, built for convenience** (Phase 3, after
  the orchestrator). Not a showcase: it EXPOSES the machinery already built,
  clearly and reachably. Chat with the orchestrator (images paste in later, fed to
  a vision model via .ad-coder/scratch/). EVERY setting is reachable and clear in
  the TUI, not just configurable in code — model routing/profiles, compaction mode
  incl. disable->halt, percent-of-window budgets, providers, per-role tools; never
  buried. STATISTICS — the ledger made visible: live and historical cost per
  role/step/round/session, cache efficiency, break-even (the cost thesis is only
  real if the user can SEE it). SESSION LIST — browse, inspect, resume, fork.
  LIVE context/cache panel — usage vs budget, when compaction fired, hit ratio.
  Built on pi-tui. The bar is CONVENIENT, not merely functional.

## Open backlog (mechanical)

See docs/BACKLOG.md. Notably: ContextBudgetError should surface the effective
ceiling min(maxTokens, contextWindow) (minor); UsageDeltaTracker Map growth;
ledger JSONL retention policy.
