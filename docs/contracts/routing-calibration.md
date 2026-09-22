# Routing calibration contract

This contract owns portable evidence and bounded adaptation that make an
operator-authorized model route cheaper and more effective over real work.

## Guarantees

- A calibration names one `models.yaml` profile source. Its identity includes
  source kind and name, never an inferred bare name. Membership is validated
  against the profile before a snapshot is written or applied.
- A project may commit bounded anonymous `.ad-coder/calibration.json` routing
  overrides. It applies only when its named source matches the resolved profile;
  otherwise the operator's route remains authoritative.
- User profile export and import are versioned and validate before atomic
  mutation. They may contain routing calibration, confirmed economic history,
  and safe capacity estimates, but never credentials, account identity, raw
  provider responses, transcripts, or inventory definitions.
- Observations are keyed by role, assessed complexity, effort/cache policy, and
  `provider:model` route. They measure accepted-result cost: billing or estimate,
  tokens, elapsed time, rounds, retries, review outcome, quality gates, capacity,
  and recovery cost. They retain no task text, prompts, source content, account
  identity, or raw provider response.
- Confirmed price, capacity, credit, subscription, quality, and outcome
  observations append history rather than rewrite it. Facts retain scope,
  timestamp, units, source, confidence, and whether they are estimated or billed.
- A snapshot derives economic facts declared in its source profile without
  inventing absent values. A directly observed record with the same fact identity
  wins over the derived value. Derived facts are labelled estimated.
- One completed run is a sample, not a route verdict. Calibration aggregates
  comparable outcomes under configurable minimum-evidence, recency, variance,
  and regression bounds; failed, rejected, and interrupted work contributes to
  the route's cost rather than disappearing from the sample.
- The default adaptive policy may reorder only existing, operator-authorized
  ladder rungs for a role/complexity after sufficient evidence shows a cheaper
  accepted result. It never adds a provider/model, defeats an explicit pin,
  loosens quality/review, or promotes a route across a configured safety bound.
  Each applied adjustment is durable, inspectable, announced in the session
  summary, and reversible to the declared ladder order.
- The calibration distinguishes API-money cost from subscription allowance and
  local-resource capacity. It optimizes the scarce resource actually consumed,
  while preserving both measures where known for comparison.
- Routing research and calibration evidence that can affect selection is durable,
  source-linked, bounded, and portable. Required bootstrap research briefs are
  trusted, versioned by identifier and digest, and fail before dispatch when
  missing or empty. Research seeds an estimate; recorded project outcomes correct
  it without overwriting the operator's baseline.

## Failures

An unknown source, incompatible snapshot, invalid import, unservable calibration
cell, or insufficient/unsafe evidence is rejected before it affects routing.
Legacy inventory-backed calibration is refused with the current profile-snapshot
command. The declared ladder remains active with a visible reason.

## Verification

Build a profile snapshot against the selected `models.yaml` profile and verify
source matching, fact precedence, failed-run attribution, comparable-sample
selection, bounded in-ladder reorder, rollback, summary visibility, and import
atomicity.

## Related surfaces

- [Routing configuration](routing-config.md) owns the source model profile.
- [Cost anomaly](cost-anomaly.md) owns anomalous-charge release evidence.
- [Stage-limit calibration](stage-limit-calibration.md) owns learned limits.
- [Task estimation](task-estimation.md) owns per-dispatch forecast.
- [Provider admission](provider-admission.md) owns live capacity control.
