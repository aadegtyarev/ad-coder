# Cost anomaly contract

For operators, SessionManager fronts, and anyone who lets ad-coder spend money
unattended, this contract answers: what happens when a provider starts charging
more than the price it was configured with, and who decides whether to keep
spending?

The failure this exists for is not a slow drift in a monthly bill. It is a
provider repricing a model, or a preset silently rerouting to a costlier
backend, observed only after a long autonomous session has already paid it many
times over. Per-stage `maxCostUsd` does not catch it: each individual run stays
under its own ceiling while every one of them costs more than the operator
agreed to pay.

- Detection compares **what the provider says it billed** against **what the
  operator's own declared price list predicts for that same response**. The
  observable is the ratio of the two for one `(provider, model)` scope. Both
  numbers are per-response: the first comes off the wire with a settled
  response, the second from the configured prices for the tokens that response
  actually used.
- **The reference is the declared price, never a learned one.** A baseline
  learned from traffic cannot distinguish a discount ending from a price
  rising: a cheap backend billing under the declared price teaches the baseline
  that the discount is normal, so the ordinary price returning reads as a spike
  and blocks a session that is paying exactly what was agreed. A learned
  baseline also has no stable denominator, because dollars per token varies by
  orders of magnitude with a response's mix of cached, input, and output tokens
  at a completely constant price. The ratio has neither problem: composition
  appears in both halves and cancels.
- Consequently **a discount never blocks and neither does a discount ending**.
  Only billing ABOVE the declared price moves the ratio up. There is also no
  warm-up: the first settled response is already checkable, so a reprice that
  was already in effect before this project's first run is caught rather than
  learned as normal.
- **A provider that reports no billed amount leaves its scope unmeasured.** Not
  every provider reports one. Such a scope reports that it has no charge data
  and never blocks; it must not report a normal, checked price, because the only
  other number available is the very price list the detector exists to check.
  Asking a provider for its billed amount must never change how a request is
  otherwise handled, and a provider not known to report one is asked for
  nothing extra.
- An anomaly is the ratio crossing a configured threshold above the scope's
  accepted ratio, confirmed by more than one consecutive settled observation. A
  single reading never blocks: providers report incomplete usage, and one
  anomalous number is an artifact until it repeats. A reading back under the
  threshold discards the pending ones rather than banking them toward a later
  false confirmation.
- On a confirmed anomaly the operator is warned and **new runs in the affected
  scope are blocked** until the operator explicitly releases them. Work already
  in flight is not killed: the money for the current stage is already committed,
  and aborting it mid-stage wastes it without saving anything. A blocked start
  is a typed, actionable refusal naming the scope, the amount charged, the
  amount expected, the ratio, and the release action -- never an empty result,
  never a silent downgrade to a different model.
- The release is an explicit operator act, it names the scope it releases, and
  it is durable: it survives restart, it is recorded with the numbers observed
  at the time, and it records the confirmed ratio as that scope's accepted
  ceiling so the same price does not immediately re-trip. Accepting a price
  never lowers that ceiling afterwards -- a later cheaper response does not
  quietly re-arm the detector at the lower number. A release is per-scope;
  releasing one model never releases another.
- **Saved state that this release cannot read is discarded, never half-read.**
  Durability must not become a fault on upgrade: a state file whose shape
  predates a change in what the detector measures is dropped exactly like a
  corrupt one. Discarding costs only recent history, because the reference is
  the declared price rather than something learned from traffic, so there is
  nothing to rebuild. Reading such a file as though it were current is the
  worse outcome -- a stale block would fault at the Models boundary every
  generation passes through, and a fault is not a refusal.
- **Nothing but an operator release moves the reference.** Observations never
  raise it. A reference that drifted toward what is being billed would absorb a
  reprice arriving in small steps, one acceptable-looking step at a time, which
  is exactly the failure this detector exists to catch.
- The whole behavior is configurable and **enabled by default**. The threshold
  ratio, the confirming-observation count, and the scope granularity are
  settings with efficient defaults. Disabling the detector is an explicit
  operator choice, never a side effect of another setting.
- Every projection of an anomaly -- warning text, typed error, ledger line,
  durable block record -- carries identifiers and numbers only: provider, model
  name, scope label, amounts, ratios, counts, timestamps. Never a credential, an
  account identifier, a prompt, file contents, or a raw provider response body.
- Detection and blocking are headless core behavior. CLI, console, and any
  external front render and transport the same structured state; a front must
  not implement its own threshold, and must not be able to start a blocked run
  by bypassing the core.

## Declared price audit


`bun run check:prices` audits the operator's declared prices. The judgement is
DIRECTIONAL, because the two directions do not cost the same:

- **The provider's own charge answer is the verdict.** Per `(provider, model)`
  scope, the command compares what the provider billed against what the
  declared row predicts (the same charged/expected ratio the cost-anomaly
  detector records), read from the project's charge record (`--charges <path>`,
  defaulting to `.ad-coder/cost-anomaly.json` in the target directory) with the
  module that owns that file.
  - A ratio ABOVE `1 + tolerance` means the provider charges MORE than the row
    says: the row is UNDER-DECLARED, a FINDING and exit 1. An under-declared
    row must stop being invisible.
  - A ratio BELOW `1 - tolerance` means the row prints MORE than reality
    (OVER-DECLARED): a visible NOTE, never a block, exit stays 0.
  - Within tolerance the row is clean. Every scope with no declared route, and
    every route with no observation, is named -- never silently skipped.
- **The public OpenRouter list is a HINT, not a verdict.** A disagreement is
  printed as `hint` -- "a reason to measure" -- and never sets exit 1, because
  the list can name the cheapest backend's price while the account is billed
  for a dearer one. It is never a verdict and never grounds to edit.
- **The offline self-consistency judgement still runs and still sets exit 1**:
  the same model declared differently under two routes, grouped by the model
  id's last path segment and reported verbatim.

Exits: 0 clean (notes and hints included), 1 a finding (under-declared,
self-inconsistency, or a hostile row), 2 an explicitly requested `--charges`
anchor could not be read. An absent or unreadable DEFAULT charge record is
stated as "no charge observations available", never a silent pass. The command
only makes a wrong row visible; fixing it is the operator's act, never an
automatic rewrite.

## Sources

The operator's 2026-09-14 rule: warn on a sharp jump in per-request model cost,
block new runs until explicitly allowed, optional, default on, configurable.

The operator's 2026-09-15 correction, which set the reference: the detector must
not take an anomalous discount on an intermittently available provider as the
norm and then block when that provider drops out and the next one charges the
ordinary price. The whole point is catching an anomalous INCREASE.

Measured the same day, against this operator's own account: OpenRouter reports a
billed amount, on both the streaming and non-streaming paths, when the request
carries `usage: {include: true}`; under a caller's own upstream key it reports
`is_byok`, zeroes that amount, and reports the real one separately -- the same
charge, never the sum of the two. OpenCode Zen returns token counts and no
amount at all, which is the case the no-charge-data rule is written for.

Blocking new runs rather than killing in-flight ones, because the committed cost
of a running stage is not recoverable. Explicit release recording an accepted
ratio, because a permanent provider reprice is a fact to accept once, not an
alarm to dismiss on every subsequent run.

The append-only `price` economic records of the configuration contract are the
natural durable home for a confirmed acceptance: a release is a confirmed price
change, and confirmed changes append history rather than rewriting it.
