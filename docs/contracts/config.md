# Configuration contract

Stage budgets are cumulative across durable resume. The configurable
`finalResponseReserveModelTurns`, `finalResponseReserveDurationMs`,
`finalResponseReserveToolTurns`, and `finalResponseReserveInputTokens` settings
protect closeout capacity. Once a
bounded stage enters any enabled reserve, new tool calls fail with an instruction
to return the final response, and following provider requests expose no tools and
carry that same instruction as a user message naming the reserve that tripped,
while the reserved capacity remains available. Input admission uses the preceding
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
  multiple providers. Routing must select only models in that inventory. When
  available, Coder and Reviewer may use different model families to reduce
  correlated blind spots; a single-family inventory may route them to different
  variants recommended for those roles.
- 2026-09-14: `~/.config/ad-coder/inventories.json` is the single editable
  runtime source for named registry/routing profiles. First CLI use seeds the
  built-in OpenAI profile when the file is absent; upgrades never overwrite an
  existing user-owned file. Explicit provider, registry, profile, or model flags
  remain non-persistent per-run overrides.
- 2026-09-13: User profiles are portable through explicit versioned export and
  import. Exports contain inventories, routing calibration, confirmed economic
  history, and safe subscription-capacity estimates, but never credentials,
  account identifiers, raw provider responses, or project run transcripts.
  Import validates before mutation and resolves conflicts explicitly.
- 2026-09-13: Confirmed model price and limit changes append history rather than
  rewriting it. Current values retain source, observation date, units, and
  confidence. Projects may commit a bounded anonymous snapshot plus calibrated
  overrides; user history remains the cross-project source of truth.
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

## Sources

The 2026-09-11 rules implement “good out of the box, everything overridable.”
The 2026-09-12 rules govern session turn and USD limits in programmatic and
console surfaces without changing the existing context-window safeguards. The
2026-09-14 rule exposes `researchPurpose` and an optional three-part trusted
`researchBrief` source through the API and `--research-purpose` plus
`--research-brief-id`, `--research-brief-version`, and `--research-brief-path`
through pipeline-capable CLI commands.
The decomposition-depth exception implements the operation-mode contract's
default stop after a child pipeline asks for decomposition again.
