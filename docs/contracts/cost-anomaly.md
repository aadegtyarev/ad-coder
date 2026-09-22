# Cost anomaly contract

This contract owns protection against a provider charging more than the
configured price for a response. It applies to every front that starts a run.

## Guarantees

- The core compares each settled response's provider-reported billed amount with
  the configured price for its actual token usage, within the configured scope.
  The declared price is the reference; observed traffic never becomes a learned
  baseline.
- Only a charge above the declared price can be anomalous. A discount, its end,
  or a provider that does not report a billed amount never blocks a run. The
  latter remains explicitly unmeasured.
- A configured number of consecutive above-threshold observations confirms an
  anomaly; an observation below the threshold resets the pending count.
- A confirmed anomaly warns the operator and rejects new runs in that scope with
  a typed error naming the scope, charged and expected amounts, ratio, and
  release action. It does not cancel work already in flight or silently reroute
  it.
- Only an explicit, durable, per-scope operator release unblocks that scope. A
  release records the accepted ratio as a ceiling, which later cheaper charges
  cannot lower. Unreadable or incompatible saved state is discarded as state,
  never partially interpreted.
- Warnings, errors, ledgers, and saved state contain only identifiers and
  numeric measurements, never credentials, account identity, prompts, file
  contents, or raw provider bodies. Fronts render this core state; they do not
  implement their own threshold or bypass a block.

## Configuration

Detection is enabled by default. Its threshold ratio, confirmation count, and
scope granularity are independently configurable; disabling it is explicit.
See [configuration](config.md) for the setting schema and persistence rules.

## Verification

`bun run check:prices` compares recorded provider charges with declared routes:

- A charge above `1 + tolerance` is an under-declared finding and exits 1.
- A charge below `1 - tolerance` is an over-declared note and exits 0.
- It names missing routes and observations. An explicitly supplied unreadable
  charge file exits 2; an absent default file states that no observations exist.
- Differing declarations for the same model across routes are an exit-1
  self-consistency finding. Public price lists are hints only and never a
  verdict or an automatic edit.

## Related surfaces

- [Configuration](config.md) owns declared price data and settings.
- [Errors](errors.md) owns the public typed-error boundary.
- [Provider admission](provider-admission.md) owns capacity, not price control.
