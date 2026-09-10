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

Verified from the code: modules are disjoint (one type-only cross-import,
`preflight → role`), and the only shared seam is the barrel (`src/index.ts`,
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

## Next (planned / in flight)

Two independent modules, safe to build in parallel per the principle above:

### Capability matrix — `src/capabilities/`
Derive a ModelCapabilities descriptor from a pi-ai Model: cost mode
(per-token / prepaid / local, from whether cost fields are zero), whether
`cacheRetention` actually does anything on this model
(`cacheControlFormat === "anthropic"`), context window, cache read/write unit
costs, out/in ratio. Two pure metrics: `cacheEfficiency = cacheRead /
(cacheRead + input)`; `breakEvenReads = cacheWrite / (input - cacheRead)`. A
role/model reconciliation that WARNS when a role's cacheRetention is inert on
its model (the matrix must refuse/warn, never stay silent). Later empirical
layer reconciles declared-vs-observed from the first live response (noted, out
of scope for the first cut).

### Quality gates — `src/gates/`
A QualityGate declared as config { name, kind: format|lint|typecheck|size,
command (argv), autofix? }. A runner that executes gates on produced files —
autofix-first (deterministic, free), then check, fail-loud with structured
results fed back as the next turn's input. Size gate is in-process
(maxLinesPerFile). Language/provider-agnostic via config (gofmt vs prettier vs
tsc). Deterministic gates run BEFORE spending an LLM review round — free tokens
before expensive ones. ad-coder itself currently has only typecheck+test and
needs this (dogfooding).

## After that (designed, ordered)

- **Profiles** — on top of the matrix. A profile is intent → matrix → model:
  `{ tier, maxOutput, cacheRetention }` per role, named intent (`cheap`/`max`)
  not a hard id, so it ports across providers. Ledger's per-lane attribution
  lets one workflow run under two profiles and compare two JSONL files. Profiles
  come AFTER the matrix because they make decisions the matrix must justify.
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

## Open backlog (mechanical)

See docs/BACKLOG.md. Notably: ContextBudgetError should surface the effective
ceiling min(maxTokens, contextWindow) (minor); UsageDeltaTracker Map growth;
ledger JSONL retention policy.
