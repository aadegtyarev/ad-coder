# Configuration contract

Stage budgets are cumulative across durable resume. The configurable
`finalResponseReserveModelTurns`, `finalResponseReserveDurationMs`,
`finalResponseReserveToolTurns`, and `finalResponseReserveInputTokens` settings
protect closeout capacity. Once a
bounded stage enters any enabled reserve, new tool calls fail with an instruction
to return the final response, and following provider requests expose no tools --
except the workflow's submission tools: a stage whose deliverable is a
submission keeps those granted and has them admitted past the reserve, because
refusing the submission destroys the deliverable the closeout exists to save
(2026-09-18, issue #339). The same request carries that instruction as a user
message naming the reserve that tripped, while the reserved capacity remains
available. Input admission uses the preceding
provider request as its conservative next-request estimate.
Zero disables each reserve independently.

Rules the operator declared for ad-coder. A violation is always blocking.

- 2026-09-11: Any behavior a reasonable user may want to change is configurable.
- 2026-09-11: Defaults are maximally efficient; every setting remains overridable.
- 2026-09-11: Context mode, window percentage, reply reserve, and summarization percentage are configurable end to end.
- 2026-09-12: Numeric resource limits default to `0`; `0` disables and only a positive value enables them.
- 2026-09-13: Final-response reserves are an explicit exception: their efficient
  defaults protect 4 model turns, 30 seconds, 8 tool turns, and 100,000
  provider-reported input tokens inside an enabled stage budget. Each reserve
  remains independently configurable and zero-disableable.
- 2026-09-19 (issue #405): the reserve defaults are the ones the code has used
  since 2026-09-18 -- 12 model turns, 90 seconds, 24 tool turns, and 300,000
  provider-reported input tokens -- and the 2026-09-13 numbers above are
  superseded by that raise, which left the CLI help, the README and this entry
  stating the pre-raise values. The property recorded on 2026-09-13 is unchanged:
  each reserve is independently configurable and zero-disableable. All nine
  stage-limit help lines (five ceilings and four reserves) are now interpolated
  from `DEFAULT_STAGE_LIMITS` rather than typed, so a future raise moves the
  shipped text with the number instead of leaving it behind.
- 2026-09-12: Context-window enforcement, summarization percentage, the
  decomposition guards, and mandatory tool-activity projection/event/rendering
  safety ceilings are explicit exceptions to the zero-disabled default policy.
  Tool-activity zero values are valid only for documented disable/immediate
  semantics: heartbeat, replay retention, grouping delay, and close draining.
- 2026-09-12: Auto-decomposition depth is a semantic recursion guard: it defaults
  to `1`, while `0` means unlimited. Child-pipeline count defaults to the efficient
  finite guard `8`; `0` explicitly means unlimited. A separate setting disables
  automatic decomposition itself.
- 2026-09-13: A model inventory is operator-authored and may contain one or
  multiple providers. Routing must select only models in that inventory.
- 2026-09-16 (corrected 2026-09-20): Coder and Reviewer must come from
  different model families at the same complexity. An author is blind exactly
  where they erred, and a checker from the same family shares the blindness, so
  a same-family pairing buys a review that cannot see the defect. The rule
  covers the Reviewer only, because the reviewer checks the coder's work; the
  Auditor does NOT check it -- the auditor looks at the project as a whole and
  its job is different -- so a same-family coder/auditor pairing is permitted
  (operator clarification, 2026-09-20). Route Coder and Reviewer together only
  when the inventory offers no second family; then use different variants
  recommended for those roles, and record that the constraint was unsatisfiable
  rather than leaving it looking like a choice. Stated as "may" until
  2026-09-16, which is why a seeded matrix put one model on Coder, Reviewer and
  Auditor at once without anything objecting; the shared Coder/Reviewer model is
  the pairing this rule names, and the Auditor sharing it was never in scope.
- 2026-09-14: `~/.config/ad-coder/inventories.json` is the single editable
  runtime source for named registry/routing profiles. First CLI use seeds the
  built-in OpenAI profile when the file is absent; upgrades never overwrite an
  existing user-owned file. Explicit provider, registry, profile, or model flags
  remain non-persistent per-run overrides.
- 2026-09-19: **Stored credentials and per-role overrides for any declared
  env-var provider (issue #101).** Stored-credential admission is keyed by the
  resolver's knowledge set for any declared env-var provider: a credential
  store that produces a snapshot admits exactly the ids it names, and a store
  without a snapshot stays env-only (its key must arrive via the environment).
  `ad-coder auth` (login/status/logout) covers declared env-var providers,
  sourced `models.yaml`-first -- the same precedence routing uses, including
  the same-day retirement of the stored `inventories.json` route below (a
  present stored JSON under an absent `models.yaml` is that loud migrate
  error for auth too) -- and a declared env-var provider resolves as an
  `api_key` login with the same empty-key refusal and post-login retention
  check as the shipped `openrouter` preset. Per-role model overrides (`--coder-model` and
  the rest of the role-model family) COMPOSE with a selected inventory: pinning
  one role's model keeps the selected registry/profile and overrides only that
  role, instead of being refused or silently disabling the inventory. An
  override naming a model the selected inventory does not register is a typed
  `unknown_model` error naming BOTH the inventory/profile name and the override
  model.
- 2026-09-19: **The operator-facing routing config is `models.yaml` and the
  behaviour config is `settings.yaml` (issue #280).** `models.yaml` declares
  `providers` (each with an optional provider-level `baseUrl`, an `enabled`
  switch, a `credential` env-var NAME, and `models`), `profiles`
  (`role: provider:model`, with a `role@complexity` row REPLACING that tier
  only, and a list-valued row as an IN-ORDER fallback ladder), and an optional
  `default:` profile. A model row carries required `input`/`output` prices and
  may also declare `cacheRead`/`cacheWrite` (per-token cache prices in the
  same declared unit; they project into the registry's cost, and absent
  settles at zero -- the only value not invented) and `maxTokens` (the
  per-completion OUTPUT ceiling, distinct from the `contextWindow` budget; a
  declared value projects as the registry model's `maxTokens`, absent keeps
  the window default -- the model's window or the shared 200000 ceiling).
  `settings.yaml` carries `review.require-stamp`
  (`on`/`off`/`auto`) and `review.cost-signature`. When `models.yaml` is
  present and no explicit provider/registry/profile/model flag or `--inventory-config`
  is given, it wins WHOLESALE over `inventories.json`; when it is ABSENT the
  existing `inventories.json` path is unchanged. The winning source is visible
  in `config show` and the startup banner (`models.yaml "<profile>"` vs
  `inventory "<name>"` vs `provider "..."`) -- never a silent switch. A
  present-but-unusable `models.yaml` (for example no `default` and no selected
  profile) is a typed error, NEVER a silent fall back to JSON. Provider-qualified
  names need no alias table; a credential is declared per provider as an
  env-var NAME and translated at the projection boundary to the registry
  `{ kind: "env-var", envVar }` shape (stored-credential support and `ad-coder
  auth` coverage for declared env-var providers followed in the #101 entry
  above). An enabled provider MUST declare a
  credential and a resolvable endpoint (a provider-level or model-level
  `baseUrl`); `baseUrl` and `concurrency` both follow provider-declares/
  model-narrows. Only a ladder's FIRST rung is served today (the runtime walk
  is future work).
- 2026-09-19: **The stored `inventories.json` route is retired (referencing
  the same-day `models.yaml` entry above; issue #280).** `models.yaml` is the
  operator-facing stored routing source; `ad-coder config migrate` (0.80.0)
  is the only stored-JSON reader, and `--inventory-config` remains a per-run
  data path. An absent `models.yaml` with a PRESENT stored `inventories.json`
  is a loud typed error naming `config migrate` -- never a silent switch to
  the env-preset/codex route, and the resolver never rewrites the stored
  file. With both absent, the built-in env-preset/codex route runs exactly as
  before. Nothing is seeded on first use: this supersedes the 2026-09-14
  first-use seeding rule, whose text remains above as history.
- 2026-09-19: **`settings.yaml`'s `review` section is an explicit override of
  the review-stamp marker-file behaviour, resolved ONCE and threaded to BOTH
  the settle writer and the `stamp check` gate so the two can never disagree
  (referencing #284).** `require-stamp: on` writes and requires a stamp with or
  without a marker; `off` writes nothing and passes the gate; `auto`/absent
  keeps exactly the existing marker-governed behaviour. `review.cost-signature`
  follows the same declared-value-wins / absent-keeps-today pattern. A
  present-but-empty or malformed `settings.yaml` is refused, never silently
  defaulted; only an ABSENT file takes the defaults.
- 2026-09-13: User profiles are portable through explicit versioned export and
  import. Exports contain inventories, routing calibration, confirmed economic
  history, and safe subscription-capacity estimates, but never credentials,
  account identifiers, raw provider responses, or project run transcripts.
  Import validates before mutation and resolves conflicts explicitly.
- 2026-09-13: Confirmed model price and limit changes append history rather than
  rewriting it. Current values retain source, observation date, units, and
  confidence. Projects may commit a bounded anonymous snapshot plus calibrated
  overrides; user history remains the cross-project source of truth.
- 2026-09-17: `defaultComplexity` is a declared ROUTING FALLBACK, not an
  assessment (issue #264): it picks the cell for pre-plan roles and any run
  that never reaches a Planner, and nothing validated it against a task, so
  `config show` and the banner may not present it as one. A real tier arrives
  per dispatch from the orchestrator's own recorded classification, which
  replaces the fallback at the routing sink.
- 2026-09-13: Model research and calibration evidence that influences routing is
  durable and portable. Projects retain source-linked research notes and bounded
  anonymous aggregate samples, never raw provider content or account activity.
- 2026-09-14: Model-inventory bootstrap and refresh runs declare their research
  purpose explicitly. They receive a versioned trusted Researcher brief (or an
  explicitly configured trusted replacement); checkpoints retain only its ID,
  version, and SHA-256 digest, never its content or path. Missing or empty
  required briefs fail before provider dispatch.
- 2026-09-13: Background event page count/bytes and worker lease duration are
  mandatory positive safety ceilings; they cannot be disabled with zero.
  Close-drain time remains finite by default and may use zero for immediate
  shutdown. CLI overrides are `--background-max-page-size`,
  `--background-max-page-bytes`, `--background-close-drain-ms`, and `--lease-ms`.
- 2026-09-19: Background wake bounds are the same class of ceiling: the durable
  wake windows a turn drains are retained and batched under mandatory positive
  safety bounds that cannot be disabled with zero. `maxWakeEntriesPerRun`
  (default 12) caps the coalesced wake windows retained per run, and
  `maxWakesPerTurn` (default 8) caps how many unhandled windows one orchestrator
  turn drains. CLI overrides are `--background-max-wake-entries` and
  `--background-max-wakes-per-turn`.
- 2026-09-15: The context window each role will actually use is visible in the
  effective configuration, per role, together with where that number came from
  and the budget derived from it. A window the resolver settled on its own --
  clamped down from a larger catalog value, or defaulted -- names what it was
  settled from, so a declared number that does not survive resolution cannot
  stay silent.
- 2026-09-14: Subscription-credit calibration records server-reported balances as
  append-only `credit_balance` economic records and refill price as `price` in
  `USD/credit`. Both retain only provider/model scope, timestamp, units, source,
  confidence, and an optional predecessor record -- never account identity or a
  raw provider response. `profile record` validates before atomically appending.
- 2026-09-15: Every routing role, including the one that drives the conversation
  and picks the pipeline, owns a profile cell it can be routed and measured by;
  no role silently borrows another's model. Adding a role to the vocabulary is a
  compatible change, so a profile authored before that role existed keeps
  running: the resolver falls back to the route the role previously took and
  says so once on stderr, while a missing cell for any already-declared role
  stays a blocking configuration error.
- 2026-09-16: The compaction summarizer is a routing role like any other:
  `summarizer` owns a profile cell at every complexity, so a profile names the
  model compaction will use and a calibration run attributes its cost to it.
  `--summarizer-model` overrides that cell for one run. The cell was called
  `recorder` while a recorder role was still planned; that role never existed --
  nothing dispatched it, no prompt defined it -- and the cell was only ever read
  for compaction, so the name is retired rather than kept as an alias. A profile
  still naming `recorder` is a blocking `unknown_role`, like any other unknown
  role.

- 2026-09-17: **A run's quality checks are configurable data, not a role's
  behavior (issue #227).** `resolvePipelineConfig` accepts a `qualityGates`
  option: `gates` replaces the shipped gate declaration wholesale (each
  gate needs a non-empty `name` and a non-empty `command` argv),
  `maxOutputChars` overrides the report's per-gate capture ceiling, and both
  validate fail-loud before any provider dispatch. Omitting the option ships
  the project's own declared gates -- seven in-run commands since 2026-09-17,
  when issue #271 moved the review-stamp check (`bun run stamp:check`, issue
  #239) OUT of this set: its writer is `runPipeline`'s settle path and its
  property only exists at settle, so it is the operator's pre-merge gate run
  outside any run. Per-gate
  output capture has a
  positive mandatory default (64 KiB) that cannot be set to zero.
- 2026-09-16: Every capability ad-coder ships is enabled at startup. A capability
  is a switchable feature a run does not need to survive: a workflow module,
  skills, background dispatch, accounting and observability features, and their
  future kind. Three layers resolve in one order: the built-in default
  (enabled), then a persistent setting the operator owns, then an explicit
  launch parameter. Each layer must be able to switch the capability off, and a
  set-valued capability must also allow selecting or excluding members. An
  explicit parameter beats the setting; when both are absent the default
  resolves enabled. The resolved state of every capability is visible in the
  effective configuration, so enabled-by-default is never silent. A capability
  that ships off by default, cannot be disabled through a setting, or cannot be
  switched at launch violates this rule. The only exceptions are dated entries
  in this file that name the safety or cost reason.

- 2026-09-16: Workflow modules resolve enabled: a plain session carries the
  built-in `pipeline` module and its tools without any flag. `--workflows` is
  the set-valued launch parameter, declared once for every pipeline-capable
  command: a comma list selects exactly those modules, a `^name` token excludes
  from the built-in default, and `--workflows=false` switches the capability
  off explicitly. `ad-coder config show` reports the resolved names and where
  the selection came from. The persistent-setting layer is open, on purpose:
  ad-coder has no operator-owned settings store yet; its home and schema are
  being decided for skills first (issue #116, item 3) and every other
  capability follows the same store. Until a store exists, only the launch
  parameter can turn workflow modules off. This entry records that gap so it
  cannot count as a completed exception; the audit issue (#216) holds the
  resulting capability table.
- 2026-09-17: An explicit capability switch crosses every process boundary the
  product creates verbatim, including the boundary into a detached background
  worker (issue #245). The worker command repeats the launch parameter words
  the operator typed -- the skills pin, the explicit off (`--no-skills`), and
  the set-valued `--workflows` and `--plugins` values -- so an off or a
  selection reaches the process the operator cannot see, instead of resolving
  back to enabled-by-default from the worker's own profile read. The
  persistent-setting layer does not repeat: the worker re-reads it on its own,
  as it already did. The pin and the off inherit like each other -- asymmetry
  here is what #245 was (a pin inherited, the off stopped at the console).
- 2026-09-19: The credential-source launch parameter (`--credential-path`)
  crosses the boundary into the detached background worker verbatim when the
  operator typed it (issue #101): the worker command repeats the parameter,
  so the worker resolves the same private credential file the console was
  launched with. The value carried is a path, never a credential value. When
  the parameter is absent the worker keeps its own default-file resolution,
  unchanged. The parameter is not persisted: it never lands in the profile or
  the run record. This extends the 2026-09-17 boundary rule's class of
  repeated launch words by one word that is not a capability switch; it does
  not rewrite that rule -- the persistent-setting layer still re-reads on its
  own.

## Sources

The 2026-09-11 rules implement “good out of the box, everything overridable.”
The 2026-09-12 rules govern session turn and USD limits in programmatic and
console surfaces without changing the existing context-window safeguards. The
2026-09-14 rule exposes `researchPurpose` and an optional three-part trusted
`researchBrief` source through the API and `--research-purpose` plus
`--research-brief-id`, `--research-brief-version`, and `--research-brief-path`
through pipeline-capable CLI commands.
The 2026-09-19 pair (issue #280) supersedes the 2026-09-14 "`inventories.json`
is the single editable runtime source" rule for routing: `models.yaml` is the
operator-facing routing document and `settings.yaml` the behaviour document,
resolved YAML-first-then-JSON with the winning source visible rather than
silent; the same-day retirement entry above makes the retirement real: a
present `inventories.json` under an absent `models.yaml` is a loud typed error
naming `config migrate`, and nothing is seeded on first use.
The decomposition-depth exception implements the operation-mode contract's
default stop after a child pipeline asks for decomposition again.
The 2026-09-16 capability rule generalises the 2026-09-11 pair from values to
switchable features: shipped means enabled, a setting and a matching launch
parameter can each turn a capability off, and the resolved set is visible rather
than silent. It is the contract the skills default and the workflow-modules
default answer to; anything that must stay off by default owes a dated exception
in the rule list above.
The 2026-09-17 boundary rule extends the capability table across the one
process boundary the CLI itself owns: the detached background worker repeats
the operator's explicit capability words verbatim (issue #245) instead of
re-resolving them to enabled defaults.
The 2026-09-19 entry (issue #101) extends that repeated class by one launch
word that is not a capability switch: the credential-source path
(`--credential-path`) crosses into the detached worker verbatim when typed,
so a background pipeline authenticates on the same private credential file
the console was launched with -- a path crosses, never a credential value;
absent, the worker keeps its own default-file resolution, and nothing is
persisted into the profile or the run record.
The 2026-09-17 delegation-facts rule (issue #232) makes the resolver's role-to-
model grouping -- the data the startup banner prints -- a structured field of
the resolved config (`delegatedRoute`: source, complexity, reachable groups,
and roles that resolved to no model). The conversational front renders that
field into the `run_role` tool description instead of listing role names as
prose, so the facts an orchestrator delegates on are the facts the operator
was shown, under the same overriding rules the banner already answers to.

- 2026-09-17: **The plan is carried past compaction, not through it.** A plan
  that reaches the summarizer comes back as a paraphrase, and the stage then
  works from the paraphrase: the acceptance criteria blur, the carried contract
  requirements stop being requirements, and the identifiers a later turn looks
  up literally no longer match. It is excluded from the evicted head and carried
  verbatim instead. This is cheaper as well as safer -- the plan is the largest
  stable block in a run, so not summarising it saves the tokens compaction was
  called to save. A plan too large to carry whole is the size signal in
  `overload-response`, and the answer there is decomposition, not a paraphrase.
  The same rule covers what a later turn acts on literally: the role's own
  system prompt and skill catalogue (already cached), the registered tool
  definitions (a paraphrased tool name is called and missed), the contract text
  a plan carried as blocking, and, on a fix pass, the reviewer's verdict -- that
  is the stage's task, not its history. What compaction is for is what grows:
  turn narration and tool output whose finding is already recorded.

- 2026-09-17: **The summary has a size target, expressed as a fraction of the
  window and configurable like every other context share.** It sits beside
  `maxTokensPercent`, `reserveTokensPercent` and `keepRecentTokensPercent` in
  `ContextBudgetPercents`, defaulting to 0.18. Without a target the summarizer
  is told to compact and nothing bounds the result, so a summary can return a
  third of the window and buy almost nothing -- while a run near its ceiling
  compacts again immediately, which is the compaction-burst signal in
  `overload-response` firing for a reason nobody set. The target reaches the
  summarizer as a parameter, never as a number written into
  `prompts/summarizer.md`: a quantity that changes behavior is not a constant in
  the source (`quality.md`).

- 2026-09-18: **A closeout keeps the workflow's submission tools (issue #339).**
  Reaching a reserve stripped every tool from the next request AND told the model
  to stop using tools, in the same conversation that was still demanding a
  `submit_plan`; a planner left with nothing to submit with emitted the
  submission as text, and the stage died as `malformed_plan` with the plan and
  the stage's whole budget gone. Observed live: run
  `e4ccfbdb-37b1-47bd-8bc3-3d5e6ac5372f`, 2026-09-18. The closeout request now
  keeps the workflow's submission tools and nothing else, `admitToolTurn` admits
  a submission past the reserve while still counting the turn, and the wording
  says "other tools" and names the exception instead of commanding a stop the
  same turn contradicts. A stage that granted no submission tool still closes
  out tool-free, exactly as before.

- 2026-09-19: **`config migrate` transforms every stored inventory profile into
  a fresh `models.yaml`, all or nothing (issue #280).** The pure transform
  resolves every profile through the production resolver and projects it onto
  the models.yaml vocabulary, then proves per-cell parity by resolving BOTH
  sides through the same resolver with a stub environment: env-var NAMES only,
  and no credential VALUE is ever read. Providers are unioned by id across
  profiles -- an identical effective declaration merges, a differing
  api/baseUrl/credential/headers or model fact is a reported conflict with the
  first declaration standing. Model ALIASES disappear: rows are keyed by the
  provider-native model id and every rung is rewritten to `provider:modelId`.
  A bare row equals the trivial tier's rung, and every declared tier that
  differs gets a `role@complexity` override. Fields with no models.yaml
  expression (per-cell `maxOutput`/`cacheRetention`/`thinkingLevel`, per-model
  `api`/`compat`/`headers` hints, display names, catalogs) are REPORTED as
  dropped, never silently lost; an oauth credential is reported not
  expressible rather than half-written. Any provider conflict, not-expressible
  provider, whole-inventory error, or parity mismatch prints the full report
  and writes NOTHING; success writes ONE fresh file that must not already
  exist -- an existing models.yaml, a hand-edited one included, is refused,
  never clobbered -- and the summary notes that profile names are preserved:
  renaming a profile to a purpose name is a hand edit. The inventory's default
  becomes `default:` only when that profile actually migrated.

- 2026-09-20: **The context policy is durable data, and the HARNESS is its
  writer (issue #444).** `auto` no longer edits the outgoing request: the
  harness cuts the branch and asks ad-coder for the summary through the
  `before_compaction` hook, so the committed `compaction` entry is what makes
  the session smaller and the next request shorter. The three numbers stay the
  role's -- `maxTokens`, `reserveTokens`, `keepRecentTokens` -- and only the
  harness reserve is DERIVED, from the role's own threshold, so both strategies
  fire at the same measurement (`compaction.md`). What the summarizer receives
  is dialogue history alone: the role's system prompt, its tool definitions and
  the skills catalogue are the byte-identical cached prefix and are never sent
  to it, which is the token saving this whole path exists for. The summarizer
  remains the `summarizer` routing cell (`--summarizer-model` for one run), and
  it is a generation path like any other: it crosses admission, session limits
  and the cost meter, and its failure is attributed in names and numbers.
  `disabled-then-halt` still summarizes nothing and refuses at the effective
  ceiling, and `cache-aware` stays a fail-loud reserved mode.

- 2026-09-20: **The human `config show` front prints ONE primitive row per
  output line as `name=value (source)`, and a set-valued capability's row
  states its resolved state and count -- never a placeholder (issue #416).**
  The skills row prints e.g. `skills=8 skills enabled`, and the explicit off
  prints `skills=disabled`; a switch whose reach set was never supplied says
  `enabled` and claims no count it does not know. Member ids join the count
  with the workflows comma-list name rule (src/cli/resolve-config.ts) only
  while the WHOLE row fits the documented 120-column line budget
  (`CONFIG_SHOW_MAX_LINE_LENGTH`, src/cli.ts), so an unbounded catalogue can
  never flood a terminal. The renderer only FORMATS what the resolver already
  decided: the human row and the `--json` row describe the same resolved set.
  A set-valued value with no deliberate renderer branch fails the command
  loudly, naming the KEY only -- never the value -- so `[object Object]` can
  never be printed again; the leak-class tripwire over every resolved row
  lives in test/cli.test.ts.

- 2026-09-20 (issue #449): **The pipeline diff projection measures, it does
  not gate.** The projection limits -- `pipelineContext.projection.maxPaths`
  (128), `maxPathBytes` (1024), and `maxAggregateBytes` (32 KiB), defaulted in
  `DEFAULT_PIPELINE_CONTEXT_CONFIG` -- are mandatory positive safety ceilings:
  overridable, and zero is refused rather than disabling the guard. Untracked
  content past the aggregate ceiling is truncated at a UTF-8 codepoint
  boundary, never an exception, and the projection carries the changed-path
  list and the true measured size beside the bounded text
  (`untrackedMeasuredBytes` before truncation, `untrackedTruncatedFiles` for
  each capped file); tracked diff output past the ceiling still fails the
  bounded read as a typed measurement, whose durable record keeps the measured
  path list under `projectionFailed`. The three facts
  that used to share one overloaded `changedFilesTruncated` counter each get
  their own record field and stable reason: real path-list truncation
  (> `maxPaths`) widens the handoff under `path_list_truncated`;
  sensitive-path redaction under `projection_redacted` (`redactedPaths`);
  ONLY a failed git measurement under `projection_failure`
  (`projectionFailed`) -- so a durable record can never render "measurement
  failed" as "no changes". `material_diff` escalates on the true measured
  size (the cumulative tracked diff or the untracked measured bytes), not on
  the truncated projection's byte count; the threshold that escalation
  compares against is `pipelineContext.maxFocusedDiffBytes` (64 KiB, zero
  disables).
