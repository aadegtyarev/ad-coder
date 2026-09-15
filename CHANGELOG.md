# Changelog

All notable changes to ad-coder are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims at
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.13.0] - 2026-09-16

### Changed
- The `recorder` profile role is gone. It was reserved while a recorder role was
  planned; nothing ever dispatched one, no prompt defined one, and `ROLE_NAMES`
  never listed one -- but the cell was quietly read for something real: it chose
  the compaction summarizer model. It is now named `summarizer`, which is what
  it does. A profile still naming `recorder` is rejected as `unknown_role`, like
  any other unknown role. **Breaking:** rename the role in any saved profile or
  inventory.
- `--summarizer-model` now overrides the `summarizer` profile cell the way every
  other `--<role>-model` flag overrides its own, instead of being resolved
  beside that path. Two consequences: the startup banner reports the model
  compaction will actually use rather than the cell the flag replaced, and an
  unregistered name raises `ProfileError('unknown_model')` like every other
  role rather than a bare `RegistryError`.

### Added
- `config show` reports `summarizerModel` and where it came from. Compaction
  rewrites the entire history, so which model performs it is a routing decision
  worth checking before a run; until now the only way to learn it was to read
  the profile and reimplement the override precedence by hand.

### Fixed
- CLI tests no longer read the developer's own saved profile. They spawn the
  real binary, which inherited `XDG_CONFIG_HOME`, so a profile the CLI rejects
  failed a test about something else entirely -- on one machine and not in CI.
  Each run now gets an empty config home unless the test chooses its own.

## [0.12.3] - 2026-09-16

### Added
- Calibration corpus coverage for the four roles that had none: planner,
  security, auditor and researcher. Each task ships a fixture or prompt with a
  planted false positive -- a validated id that only looks like path traversal,
  an authorization door that is genuinely closed, an invented HTTP header -- so
  a model that pattern-matches instead of reading scores worse than one that
  reads.
- Every corpus task must now declare where its shape came from: a link, a
  licence, and what was taken. Required of all tasks rather than only new ones,
  because a grandfather list rots and an absent field soon reads the same as an
  oversight. `docs/model-calibration.md` records the licence of each source the
  corpus draws on and the rule it follows: adapt forms, never copy content.
- `corpus.ts smoke` now exercises artifact- and report-scored tasks too, against
  checked-in pass/fail sample answers, and `bun test` runs it. Those scorers
  were previously unexercised until a live calibration run hours later, so a
  scorer stuck at `true` -- the failure that silently reports every model as
  perfect -- had no way to be caught early.

### Fixed
- A standalone role no longer receives two contradictory instructions. Role
  prompts are written for the pipeline, where a `submit_*` tool owns the result;
  the Planner's prompt forbids the plan in assistant text for exactly that
  reason. Standalone strips those tools, so the role was told both to withhold
  the result and to return it, and obeyed whichever it weighed higher. The
  override now names the rule it displaces.

## [0.12.2] - 2026-09-15

### Fixed
- Compaction no longer writes a prompt cache nobody can read. The summarizer
  request took pi-ai's default `cacheRetention` of `"short"`, so every
  compaction paid the cache-WRITE premium on the largest input a run produces --
  a transcript that is replaced by its own summary the moment the call returns,
  leaving the entry with no possible reader. On Anthropic that premium is 25%
  over the plain input price. The request now asks for `"none"`; role turns,
  whose prefix genuinely repeats, keep their configured retention.

## [0.12.1] - 2026-09-15

### Added
- `docs/pi-capabilities.md` records a research note on cross-model context handoff, verified by reading the installed
  pi-ai 0.85.1 adapter sources rather than its documentation. Handoff is already implemented inside those adapters:
  on a model mismatch they drop redacted thinking, downgrade ordinary thinking to text, strip tool-call thought
  signatures, renormalise tool-call ids for the target API, and backfill orphaned tool calls with synthetic error
  results. It fires on a model switch WITHIN one provider too, not only across providers -- so ad-coder need not
  reinvent signature and thinking splicing at the model boundary. What remains ours: compaction when moving to a
  smaller context window, pipeline resume not checking the model a stage previously ran on, and the fact that this
  degradation is invisible in the ledger and on stderr.

## [0.12.0] - 2026-09-15

### Added
- `bun run calibration:corpus -- run <task-id>` executes one corpus task for
  real: it materializes the fixture, invokes ad-coder in the task's declared mode
  (`role`, `drive --auto`, or a scripted `console --json` session), reads the
  ledger the front reports, scores it and emits the measurement. Until now the
  corpus could only list, validate and smoke-test its scorers -- it never ran the
  agent it was supposed to be measuring.
- Every front that runs model turns now names its run on stderr before the first
  turn: `ad-coder: runId=<id> ledger=<path>`. An operator (and the bench) can
  point at a run's evidence without guessing how the file was named.

### Changed
- `drive`, `console` and detached pipeline workers write the durable ledger file
  again. Each front needs a readable sink to report its own cost, and installing
  one used to REPLACE the file sink -- so whole multi-role sessions left nothing
  under `.ad-coder/ledger` while `ad-coder role` did. The readable sink now
  mirrors to that file instead of displacing it, and takes its in-memory copy
  first so a failing mirror cannot also cost the caller the numbers it reads back.
- A calibration measurement attributes cost per `(role, model)` pair instead of
  crediting the whole run to whoever took the first turn. `model` names the model
  that ran the roles the task measures; the new `models[]` lists every pair,
  costliest first. A task whose dispatch `role` is not itself a ledger role --
  every `automatic-pipeline` task dispatches as `pipeline`, while its rows carry
  `coder`/`reviewer` -- declares `measuredRoles`, and the corpus runner refuses to
  load one that does not. Without it those runs reported `model: null` silently,
  which is the one mode multi-role attribution exists for.
- The orchestrator complexity votes are read from the run instead of being passed
  in: `calibration:score` no longer takes the two complexity positionals, and the
  orchestrator scorer derives them from an observed report. It additionally
  requires the classification to PRECEDE any delegating tool call, and requires a
  ledger row stepped `role:planner` to credit the planner cross-check -- console
  JSON carries tool names without arguments, so nothing else can prove which role
  was delegated.

## [0.11.0] - 2026-09-15

### Added
- `orchestrator` is a routing role: it has its own `(role, complexity)` cell in
  every profile, so an operator can name its model per complexity and a
  calibration run can attribute its cost separately from the work it delegates.
  A default profile now emits 24 cells (8 roles x 3 complexities) and routes the
  orchestrator to the review tier -- it reads results and picks the next move
  rather than producing the work.

### Changed
- The orchestrator no longer falls back to the coder's profile cell when
  `--orchestrator-model` is absent. Borrowing that cell meant a profile could not
  route the orchestrator at all, and every measurement of it was really a
  measurement of the coder. An explicit `--orchestrator-model` now also reaches
  the override layer like every other role flag. A profile authored before the
  cell existed keeps working: a missing orchestrator cell falls back to the
  coder route it used to take and prints one stderr notice, so committed
  inventories are not invalidated by the new role. The fallback covers that one
  role only -- a missing cell for any other role still fails as before.

## [0.10.7] - 2026-09-15

### Fixed
- The startup banner reported three collapsed tiers instead of the routing the
  run will actually use. With an inventory, `strong`/`mid`/`cheap` all fall back
  to the same default model, so the line read `provider "custom" | strong "x" mid
  "x" cheap "x"` for a profile routing seven roles across four models -- true of
  nothing. It now names the routing source (the inventory by name, or the
  provider), the default complexity, and every role grouped by the model it
  resolves to at that complexity. The role list is walked from the profile
  layer's own exported vocabulary, so a role added there cannot go unreported.

## [0.10.6] - 2026-09-15

### Fixed
- The opencode-go examples in `README.md` and `docs/provider-catalogs.md` were
  copy-pasteable into an HTTP 400 `MissingSessionID`: the account rejects every
  request without an `x-opencode-session` header, and neither the shipped catalog
  nor pi-ai's own opencode provider supplies one. Both examples now name the
  header to declare by hand and link the issue that will make the provider carry
  it (#120).

## [0.10.5] - 2026-09-15

### Added
- `/cost` and `/cost release <provider>/<model>` in the console: list the models
  this project has blocked for billing above their declared price, and accept a
  model's new price without leaving the session. The console reaches the SAME
  detector the run refuses on -- it is handed the session's own object, not a
  second copy over the same file -- so a release lifts the block that is actually
  standing.

### Fixed
- A price block mid-turn no longer renders as the generic "console turn failed;
  retry the prompt". The console now has a typed `CostAnomalyBlockedError` branch
  naming the declared amount, the billed amount, the overcharge, how many
  responses confirmed it, and the `/cost release` that accepts it; the prompt
  comes back so the operator can type it. The old text advised a retry that could
  only fail again.
- `ad-coder cost release ...` failed with `targetDir must be a non-empty path`
  when run without `--target-dir`. It now defaults to the current directory, the
  same as `console`, so the refusal's own advice is followable.

### Changed
- Two contract lines: a front must branch on EVERY typed error its surface can
  raise (`docs/contracts/errors.md`), and every front offers the same
  capabilities, differing only in rendering, with the decision in shared headless
  code (`docs/contracts/cli.md`).

## [0.10.4] - 2026-09-15

### Added
- `/start <task>` starts a background pipeline run straight from the console.
  The rest of the line is taken verbatim as the task, the run is detached so it
  outlives the turn that asked for it, and no model turn is consumed -- the
  operator keeps the dialogue while the run proceeds. The command is declared in
  the console registry, so `/help` renders it and the "enable it with
  `--workflows pipeline`" guidance applies without a second declaration.

### Fixed
- The console now builds a background host launcher and a stable owner id of its
  own. Without them `start_pipeline` and `/start` could admit a run but never
  start one: only `ad-coder background start` wired a launcher, so every
  console-initiated run failed `launch_failed`.
- The default background owner id no longer embeds the target directory. The
  manager requires a bounded opaque token, which a path breaks on its first
  slash, so every `ad-coder background` command run without `--owner-id` failed
  `invalid_request` before it could reach a record. The directory is hashed
  instead, which also keeps a filesystem path out of durable state, and one
  user + one target still resolve to the same scope across processes.
- Console controls now render in the order they were typed. `/start` is the
  first control that awaits a host launcher, and an unserialized control lane
  rendered a later `/list` before the `/start` whose run it was meant to list.
  Shutdown waits for in-flight controls only up to `controlDrainMs`, so a host
  launcher that never spawns -- or a provider that ignores a `/interrupt`
  cancellation -- cannot hold `/exit` or Ctrl-C open, leave the session unclosed
  or strand the terminal in raw mode. An abandoned control is reported as
  `deadline_exceeded` rather than passing for a clean exit.
- `launch_failed` and `resource_limit` from the background run manager now
  surface as typed, retryable console failures naming the next action, instead
  of collapsing into an opaque `invalid_request`.

### Changed
- `background` and `console` share one declaration of the background run
  options (`--owner-id`, `--background-max-active`, `--same-target-policy`)
  rather than repeating them, which is exactly the drift the single command
  registry exists to prevent.
- A console command whose argument is a whole sentence declares `argMode:
  "verbatim"` in the registry, so parsing selects on a declared property the way
  dispatch already selects on `frontAction`, instead of matching `/start` by
  name.

## [0.10.3] - 2026-09-15

### Fixed
- The orchestrated session now owns ONE tool-activity channel and shares it with
  every delegated `run_role` worker and every pipeline stage. A conversation that
  is handed no channel builds a private one, so nested work published where
  nobody could subscribe: a console watching the session saw only the
  orchestrator's own tool calls and went silent for as long as a delegated role
  ran. `subscribeToolActivity` on the returned session now reads that shared
  channel. Existing bounds are unchanged -- per-subscriber pending capacity
  still caps each consumer's queue and over-capacity events are counted as
  drops -- and a channel supplied by the caller is neither closed nor
  double-subscribed by the session.

## [0.10.2] - 2026-09-15

### Changed
- Unresolved work moved out of `docs/BACKLOG.md` and into nine grouped GitHub
  epic issues (#100-#108), so more than one person can pick items up without
  colliding and so discussion sits next to the item instead of in a commit that
  rewrote a shared file. `docs/BACKLOG.md` is now an index of those epics; its
  prose history remains in git. `AGENTS.md`, `README.md`, `docs/ARCHITECTURE.md`
  and `docs/ROADMAP.md` now point unresolved work at an issue rather than at the
  file. No behavior changes.

## [0.10.1] - 2026-09-15

### Added
- Three operator-reported backlog items recorded, none implemented: report what
  a turn spent inside the turn rather than only against session limits; give the
  Orchestrator a bounded read-only view of its own spend history, so that asking
  what a run cost stops meaning shelling out to parse the ledger; and colour the
  console, which currently renders activity, turn boundaries and errors in one
  undifferentiated stream. A fourth records that the console has no command to
  report which provider and models the running session resolved to. A fifth
  records that one orchestration test
  pins a performance property by comparing wall-clock times, so it fails at
  random under full-suite load on an unchanged tree.

## [0.10.0] - 2026-09-15

### Fixed
- Cost-anomaly detection compared the configuration against itself and could
  never have worked. `usage.cost` is not a provider fact: pi-ai computes it by
  multiplying the settled token counts by the prices in the operator's own
  registry config. The detector read that as "provider-reported cost", so both
  sides of every comparison came from the same price table and a genuine
  provider reprice was mathematically invisible to it -- while the contract
  promised detection on the price actually charged.
- The detector now asks the provider for what it billed and compares that to
  what the configured price list predicts for the same response. OpenRouter
  reports the amount, on the streaming path runs actually use, when the request
  carries `usage: {include: true}`; under a caller's own upstream key it
  reports `is_byok`, zeroes that field and carries the real amount separately.
  Both are read, and never summed -- on a normal response they are the same
  charge printed twice, so adding them would report a 2x overcharge on correct
  billing.
- False blocks are gone, and they were not a tuning problem. The old observable
  was dollars per token, which varies by orders of magnitude at a completely
  constant price: within one price list an output token costs multiples of an
  input token and an input token multiples of a cache read. Measured on this
  project's own dogfood runs, one model's legitimate baseline spread was 8.3x
  against a 2.0x block threshold, and the run it blocked was billed at 1.0000,
  1.0000 and 1.0171 times its configured price -- correct billing, blocked. The
  ratio of charged to expected has composition in both halves, so it cancels.

- A response too large to scan no longer keeps its own body alive. The billed
  amount is read off a teed branch of the response, and a teed branch that is
  abandoned while the source still has bytes keeps buffering every one of them,
  so giving up on an oversized body by releasing the reader retained exactly
  the body the size guard existed to avoid retaining. The branch is now
  cancelled; the caller still receives every byte, because a teed source is
  only released once both branches let go.
- Upgrading past a 0.9.0 project no longer faults on its own saved state. The
  persisted scope shape changed with the reference, but the schema tag stayed
  1, so a file written by the previous release was read as though it were
  current: the first observation faulted on a missing field, and a scope that
  release had already blocked faulted at the Models boundary every generation
  passes through -- not a refusal, which is typed and actionable, but a crash.
  The tag is now 2 and a version-1 file is discarded like any other shape this
  release cannot read. Nothing needs rebuilding: the reference is declared, not
  learned, so the only loss is recent history.

### Changed
- The reference is the DECLARED price, not a learned baseline, and no traffic
  can move it. A learned baseline cannot tell a discount ending from a price
  rising: a backend billing under the declared price teaches the baseline that
  the discount is normal, so the ordinary price returning reads as a spike and
  blocks a session paying exactly what was agreed. It also absorbs a reprice
  that arrives in small steps, one acceptable-looking step at a time. Only an
  explicit `cost release` moves the reference, by recording the confirmed ratio
  as that scope's accepted ceiling.
- There is no warm-up and no `insufficient_evidence` state. With nothing to
  accumulate, the first settled response is already checkable, so a reprice
  already in effect before a project's first run is caught rather than silently
  learned as normal. `minBaselineSamples` and `baselineWindow` are gone with
  it; the default threshold is now 1.25, affordable because a correctly billed
  response sits at 1.00 whatever its token mix.
- A scope whose provider reports no billed amount now reports `no_charge_data`
  and never blocks, instead of manufacturing a verdict out of the very price
  list it is meant to be checking. Measured: OpenCode Zen returns token counts
  and no amount at all, and ignores `usage: {include: true}`. Asking for the
  amount is limited to providers known to report one, so an unknown field
  cannot turn every request to a strict provider into a 400.
- A block now names the dollars charged and the dollars expected across the
  confirming responses, rather than two per-token rates, so the operator can
  check them against a provider invoice directly.


## [0.9.0] - 2026-09-15

### Added
- Cost-anomaly detection: a per-`(provider, model)` price-step detector that
  refuses to START new runs on a scope whose observed cost-per-token has
  stepped up, until the operator explicitly releases it. On by default,
  disableable, and every threshold configurable.
- The baseline is the MEDIAN of a recent window, not the mean. A mean is
  dragged toward any outlier inside the window -- including the leading edge of
  the very repricing being detected -- so a real step can push the baseline far
  enough to mask itself. A measured case: with a baseline window carrying one
  large reading, the mean puts a genuine 3x step at ratio 0.14 and stays
  silent, while the median reports it at 3.0.
- A suspected spike is held in a separate `pending` list and never folded into
  the baseline it is measured against; otherwise the alarm would teach itself
  to stop ringing. A single reading never blocks -- a confirming count is
  required, and any return to normal discards the pending evidence, so
  unrelated artifacts hours apart cannot accumulate into a false alarm.
- The refusal is a START-only refusal, applied at the single `Models` boundary
  in the runner, OUTSIDE the session and stage limit controllers. Work already
  in flight is never killed, because that money is already committed, and a
  refused start does not consume one of the session's counted turns.
- A block names only scope, ratio and both rates, plus the release command --
  no prompts, payloads or credentials, in the error message or in persisted
  state.
- The detector is constructed for every run resolved through the CLI and
  threaded to the runner, so "on by default" is a property of the shipped
  pipeline rather than of a class nobody builds.
- Scope state is durable per project (`.ad-coder/cost-anomaly.json`), written
  whole through a temp file and renamed. A block raised by an unattended run is
  therefore still standing at the next start, and an accepted price stays
  accepted. A corrupt or unreadable file costs a baseline and re-learns it,
  rather than reading as a false all-clear that unblocks every scope.
- `ad-coder cost status` lists what is blocked and `ad-coder cost release
  <provider>/<model>` accepts a model's new price -- the command the refusal
  itself names, so its advice can actually be followed. Releasing a scope that
  is not blocked is reported rather than treated as success, so a mistyped
  scope cannot read as "released" while the real block stays up.

### Fixed
- A refusal no longer outlives the run it refused. The typed error stashed for
  replay past the harness boundary was never cleared, so one blocked scope
  reported its block for the next run on a DIFFERENT model, and kept reporting
  it after the operator released it -- wedging every model in the session shut.
  It is now cleared on entry to every admission and consumed when replayed.
## [0.8.4] - 2026-09-15

### Fixed

- The planner text fallback now reads the shapes planners actually emit, and a
  rejected submission is retried instead of being fatal on the first try. Three
  consecutive real runs died in the plan stage after the planner HAD produced a
  complete surface analysis: `parsePlanText` accepted only a bare `{...}`
  object, so a ```json fence, a `submit_plan arguments: {...}` prefix and a
  response truncated mid-field all returned `undefined` -- indistinguishable
  from a planner that said nothing. The caller consumed the attempt without
  recording a failure and finally reported `missing_plan`, "planner did not
  submit required surface analysis", which sent the operator looking for a stage
  that never ran instead of at the handoff that was refused.

  The fallback now extracts the first balanced object (string- and
  escape-aware), unwraps a fenced block, and splits its outcome three ways:
  a plan, `undefined` only for genuine silence, and `malformed_plan` whenever
  plan-shaped content was present but unusable -- including truncation, which
  now says so by name rather than passing as silence. The retry loop gives a
  rejected submission the same attempt budget a missing one already had (it used
  to break on the first rejection, punishing a near-miss harder than a total
  miss), tells the next turn which failure to correct, and reports the rejection
  itself once the budget is spent. `missing_plan` is now raised only when no
  attempt ever produced plan-shaped content. The retry text and the thrown
  message are fixed structure plus the validator's own wording; planner text
  never crosses the error boundary.

  Recovery does not get to guess. Every top-level object in the response is
  collected, and every candidate is parsed rather than just the first that
  validates: a planner that drafts a plan and then corrects itself emits two,
  and the real submission is the last -- so returning the first accepted a
  draft whose `securitySurface: "none"` overrode the correction's `"elevated"`
  and skipped the mandatory security phase with no error and no retry. Scanning
  only as far as the first balanced object made that protection depend on the
  shape of the response instead of its content: two fenced plans were caught,
  but a bare draft followed by a correction produced a single candidate and was
  returned silently -- the same bypass, still open for the commonest shape. Two
  DIFFERENT valid plans are now a rejection telling the planner to submit
  exactly one, which the retry budget can still fix; the same plan reaching the
  parser twice (a bare object and its own fenced copy) is one submission and
  still resolves. When every candidate fails, the one carrying `complexity` is
  reported rather than a nested `coverage` fragment the brace scan happened to
  lift out -- that fragment fails on whichever field it lacks first, and naming
  it sent the operator after a field the planner never got wrong.

- The planner instruction no longer forbids a shape the parser accepts. It
  demanded "no Markdown or prose", asking models to suppress the fenced form
  they emit by default; it now states that a complete object -- alone or inside
  one ```json fence -- is read, and that a cut-off object cannot be.

## [0.8.3] - 2026-09-15

### Added

- `config show` now reports the context window each role will ACTUALLY use, per
  role, with the source of that number and the budget derived from it
  (`contextWindow.<role>`, `contextBudgetMaxTokens.<role>`). The effective
  window was the one routing decision the command did not project: the number
  existed -- every role derives its budget from `model.contextWindow` -- but
  nothing surfaced it, so a config declaring `1000000` ran at `200000` with no
  way to see it. A window the resolver settled on its own now names what it was
  settled from: a catalog value clamped to the shared operating ceiling reads
  `catalog-clamped from 1000000`, not a bare `200000`.
- `ResolvedModelConfig` carries `contextWindowSource`
  (`declared` | `catalog` | `catalog-clamped` | `built-in-default`) and, when
  the clamp discarded something, `catalogContextWindow`. Provenance only -- a
  name and two integers.
- The provenance survives being validated twice, which is what every real
  `config show` does: the CLI validates the registry at its entry points and
  the config resolver validates again. Provenance was derived from whether a
  `contextWindow` was present, and after one pass it always is -- the pass
  itself wrote it -- so the second pass concluded an operator had declared
  every catalog window and dropped the clamped-from number. The projection was
  correct only when called as a library and wrong for the operators it was
  built for. Validation now carries an already-settled provenance through
  rather than re-deriving it, and refuses a source string it does not
  recognise.
- Two registry entries sharing one provider-native id but settling on
  different windows are now reported with the number and no source label,
  which is what the collision rule always promised. The comparison looked only
  at the source label, so two hand-declared entries -- both `declared`, both
  without a catalog number -- were judged identical and whichever was
  registered first answered for the other: a confident, specific, arbitrary
  attribution. The resolved window is now part of the comparison.
## [0.8.1] - 2026-09-15

### Changed

- Recorded four measured provider-admission and usage-accounting defects in the
  backlog. A provider whose API mandates a non-auth request header cannot be
  admitted at all, because `ProviderConfig` has no place to declare one;
  measured against OpenCode Zen, which rejects every completion without
  `x-opencode-session` and surfaces through ad-coder only as an empty turn with
  a zero-usage ledger record. `auth login` can persist an api key for exactly
  one hardcoded provider id. A per-role model override silently resets the
  selected inventory's provider destination. A provider that reports reasoning
  tokens outside its output count aborts an already-completed, already-paid-for
  role run over an accounting convention. The last of these now cites a
  durable evidence record in `docs/calibration-evidence.jsonl` rather than
  figures that lived only in a scratch ledger. Documentation only; no
  behavior change.
## [0.7.0] - 2026-09-15

### Fixed

- A provider that REFUSED a request is no longer reported as a missing
  credential. A settled failure with empty assistant text and zero usage has two
  very different causes and the transcript cannot tell them apart, so the runner
  called every one of them `empty_turn` and told the operator to "verify
  authentication and retry". A provider 400 over a malformed tool schema --
  rejected before the model ever ran, at zero cost -- therefore pointed at the
  one party that was not at fault, and the durable checkpoint recorded only
  "inspect the provider failure", naming neither the status nor the request.
  `runRole` and the conversation loop now read the settled failure's HTTP status
  and raise the new `ProviderRejectionError` for a client-error status,
  `RunCoordinator` pauses with `provider_rejected` and the status in its action,
  and the console offers the request -- model id, tool schemas, parameters --
  instead of an authentication command. 401 and 403 stay `empty_turn`, which is
  what those statuses actually mean; 429 is still `provider_limit`.
- The status is read from BOTH shapes pi-ai composes, not just one. Adapters
  that route through `formatProviderError` produce `"<status>: <body>"`, but
  `anthropic-messages` never calls it -- it assigns the provider SDK's own
  `APIError.message`, which is `"<status> <body>"` with a space and no colon.
  Matching only the first shape would have left every Anthropic-native model,
  and every OpenRouter model that overrides to `anthropic-messages`, still
  being told to verify authentication over a request the provider had refused
  on its merits -- the exact misattribution above, unfixed for one of the three
  request APIs this registry resolves. The second shape is anchored at the
  start and bounded to three digits followed by a space, so it reads a leading
  status and not a number appearing in prose.

### Added

- `ProviderRejectionError` and `providerRejectionStatusFrom` are exported.
  The error carries the run id and the numeric status ONLY: the response body
  that produced the status is read for the number and dropped, because an
  uncontrolled provider body must never cross an error boundary.
## [0.6.4] - 2026-09-15

### Added

- `docs/contracts/cost-anomaly.md`: an enforceable rule for what happens when a
  model suddenly starts costing more than it did. The failure it names is a step
  change in the unit price actually charged -- a provider repricing, a preset
  rerouting to a costlier backend, a cache that stopped being hit -- observed
  only after an unattended session has already paid it many times. Per-stage
  `maxCostUsd` does not catch it: every run stays under its own ceiling while
  every run costs several times yesterday's rate.

  Detection is on provider-reported cost per token for one `(provider, model)`
  scope, against a durable baseline of that same scope, confirmed by more than
  one settled observation, because providers report incomplete usage and a
  single anomalous reading is an artifact until it repeats. A first observation
  establishes a baseline and can never itself be a spike; too thin a baseline
  reports insufficient evidence rather than a verdict.

  On a confirmed spike new runs in the affected scope are REFUSED with a typed
  error naming the scope, the baseline, the observed rate, the ratio and the
  release action; work already in flight is not killed, since the money for the
  running stage is already committed and aborting it saves nothing. Release is
  an explicit, durable, per-scope operator act that re-baselines the scope, so a
  permanent reprice is accepted once rather than re-alarming forever. Enabled by
  default and configurable throughout. Implementation is tracked in
  `docs/BACKLOG.md`; no behavior ships in this release.
## [0.6.3] - 2026-09-15

### Fixed

- Two mandatory tool schemas no longer make a provider reject the whole
  request. `submit_plan` declared `surfaceAnalysis` as `Type.Any()`, which
  serialises to a bare `{}`, and `submit_follow_up` was a `Type.Union` of its
  four kinds, which serialises to a top-level `anyOf` rather than an object.
  Providers that validate tool schemas refuse both: DeepSeek answers
  400 "one of `type`, `anyOf`, `$ref` field is required" for the first and
  "schema must be a JSON Schema of `type: \"object\"`" for the second. Because
  `submit_follow_up` rides along on every workflow turn, a run against such a
  provider paused at the plan stage on an empty turn, having spent zero tokens
  and reporting only "inspect the provider failure" -- pointing the operator at
  the provider for a defect in this repository's own schemas. `surfaceAnalysis`
  is now spelled out structurally and the follow-up schema is one object with
  the per-kind fields optional. Neither change loosens a gate: the enum leaves
  stay plain strings exactly as `complexity` and `securitySurface` already did,
  and `parsePlan` and `validateFollowUpCandidate` remain the authoritative
  validators -- an unknown kind, or one kind carrying another kind's field, is
  still refused.
- An incomplete `submit_plan` or `submit_verdict` is now named instead of being
  reported as a submission that never happened. The harness validates tool
  arguments against the declared schema *before* `execute` runs, and a nested
  field that is not optional is listed in that schema's `required`. So a
  submission missing one leaf -- a coverage entry without `contractIds`, an
  issue without `what` -- was refused by the harness before the parser saw it:
  nothing was captured, the retry prompt told the role it had not called the
  tool when it had, and the run ended as `missing_plan` / `missing_verdict`.
  That is an invalid input reported as an absent one, which
  `docs/contracts/errors.md` forbids, and on the reviewer's side it also
  suppressed `parseVerdict`'s corrective message naming the exact contract IDs
  to resubmit -- the role's only route to a correct second attempt. Every
  nested field in both schemas is now optional, so each node still declares the
  `type` a validating provider demands while `parsePlan` and `parseVerdict`
  remain the single content gate. `submit_verdict` carried this defect before
  the schema work in this release; `submit_plan` acquired it with the fix
  above.

## [0.6.1] - 2026-09-15

### Fixed

- A profile's `cacheRetention` now reaches the request. It was parsed,
  validated, and carried as far as `ResolvedSelection`, where it was dropped:
  all three role-construction sites hardcoded `"short"` -- the two in
  `resolve-config` and, separately, the conversational role built by
  `startOrchestrator`, which read every neighbouring field off the resolved spec
  but restated this one as a literal. A declared `"long"` or `"none"` was
  silently inert, so the config said one thing while every request did another.
  On an Anthropic-shaped model that is the difference between a 5-minute and a
  1-hour cache TTL. A role whose profile states nothing still gets `"short"`.
  `maxOutput` remains advisory with no sink and is now documented as the only
  such field.

### Changed

- Every model ad-coder routes to now shares one 200000-token operating ceiling.
  A catalog-backed model previously inherited the provider's published window
  verbatim, which for several shipped models is 1000000 or more, so a run's real
  context ceiling depended on which model a routing cell happened to select, and
  a summarizer with a smaller window failed `assertSummarizerWindow` against the
  largest reachable model. The INHERITED window is now clamped to the same
  `DEFAULT_CONTEXT_WINDOW` a hand-declared model already received. An explicit
  `contextWindow` still wins verbatim, including one above the ceiling: the
  clamp is a default, not a cap. A window below the ceiling is left alone, since
  raising it would claim capacity the endpoint does not have. Shipped presets
  are aligned to the same number, except `deepseek-chat`, whose real window is
  64000 and which keeps it for that reason.

## [0.6.0] - 2026-09-15

### Added

- A registry provider can declare static request headers, so an API that
  mandates a non-auth header is reachable at all. Previously no such provider
  could be admitted: `ProviderConfig` had no header field, and while pi-ai
  accepts provider headers it never transmits them — both stream adapters read
  `model.headers` — so declared headers are flattened onto every model. Measured
  against a provider that rejects an unmarked request: without the header the
  role returned an empty turn with a zero-usage ledger record and no error at
  all; with it, all five models answered across both request APIs.
- A header value may contain `{{session}}`, expanded by the resolver to one
  opaque random identifier per resolved registry — the same value for every
  model of a run, a new value for the next — for APIs that demand a
  per-conversation routing marker a static config file cannot hold. Unknown
  placeholders are rejected rather than sent literally, where they would fail as
  an opaque provider routing error instead of a config error.
- A model can override the provider `baseUrl`, for one account fronting two
  request APIs under different path prefixes; each adapter appends its own
  suffix to the base URL it is handed.
- A provider can name a shipped model catalog (`"catalog": "openrouter"`, 31
  catalogs from 2 to 366 models) and take model ids, per-token costs, context
  windows, token ceilings, base URLs, request APIs and supported thinking
  levels from the pinned pi-ai data instead of restating them. Hand-written
  economics go stale silently and corrupt every routing and budget decision
  computed from them; building this surfaced four wrong values in our own draft
  inventory, including a price 2x over and a model assigned the wrong request
  API. Declared fields still win, `models` becomes an optional filter, and
  omitting it admits the whole catalog.
- Catalog-supplied thinking-level maps now reach the provider request, so a
  supported level is sent under the spelling that model expects rather than
  pi's. The map also names the levels a model does NOT support, which is a
  calibration input and not a repair: depending on the request format an
  unsupported level is forwarded verbatim, silently dropped, or replaced from a
  fixed table. Every `opencode-go` and OpenRouter model we route rejects at
  least one level we were using, and the same DeepSeek model accepts `low` on
  one provider and not the other — unknowable from a hand-written model list.
  Note that a level is in one of three states, not two: mapped, explicitly
  marked unsupported, or absent from the map entirely. The last two behave
  identically at dispatch, so only a mapped level is one to route at.

### Fixed

- The `reviewer-hidden-regression-v1` scorer matched finding codes against an
  exact string list, so it graded spelling rather than review quality: the task
  prompt asks for "concise stable defect codes" and names no vocabulary, and six
  models produced four spellings of the same path-traversal defect. Three
  reviews that found every seeded defect with executed evidence and correctly
  refused the tempting false positive scored 0.2. Codes are now reduced to word
  tokens and matched on a PAIR of words naming the specific defect, so a vague
  finding still fails and a non-blocking one still does not count. A finding
  that omits `blocking` but carries `severity: "blocker"` is read as blocking:
  an explicit `blocking: false` still wins, so a deliberate non-blocking finding
  is never credited.

### Security

- Declared headers are not a credential channel. The validator rejects any name
  that would carry or displace authentication (`authorization`, `x-api-key`,
  `cookie`, `cf-aig-authorization`, ...) or that the HTTP client owns
  (`user-agent`, `content-type`, ...), along with malformed field names, values
  outside printable ASCII (a newline would splice an extra header into the
  request), and duplicate names differing only by case. Failures name the
  header and never echo its value. Per-model `baseUrl` is https-only, as the
  provider field already was.
- A catalog provider must always resolve to a destination it named. Previously a
  provider that named a catalog, declared no `baseUrl`, and marked every one of
  its models `"catalog": false` produced `baseUrl: undefined` on the resolved pi
  model — and both vendor SDKs read an absent base URL as "use my own default
  host", so the declared credential would have been transmitted to the SDK
  vendor's endpoint rather than the operator's provider. That config is now an
  `invalid_config` rejection, and the provider's reported fallback takes the
  first model that actually has a base URL instead of whichever model is first.
- A model id the named catalog does not publish is rejected rather than
  resolved with whatever economics sit next to it, so a typo cannot silently
  become a priced model. An account-scoped id (an OpenRouter `@preset/...`,
  which no static catalog can know) requires an explicit `"catalog": false`
  marker, keeping the hand-written exception deliberate. An `api` override that
  contradicts the catalog is refused instead of producing an unroutable model,
  and catalog entries on request APIs the resolver cannot construct are never
  admitted. Operator-declared `compat` remains inert, unvalidated data; only the
  catalog's own compat — from the pinned dependency, not config text — is
  forwarded.

## [0.5.1] - 2026-09-14

### Fixed

- A stage that enters a final-response reserve no longer strips the tool schema
  in silence. The provider request that follows now carries the same instruction
  the tool rejection does — stop using tools and return the final response, with
  the reserve that tripped and its numbers — so a model that suddenly has no
  tools is told why. Without it, models answered the missing schema by emitting
  their own tool-call syntax as prose, and the role returned that garbage as its
  final answer. Observed on two unrelated model families across three runs and on
  two different reserves (`model_turns`, `input`).

## [0.5.0] - 2026-09-14

### Fixed

- `ad-coder update` no longer reports a global GitHub install as changed without
  verifying it. It now reads the installed revision before and after `bun add`,
  reports the real `previousRevision`, and derives `changed` from the comparison
  instead of hardcoding both. A stale pin in the global lockfile makes
  `bun add --global --force` reinstall the previous revision and still exit zero;
  that outcome now fails with the typed `install_mismatch` code naming the
  lockfile to repair, and `install_unverifiable` when no installed revision can
  be read at all.
- `UpdateError` now carries `retryable` and a next action, and `ad-coder update`
  projects both — as a structured record under `--json` and as recovery text on
  stderr otherwise — instead of emitting a bare message.

- Every `ad-coder update` failure now projects a recovery action, not only the
  two new verification codes: `not_checkout`, `dirty_checkout`, `detached_head`,
  `missing_upstream`, `invalid_revision`, and `command_failed` each name the next
  step, and a runner that cannot spawn is translated into a typed
  `command_failed` that keeps its causal error for programmatic callers.
- A usage error under `ad-coder update --json` or `ad-coder console --json` now
  emits the structured `usage` record instead of prose followed by the whole
  root help text, which corrupted stderr for a caller parsing it as JSON.

### Added

- Exported `readInstalledRevision` and the `UpdateErrorOptions` type from the
  library entry point, and an injectable `readInstalledRevision` hook on
  `UpdateOptions` so an install can be verified without a real Bun installation.
- Exported `projectCliError` and `renderCliError` from the CLI module so the
  machine and human failure shapes are reachable and testable without spawning
  a process.
- Widened two existing public types compatibly: `UpdateOptions.onStep` gained
  the `"verify"` step, and `UpdateErrorCode` gained `install_mismatch` and
  `install_unverifiable`. A consumer that annotates either narrowly by hand
  needs its annotation widened; runtime behavior for existing callers is
  unchanged.

## [0.4.0] - 2026-09-14

### Added

- `/help` console command listing every console command with its usage,
  description, and an example, and naming `--workflows pipeline` for the
  commands the session did not enable.
- Exported the console command registry (`CONSOLE_COMMANDS`,
  `consoleCommandUsage`, `consoleCommandNames`, `findConsoleCommand`) and the
  typed `ConsoleControlFailure` projection from the library entry point.
- `/help` now explains each command argument individually in both the formatted
  and JSON projections, rather than only naming it in the usage line.

### Changed

- Console command dispatch, argument validation, failure guidance, and help now
  render from one command registry instead of a hand-maintained usage string.
  `/exit` is dispatched through its registry entry rather than a literal name.
- Every console failure, including interruption, session limits, empty provider
  turns, turn failures, oversized input, unreadable input, and a failed session
  close, now reports the same typed projection with a recovery action and
  retryability instead of a bare code. Oversized input, unreadable input, and a
  failed close previously had no machine-mode record at all.
- Console failures now report a stable `code` with the failed command, concise
  text naming the failure, a `retryable` flag, and one recovery action in both
  the formatted and `console_error` JSON projections.

### Fixed

- Replaced the identical, unhelpful guidance every failed console command
  printed, which listed neither `/help` nor `/exit` and never explained why the
  command failed.
- Sanitized terminal control sequences out of the machine-mode `console_error`
  record; `JSON.stringify` leaves C1 controls intact, so untrusted command text
  could reach a terminal reading JSON output.
- Preserved the originating manager error as `cause` on `ConsoleControlError`
  for programmatic callers while still projecting only safe fields.

## [0.3.4] - 2026-09-14

### Fixed

- Reject empty OpenRouter API-key input and report login success only after the
  private credential store confirms that the key was retained.

## [0.3.3] - 2026-09-14

### Fixed

- Added the exact selected-provider authentication command to interactive
  console recovery after an empty failed provider turn.

## [0.3.2] - 2026-09-14

### Changed

- Made `openrouter-presets` the required default inventory profile for ad-coder
  dogfood and development unless the operator explicitly selects another.

## [0.3.1] - 2026-09-14

### Fixed

- Restored visible TTY input, newline echo, and destructive Backspace handling
  in the raw interactive console.

## [0.3.0] - 2026-09-14

### Fixed

- Fixed `ad-coder update` for global Bun GitHub installs by resolving and
  installing the exact `main` revision instead of trusting a stale Git lock.

- Reconciled role tool allow-lists with disabled plugin groups, preserved typed
  pre-provider tool-configuration failures, and made project reconnaissance
  parameters and failures unambiguous and actionable while retaining Planner's
  documented focused-read fallback.

### Added

- Added a single auto-loaded user runtime inventory at
  `~/.config/ad-coder/inventories.json`; first use seeds an editable OpenAI
  profile while preserving explicit per-run provider and model overrides.

- Added persistent OpenRouter API-key login, status, and logout through the
  private credential store, with hidden terminal input and environment fallback.
- Added `ad-coder update` for clean linked Git checkouts, with fail-closed branch
  and upstream validation, fast-forward-only pull, frozen install, and link refresh.

- Added explicitly selected, role-scoped Skills v1 with bounded secure
  built-in/project resolution, content digests, actionable typed failures,
  four orchestration skills, and console/library selection.

- Added responsive console-local controls plus configurable console page sizing and Escape-sequence timeout handling.

- Added `Escape`/`/interrupt` turn-only console interruption and local commands
  to list, inspect, read, and cancel detached pipeline runs without invoking the
  orchestrator model.

- Added detached background pipeline execution with owner-scoped polling,
  bounded cursor events, terminal results, cancellation, lease-based recovery,
  and JSON CLI access while the foreground conversation remains available.
- Added bounded, content-free owner-scoped background subscriptions with
  reconnect polling recovery and console lifecycle/stage/terminal stderr NDJSON
  notices that leave model turns and JSON result stdout untouched.

- Taught Orchestrator to accept complete terminal pipeline evidence and avoid
  duplicate post-pipeline reads and test runs.

- Kept incremental Coder and Reviewer retries focused when a change adds
  untracked files; their bounded paths remain available for explicit role reads.

- Added explicit model-inventory Researcher brief composition, trusted replacement-source configuration, and digest-only durable stage metadata.
- Added versioned portable user profiles with append-only economics history and
  always-JSON `profile show|export|import-preview|import-apply` CLI access.
- Added append-only server-reported `credit_balance` observations and atomic
  `profile record` input, so a future credit refill and balance delta can be
  measured without exporting account identity or raw provider responses.
- Added bounded `.ad-coder/calibration.json` snapshots, `profile snapshot`, and
  automatic project-calibrated routing for matching named inventories.
- Added typed, configurable closeout reserves for duration, model turns, and
  tool turns so bounded roles retain capacity to return their final result.
- Added an input-token closeout reserve and increased the default model-turn
  reserve from two to four after dogfood showed context-heavy turns and retried
  tool batches exhausting the prior closeout allowance. Final reserved requests
  now expose no tools, preventing another rejected tool loop; input closeout uses
  the preceding request to anticipate context growth.

- Added a headless named model-inventory layer and CLI selection that atomically
  pairs a provider/model registry with its role-by-complexity routing profile.

- Added native Orchestrator `resume_pipeline` support and safe aggregate stage
  usage/run identity in automatic pipeline results.
- Added `drive --resume-run` for stage-limit pauses, with actionable checkpoint
  output, unknown-run failure, task-binding protection, and rejection when the
  exhausted host budget was not raised or disabled.
- Added explicit `drive --resume-run <id> --retry-research` recovery for rejected
  Researcher output while preserving the accepted Planner result.
- Added configurable incremental pipeline retry handoffs, deterministic full-context
  fallback reasons, and durable per-stage handoff-strategy observability.
- Added `search_project`, a configurable ranked and byte-bounded task
  reconnaissance projection for all native pipeline roles.
- Added `read_project`, a configurable multi-file line-slice projection with
  one aggregate byte ceiling for every native pipeline role.
- Added a zero-disabled per-stage limit controller for duration, model turns,
  tool turns, input tokens, and provider-reported cost.
- Wired finite stage-budget defaults through the runner, durable coordinator,
  effective configuration, and CLI, with explicit resume of the incomplete stage.
- Added a bounded headless semantic tool-activity lifecycle stream, optional
  subscriptions, compact console grouping, and schema-v1 NDJSON progress on
  stderr with visible backpressure and subscriber drops.
- Added safe per-stage provider/model, thinking, duration, reasoning-token, cost,
  and context-strategy metrics to pipeline results and durable reports.
- Added per-stage UTF-8 byte measurements for the effective system prompt,
  stage handoff prompt, tool definitions, and their request-assembly total.

### Changed

- Standalone roles now checkpoint their run and can resume the same durable
  session and ledger with `role --resume-run` after a stage-limit pause or crash.
- CLI runs from inside `targetDir` now disable environment credentials so Bun's
  startup dotenv loading cannot import provider keys from the target project.
- Context-budget refusals now report their effective ceiling when a runtime model
  window is smaller than the role budget.
- Standalone `role` runs now persist their numeric usage ledger, print a safe
  usage envelope, stream semantic tool activity, and retain selected plugin tools.
- Pipeline `drive` runs now stream the same bounded semantic tool activity for
  every role stage.
- Planner now stops after one sufficient bounded evidence pass for tasks with
  explicit files and acceptance criteria, and ends immediately after submission.
- Coder now skips broad exploration after a concrete Planner handoff, edits
  existing files in place, and bounds repeated verification runs.
- Planner now uses only bounded structural, search, and batched-read project
  tools, removing redundant raw shell/read paths from its reconnaissance loop.
- Bounded normal Planner reconnaissance by batching independent reads and
  converting unresolved evidence into a research gate before Coder dispatch.
- Planner now specifies verification commands without executing suites, builds,
  linters, or formatters during normal reconnaissance.
- Security, Researcher, Coder, and Reviewer now use scoped batched search/read
  projections before any individual-file fallback.

### Security

- Hardened `read_project` against path replacement and post-stat file growth by
  using descriptor-relative no-follow traversal and a bounded descriptor read.
- Hardened activity projection against argument, identifier, terminal-control,
  custom-tool-name, and oversized-record disclosure; default web transport now
  pins validated public addresses and revalidates redirects.

### Fixed

- Reviewer verdict instructions now include the exact contract IDs required for
  each planned surface, so valid documentation-only reviews can self-correct.
- Preserved typed stage-limit failures across the model harness boundary and
  made `drive` report actionable stage pauses instead of pending decisions.
- Made `submit_follow_up` advertise discriminated variants and prevented invalid
  optional follow-up metadata from discarding a completed primary role result.

## [0.2.1] - 2026-09-12

### Changed

- Replaced the accreted architecture dump with a readable system map and added
  an enforced human-first documentation contract, configurable readability gate,
  and cold-reader planning/review procedure.
- Tightened the Orchestrator prompt, made its tool policy explicitly default-open
  over all registered tools, and added documentation audit triggers.
- Added plugin-shaped DuckDuckGo search and navigable page reading, content-image
  discovery, and capability-based image inspection with configurable vision-model
  routing for text-only roles.
- Added Git-ignore-aware `explore_project` reconnaissance for every code-reading
  role, isolated `decompose_task`, and Auditor/project-health contracts for
  evidence-based, test-pinned decomposition.
- Made the shipped pipeline an opt-in conversational workflow module selected by
  `--workflows pipeline`; disabled workflows register no tools, while standalone
  `drive` remains an explicit pipeline entry point.
- Exposed gate, exploration, web, media, and model-modality defaults as typed
  configuration instead of hidden behavioral constants.
- Added configurable stderr progress heartbeats and provider-request timeouts for
  long-running model-backed CLI operations.
- Added enforceable product-change, error-behavior, compatibility/release, and
  decomposition methods and made every delivery role apply their boundaries.
- Extended CI through a packed-artifact installation smoke.
- Added pipeline-independent `run_role` delegation so the Orchestrator can call
  every shipped specialist directly while workflow modules remain disabled.
- Defined the next-step headless tool-observability contract and recorded its
  compact human and structured machine renderers in the backlog.

## [0.2.0] - 2026-09-12

The working core of the harness. Built on `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` 0.85.1, Bun + TypeScript, provable end to end with no
network (pi-ai's fauxProvider) and demonstrated live on DeepSeek.

### Added

- **Public release discipline** — package version `0.2.0`, enforced SemVer and
  dated-changelog consistency, artifact version verification, public-clone
  installation guidance, and an explicit no-recursive-orchestration guard for
  every built-in role.

- **Durable Orchestrator control-plane foundation** — queued daemon-free starts,
  atomic request-key admission, reconstruction, safe status/list/tool views,
  cooperative cancellation, explicit auto/manual decisions, provider/session-limit
  pauses, scoped child decomposition, reports, breakpoints and reviewed-tree-bound
  publishing. The machine `operations` CLI exposes trusted control actions.
  Pipeline results now distinguish `approved` from `decomposition_required`
  while retaining the compatible `approved` boolean.

- **Project operations Increment 6** — configurable headless repository
  publishing with JSON preflight/start/finish operations, isolated explicit-path
  commits, local/CI/manual gates, exact-head approval, GitHub and local squash
  flows, dirty-work preservation, and base-movement recovery.

- **Project operations Increment 5** — migration-free LDO layout detection,
  non-destructive digest/provenance imports with explicit execution trust,
  durable inspection/resume, and detect/preview/import/inspect/resume JSON CLI
  actions. Enabled importer limits reject unsafe or oversized source artifacts
  before persistence; zero keeps each numeric limit disabled.

- **Project operations Increment 4** — a durable non-model RunCoordinator,
  structured per-turn FollowUps, operator decisions, accepted-contract re-review,
  idempotent closeout, and resume parity across all workflow drivers.

- **Project operations Increment 3** — strict, provenance-preserving FollowUps;
  proposal-only documentation routing; and one configured BacklogStore authority
  with file or opt-in GitHub issue persistence, lifecycle/lease claims, a
  read-only capability probe, and one-time migration advice. GitHub payloads use
  stdin and persist only a structural metadata projection.

- **Trusted target role prompts and contract-aware roles** — pipeline and
  conversational orchestration now activate `.ad-coder/prompts/<role>.md`
  overrides automatically and byte-verbatim. Planner, Coder, and Reviewer roles
  discover, carry, obey, and independently enforce applicable target-project
  contracts without requiring ad-coder's documentation filenames.

- **Session generation limits** — headless conversations and orchestrators accept
  zero-disabled turn and USD thresholds enforced across all Models generation
  paths, including nested workflow roles and built-in compaction. Console flags
  expose the same controller and typed exhaustion stops safely without a fake
  completion record.

- **Minimal human console** — `ad-coder console --target-dir <dir>` keeps one
  `startOrchestrator` session across turns, supports formatted and JSONL output,
  injected streams, `/exit`/EOF cleanup, terminal-control sanitization, and a
  configurable 65,536-byte default input-line limit. Host tools remain
  unrestricted by explicit MVP decision.

- **Activated context compaction** — `auto` now builds a one-shot, no-tool
  summarizer from the resolved cheap-tier model and is propagated through role,
  pipeline, CLI, conversation, and orchestrator paths. `disabled-then-halt`
  rejects a full over-budget branch before provider execution; `cache-aware`
  fails loudly pending implementation. Summaries retain untrusted-history
  provenance, cross-provider disclosure requires explicit opt-in, and repeated
  summarizer failures are circuit-broken.

- **Role** — a validated preset over the harness options (`defineRole(role,
  model)`): a verbatim system prompt, a per-role tool allow-list
  (`activeToolNames`), a `cacheRetention` policy, and a `ContextBudget`. Pi's own
  compaction is disabled so the context strategy stays in ad-coder.
- **Prompts as files** — `resolvePrompt(name, opts?)` resolves a SYSTEM prompt
  by bare name to a verbatim UTF-8 string, so a role can reference `"coder"`
  instead of embedding an inline `fs.readFileSync`. A project prompt at
  `<projectDir>/.ad-coder/prompts/<name>.md` overrides the built-in shipped at
  `prompts/<name>.md`; the file is returned unchanged (no trim, no normalize, no
  templating — it is the cacheable verbatim cache prefix). The name is validated
  against `/^[A-Za-z0-9_-]+$/` BEFORE any path is built (no dots, slashes or
  `..`), and failures are a typed `PromptError` (`invalid_name`/`not_found`)
  carrying only the name and the absolute paths tried — never file contents.
  Task/user-prompt templating is a follow-on.
- **Default-open tool allow-list** — `activeToolNames` is now OPTIONAL: an absent
  field means "every registered tool" (the harness default), a present `[]` is
  still a deny-all, and a present non-empty array is the exact set. Existing
  roles set the field explicitly, so only the previously-invalid absent case
  changes meaning.
- **Ledger** — attributes provider token usage and cost to role / step / run as
  JSONL. `usage` is per-response (not cumulative); cost comes from
  `Usage.cost` and is never recomputed. Records carry identifiers and numbers
  only — never prompts, responses, or headers.
- **Ledger tool-call observability** — each record now carries an optional
  `toolCalls` map (tool name → count) of the tools the model REQUESTED in that
  response, omitted when it requested none. Per-response granularity, names and
  counts only (never arguments or output); execution outcome (`isError`) is a
  documented follow-on via the `after_tool` hook.
- **Context management** — `ContextBudget` on every role validated against a
  caller-supplied `Model` (local / custom endpoints safe); a `ContextCompactor`
  (`transform_context` hook) with ad-coder's own summarization prompt; and an
  `assertTurnFitsBudget` pre-flight.
- **Capability matrix** — `deriveCapabilities(model)` (cost mode, cache
  controllability, context window, unit costs, out/in ratio), plus
  `cacheEfficiency` and `breakEvenReads` metrics.
- **Quality gates** — a data-declared `QualityGate` + a `GateRunner` with an
  injected command executor; format / lint / typecheck / in-process size gates.
- **Runner** — `runRole(params)` drives one turn through pi-agent-core in a
  **required, separate `targetDir`** (harness dir ≠ target dir; credentials only
  from the harness environment, never the target's). Custom tools are injectable
  via `tools?` (`defineTool` / `Tool`).
- **Conversation** — `startConversation(config)` (`src/conversation/`): the
  multi-turn substrate the conversational orchestrator will sit on. It builds ONE
  harness over ONE session, acquires the lane and attaches the compactor ONCE,
  and returns a `ConversationSession` whose `step()` re-drives that same
  `lane.prompt` seam turn after turn — history is retained on the durable Session
  branch tip, never replayed. Each turn gets a fresh per-turn `Ledger` sharing
  the one sink and attaches/unsubscribes its ledger + `tool_end` listeners inside
  a `finally` (so N turns emit exactly N ledger rows, never duplicated), narrows
  the settled record to `{status, assistantText, toolCalls, droppedRecords}`, and
  never closes the shared sink until `close()`. `runRole` stays the single-turn
  primitive; this reuses its seams (`runner.ts`/`pipeline.ts` untouched). The
  compactor is the payoff for long chats.
- **Orchestration** — `runPipeline(config)`: an optional planner → an optional
  Security phase → a coder ⇄ reviewer loop to `maxRounds`. The reviewer submits a
  structured verdict and the planner a structured complexity + security surface
  via tool calls (`submit_verdict`, `submit_plan`); an elevated security surface
  runs a threat-modeling Security phase whose mitigations thread into the coder
  and every reviewer turn. Per-phase cost is visible in the ledger.
- **Stepped workflow engine** — `createWorkflowSession(config)` exposes the
  plan → [security] → code ⇄ review graph as an explicit, inspectable
  `WorkflowState`: `step(state)` runs the ONE pending role turn and returns the
  post-turn state plus the `AvailableTransition[]` on offer WITHOUT committing
  one, and the pure `applyTransition(state, chosen)` yields the next state. A
  driver picks each transition — `advance`, `rework` (re-run the coder without a
  review in between), or `stop`. `runPipeline` is now the autonomous auto-driver
  over this engine (always take the default transition), byte-for-byte its prior
  behavior. Transition policy is a setting, not a constant: `WorkflowDefaults`
  (`onChangesRequested`, `autoAdvance`, plus `maxRounds`/`defaultComplexity`)
  each defaults to today's behavior. This is the substrate a human-stepped UI or
  the conversational orchestrator drives.
- **Provider registry** — `src/registry/`: plain-data provider + model config,
  a strict fail-loud `parseRegistryConfig` validator (https-only absolute base
  URLs, no embedded userinfo), and `resolveRegistry` turning declared data plus
  the harness environment into a pi `Models` collection with a stable-name
  lookup. Credentials resolve through an injectable env accessor by declared var
  NAME; a missing one throws `RegistryError('missing_credential', <NAME>)`. Five
  presets ship: `deepseekPreset`, `openrouterPreset`, `openaiCompatiblePreset`,
  `anthropicCompatiblePreset`, and the OAuth-delegated `openaiCodexPreset`.
- **Profiles** — `src/profiles/`: the composer layer above the registry that
  resolves a `(role, complexity)` cell — or a per-spawn `SpawnOverride` — to a
  registry model NAME and then to a live pi `Model<Api>`, plus an advisory
  `{ maxOutput, cacheRetention }`. A strict fail-loud `parseProfile` validator
  (five `ProfileRole`s including a forward-looking `recorder`, seen-Set duplicate
  detection on the `role:complexity` key), `resolveProfile` (which rethrows a
  registry `unknown_model` as `ProfileError('unknown_model')` so the layer
  presents one typed surface), and a provider-agnostic `buildDefaultProfile`
  builder. The advisory hints have no sink yet and nothing wires this into
  `runPipeline` — both are a deliberate follow-on.
- **Complexity-aware routing** — `runPipeline` now CONSUMES the profile/registry
  layers through an optional `PipelineConfig.routing`
  (`{ profile, registry, defaultComplexity?, overrides? }`): per-role model
  selection is driven by the planner-rated complexity — the planner (and any
  pre-complexity role) routes on `defaultComplexity` (default `'medium'`), and
  every later role on the planner's submitted tier, else that default; a per-role
  override wins over the `(role, complexity)` cell. Routing is optional and
  additive — absent, model selection is byte-for-byte the prior behavior (each
  `RoleSpec.model` over `config.models`).
- **Built-in role prompts** — `prompts/{planner,coder,reviewer,security}.md`.
- **Env-driven config resolution** — `resolvePipelineConfig(options)` builds a
  runnable `PipelineConfig` from the environment: it selects a provider by
  env-var PRESENCE (precedence `DEEPSEEK_API_KEY` → `OPENROUTER_API_KEY` →
  OpenAI-Codex OAuth, overridable with `provider`), builds the matching shipped
  preset's registry through the injected `env` accessor (a keyless env-var
  provider throws `RegistryError('missing_credential', <VAR-NAME>)` naming only
  the variable), routes strong/mid/cheap model NAMES through the default
  profile, and derives the context budget as a PERCENT of the smallest chosen
  model's window (never a hardcoded value) so one budget validates for every
  role. The selected provider and tier model names are echoed to stderr (names
  only, never a key) before the turn runs.
- **`ad-coder role <name> "<task>" --target-dir <dir>` subcommand** — runs a
  single built-in role (`planner`/`coder`/`reviewer`/`security`) standalone
  against a target directory, resolving the provider and models from the
  environment. Prints the role's final assistant text and the per-run cost;
  `--provider`, `--strong-model`/`--mid-model`/`--cheap-model`, `--max-rounds`
  and `--default-complexity` are validated at the argument boundary (bad input
  exits 2 with the usage string). The role runs with real read/write/edit/bash
  tool access rooted at the target directory — the target directory is NOT a
  sandbox (same posture as `run`).
- **`ad-coder drive "<task>" --target-dir <dir> [--auto]` subcommand** — drives
  the stepped workflow engine one phase at a time: it prints each turn's output
  and per-step cost and, at every step, reads which offered transition to take
  (`advance`/`rework`/`stop`). `--auto` swaps the human read for the auto-driver
  so the path reproduces `runPipeline` for scripting/CI. The drive loop lives in
  a library module (`driveWorkflow`, exported) driven through injected
  input/output/error streams, so it needs no TTY; a chosen transition is
  validated against the ones the step actually offered and rejected with a typed
  `DriveError('transition_not_offered')` otherwise. The same change adds a
  silent-no-op signal to both `role` and `drive`: a turn with empty assistant
  text and zero cost now writes a clear stderr warning (the provider may need
  authentication, e.g. `codex login`) instead of two blank-looking lines.
- **Packaging** — MIT license, CI (typecheck + tests on Bun), and one-command
  install/update from GitHub.

What's planned next lives in [`docs/ROADMAP.md`](docs/ROADMAP.md), not here — a
changelog records what changed, not what's still to do.
