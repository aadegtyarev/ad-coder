# Configuration contract

Stage budgets are cumulative across durable resume. The configurable
`finalResponseReserveModelTurns`, `finalResponseReserveDurationMs`,
`finalResponseReserveToolTurns`, and `finalResponseReserveInputTokens` settings
protect closeout capacity. Once a
bounded stage enters any enabled reserve, new tool calls fail with an instruction
to return the final response while the reserved capacity remains available.
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
