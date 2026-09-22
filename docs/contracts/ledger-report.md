# Ledger report contract

This contract governs read-only reports over run ledgers.

## Guarantees

- The session inspector, machine API, and programmatic reader/aggregator expose
  the same ledger report.
- Projections contain identifiers, numbers, role, provider/model, tool names,
  and counts. They never contain task text, prompts, file contents, provider
  payloads, or tool arguments.
- A live ledger is parsed line by line. Blank, truncated, or malformed lines are
  reported as skipped; an unreadable requested file fails with its path.
- Metrics are derived from ledgered data only. Missing source data is absent or
  zero as the shape specifies, never invented.
- Report groups by role, provider/model, and total. An unnamed provider tool call
  uses the explicit `<unnamed>` sentinel.
- A refusal row has zero usage plus its typed refusal. A provider-error row may
  retain only bounded HTTP status and provider-code token.
- A session closeout summary is derived from the same ledger and durable event
  stream. It includes totals and per-role/provider/model token and cost statistics,
  estimates versus billed amounts, and every recorded abnormal event or degraded
  condition with its outcome. Missing measurements stay named rather than zeroed.
- The same safe summary is readable in TUI and the machine API. An enabled forge
  delivery-summary capability attaches it to an associated pull request when a
  project setting requests it; unavailable or disabled forge capability leaves
  the core summary intact and reports the delivery failure visibly.

## Related surfaces

- [Command-line front](cli.md).
- [Public error behaviour](errors.md).
- [Delivery evidence](product-change.md).
- [Runtime inspection](runtime-inspection.md) owns session and harness projection.
- [Extension modules](extension-modules.md) owns optional forge capabilities.
