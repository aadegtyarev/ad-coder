# Runtime inspection contract

This contract owns read-only session diagnostics, ledger summaries, and harness
identity/capability information.

## Guarantees

- One shared inspector projects the current or an explicitly selected accessible
  session. It reports session/task/run/lane/wake state; effective profile and
  ceilings; queued input count; and ledger usage grouped by role and model with
  total tokens, cache tokens where recorded, tool counts, provider-reported cost,
  and totals. Missing ledger fields remain absent rather than invented.
- The inspector also reports harness name, SemVer version, optional build
  revision, enabled module and capability catalogue, and concise action help.
  It distinguishes declared price information from provider-reported cost and
  reports the effective configuration source without credentials.
- `/status` projects the selected TUI session; `/about` projects harness identity
  and capabilities. `sessions.inspect` and `harness.about` return the identical
  structured information through the machine API. They are local, read-only, and
  never start a provider call, run, wake, or orchestration turn.
- The orchestrator has a read-only `inspect_session` tool over its accessible
  session and a read-only `harness_about` tool. The same bounds, fields, and
  redaction apply, so it can make cost and capability decisions from evidence
  without carrying raw ledger data or large outputs in context.
- Every projection excludes task text, prompts, file contents, tool arguments,
  provider payloads, credentials, and account identity. A missing, unreadable,
  or malformed ledger reports bounded safe diagnostics and available partial
  totals rather than hiding the condition.

## Verification

Test current and selected-session reports, role/model and total aggregation,
missing fields, partial-ledger diagnostics, exact TUI/API/orchestrator parity,
identity/version/capability output, read-only evidence, and secret redaction.

## Related surfaces

- [Ledger report](ledger-report.md) owns ledger parsing and aggregation.
- [Session manager](session-manager.md) owns session state and access.
- [Machine API](machine-api.md) owns JSON transport.
- [TUI operator commands](tui-commands.md) owns TUI controls.
- [Role and tool wiring](role-tools.md) owns orchestrator tool registration.
