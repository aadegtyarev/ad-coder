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
  follow-on on the same pattern is `submit_plan` / `rate_complexity` (a planner
  emitting STRUCTURED complexity), see Profiles + complexity-aware model routing.
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

- **Profiles + complexity-aware model routing** — on top of the matrix. A profile
  is intent → matrix → model: `{ tier, maxOutput, cacheRetention }` per role,
  named intent (`cheap`/`max`) not a hard id, so it ports across providers. But a
  profile should be a FUNCTION OF COMPLEXITY, not a flat per-role table — route
  cheap models to simple features and strong models to complex ones, like LDO
  (a weak Coder on a complex feature buys extra review rounds, and a round is a
  full Coder+Reviewer pass, so the strong model is cheaper spent upfront where the
  work is). PREREQUISITE: the planner must emit STRUCTURED complexity
  (trivial/medium/complex), which it currently does not — it only produces text.
  Mirror the verdict: a `submit_plan` / `rate_complexity` tool carrying the
  complexity — the IMMEDIATE next follow-on on the same pattern the
  `submit_verdict` tool-call verdict (done) established. Then the pipeline
  reads complexity and picks coder/reviewer models per `(complexity × role)`.
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

## Open backlog (mechanical)

See docs/BACKLOG.md. Notably: ContextBudgetError should surface the effective
ceiling min(maxTokens, contextWindow) (minor); UsageDeltaTracker Map growth;
ledger JSONL retention policy.
