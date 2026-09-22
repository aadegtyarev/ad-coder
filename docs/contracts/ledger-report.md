# Ledger report contract

This contract governs read-only reports over run ledgers.

## Guarantees

- The CLI report and programmatic reader/aggregator expose the same report.
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

## Related surfaces

- Command-line front: `cli.md`.
- Public error behaviour: `errors.md`.
- Delivery evidence: `quality.md`.
