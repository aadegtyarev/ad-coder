# Cost anomaly contract

This contract owns cost references, observed-price reconciliation, and visible
price variance for every response. It applies to every front that starts a run;
it is observability, not provider admission or routing control.

## Guarantees

- A settled provider-reported billed amount is authoritative for that response.
  The core compares it with the resolved reference price for its actual token
  usage and records both amounts, source, scope, and variance ratio.
- A price reference resolves by provider and model: a valid observed-price
  overlay for calculation, then an explicit provider/model configuration, then
  the fetched price catalogue. The catalogue is retained unchanged for comparison
  and orientation; an overlay never rewrites it or operator configuration.
- Confirmed billed observations may create a durable, source-labelled effective
  price overlay under the configured aggregation strategy. It is separate from
  the individual billed records, is inspectable and resettable by the operator,
  and never invents a price where neither usage nor a price source exists.
- Each provider may set a default tolerated variance percentage and each model
  may override it. A charge outside that band is a price-variance event whether
  it is higher or lower; a discount, its end, and changing upstream provider
  prices are therefore visible rather than silently treated as a fault.
- Price variance never rejects, pauses, cancels, reroutes, or otherwise blocks
  a run. It emits a prominent non-blocking operator notice naming provider,
  model, expected and billed amounts, ratio, tolerance, and price source; the
  session closeout reports aggregated variance and unpriced responses.
- A provider that does not report cost uses the resolved reference for estimates
  and labels the result estimated. With no resolved reference it remains
  explicitly unpriced; work continues and all cost totals identify the missing
  measurement rather than substituting zero.
- The internet catalogue is a refreshable, validated cache with source and
  retrieval time. A failed refresh is a visible degradation: use a last valid
  cached catalogue when available, otherwise configured and observed prices;
  models with none are reported unpriced. It never silently substitutes an
  unrelated provider's price or blocks execution solely because the catalogue is
  unavailable.
- Warnings, errors, ledgers, and saved state contain only identifiers and
  numeric measurements, never credentials, account identity, prompts, file
  contents, or raw provider bodies. Fronts render this core state; they do not
  implement their own threshold or bypass a block.

## Configuration

Variance notices, per-provider and per-model tolerance, price-source precedence,
observed-overlay aggregation and retention, catalogue refresh/caching, and notice
coalescing are independently configurable. Variance notices default enabled;
disabling them is explicit. See [configuration](config.md) for setting schema and
persistence rules.

## Verification

`bun run check:prices` reconciles recorded provider charges with resolved price
references:

- It reports out-of-band charges, effective overlay source, stale or unavailable
  catalogue state, and unpriced observations without treating a variance as a
  run-blocking verdict.
- It names missing routes and price sources. An explicitly supplied unreadable
  charge file exits 2; an absent default file states that no observations exist.
- Invalid source data, an incompatible cache, or an impossible configured
  tolerance is an exit-1 configuration finding. A public catalogue is never an
  automatic edit to operator configuration.

## Related surfaces

- [Routing configuration](routing-config.md) owns provider/model price sources.
- [Configuration](config.md) owns shared settings and precedence.
- [Runtime inspection](runtime-inspection.md) owns cost projections.
- [Provider admission](provider-admission.md) owns capacity, not price control.
