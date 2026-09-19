# Ledger report contract

For operators and reviewing roles, this contract answers: how did a run or a
session actually behave, read back from the ledger the runs already wrote?

Two entry points exist and stay in lockstep: `bun run src/cli.ts ledger report
[files...] [--json]`, which a human runs, and `readLedgerFiles(paths)` /
`aggregateLedgerRecords(records)`, which a role calls to answer the same
question without shelling out (`cli.md`, `architecture.md`).

- 2026-09-17: **Identifiers and numbers only.** Every projection carries run ids,
  role, provider/model, tokens, money, tool names, and counts. Never task text,
  prompts, file contents, provider payloads, or tool arguments
  (`errors.md`, `cli.md`).
- 2026-09-17: **A live ledger is read like a live file.** The reader parses one
  line at a time and a line that is malformed, truncated mid-write, or blank is
  a SKIPPED LINE reported per file in the output -- never a crash, and never a
  silently empty count. A file that cannot be opened at all is invalid operator
  input and fails with the path named.
- 2026-09-17: **Derived numbers are derived, not invented.** Report model calls,
  fresh input, cached input, output, reasoning, provider-reported cost (copied,
  never recomputed from tokens), tool mix, bash calls per edit, cache fraction
  (cached input over all input), run_role requests as the delegation signal, and
  time to first edit. Any of these that a scope produces no inputs for is absent
  or `0` as the projection says, never fabricated.
- 2026-09-17: **The ledger does not store outcomes, so outcome numbers are not
  in this report.** A failed-edit rate needs whether an edit call errored (`isError`
  on an `after_tool` hook that is not yet ledgered); time to green tests needs a
  test-outcome event. Reporting either without adding that source would be an
  invented number. They are named follow-ons here and in `src/ledger/types.ts`,
  and absent from the report until the ledger can carry them.
- 2026-09-17: **An unnamed tool call is a named anomaly (issue #251).** A call
  block whose name did not arrive from the provider is counted under the
  explicit `<unnamed>` sentinel, never the empty string, so every name-keyed
  projection reads it as exactly that: a provider anomaly, not a tool. It is
  often the visible half of a truncated provider response -- diagnose it
  against the same record's `stopReason` (`error`/`truncated` beside it) or
  treat a lone one as an isolated quirk.
- 2026-09-17: Report is per role, per provider/model, and totals, each carrying
  the same numeric shape; tool-name keys and provider/model strings are
  attacker-influenced data and are handled as data only.

- 2026-09-19: **A refusal row records a turn the conversation refused before
  any provider call (issue #422).** Its `usage` is zero in every amount, its
  `stopReason` is `refusal`, and it carries one additive `refusal` object with
  the typed code, the discriminator, and the AUTHORED refusal sentence -- never
  a prompt or any other in-scope payload. It stays distinguishable from a
  provider-failure row, which carries the provider's own usage and no `refusal`
  field. Readers that do not know the field ignore it; aggregations take it in
  with a zero contribution.
