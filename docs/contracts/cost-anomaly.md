# Cost anomaly contract

For operators, SessionManager fronts, and anyone who lets ad-coder spend money
unattended, this contract answers: what happens when a model suddenly starts
costing more than it did, and who decides whether to keep spending?

The failure this exists for is not a slow drift in a monthly bill. It is a step
change -- a provider repricing a model, a preset silently rerouting to a costlier
backend, a routing cell moved to a more expensive family, a cache that stopped
being hit -- observed only after a long autonomous session has already paid it
many times over. Per-stage `maxCostUsd` does not catch it: each individual run
stays under its own ceiling while every one of them costs several times what the
same work cost yesterday.

- Detection is on the **unit price actually charged**, not on a calendar and not
  on a total. The observable is provider-reported cost per token for one
  `(provider, model)` scope, derived only from numbers the provider already
  returned with a settled response. A run that is simply larger than the last
  one is not an anomaly; the same work at a higher rate is.
- The baseline is the recent history of that same scope, and it is durable.
  A first observation establishes a baseline and can never itself be a spike.
  A baseline built from fewer than the configured minimum number of settled
  observations reports insufficient evidence rather than a verdict; the detector
  stays silent rather than guessing.
- A spike is a ratio against that baseline crossing a configured threshold,
  confirmed by more than one settled observation. A single reading never blocks:
  providers report incomplete usage, and one anomalous number is an artifact
  until it repeats.
- On a confirmed spike the operator is warned and **new runs in the affected
  scope are blocked** until the operator explicitly releases them. Work already
  in flight is not killed: the money for the current stage is already committed,
  and aborting it mid-stage wastes it without saving anything. A blocked start
  is a typed, actionable refusal naming the scope, the baseline, the observed
  rate, the ratio, and the release action -- never an empty result, never a
  silent downgrade to a different model.
- The release is an explicit operator act, it names the scope it releases, and
  it is durable: it survives restart, it is recorded with the numbers that were
  observed at the time, and it re-baselines that scope so the same price does
  not immediately re-trip. A release is per-scope; releasing one model never
  releases another.
- The whole behavior is configurable and **enabled by default**. The threshold
  ratio, the minimum baseline sample count, the confirming-observation count,
  the baseline window, and the scope granularity are settings with efficient
  defaults. Disabling the detector is an explicit operator choice, never a side
  effect of another setting.
- Every projection of an anomaly -- warning text, typed error, ledger line,
  durable block record -- carries identifiers and numbers only: provider, model
  name, scope label, rates, ratio, counts, timestamps. Never a credential, an
  account identifier, a prompt, file contents, or a raw provider response body.
- Detection and blocking are headless core behavior. CLI, console, and any
  external front render and transport the same structured state; a front must
  not implement its own threshold, and must not be able to start a blocked run
  by bypassing the core.

## Sources

The operator's 2026-09-14 rule: warn on a sharp jump in per-request model cost,
block new runs until explicitly allowed, optional, default on, configurable.

Per-unit price rather than per-run total, because a run's total legitimately
varies with the size of the task while its rate should not. Blocking new runs
rather than killing in-flight ones, because the committed cost of a running
stage is not recoverable. Explicit release with re-baselining, because a
permanent provider reprice is a fact to accept once, not an alarm to dismiss on
every subsequent run.

The append-only `price` economic records of the configuration contract are the
natural durable home for a confirmed re-baseline: a release is a confirmed price
change, and confirmed changes append history rather than rewriting it.
