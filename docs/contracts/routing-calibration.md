# Routing calibration contract

This contract owns portable evidence that adjusts an operator's model routing.

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
- Confirmed price, limit, and credit observations append history rather than
  rewrite it. Facts retain scope, timestamp, units, source, and confidence.
- A snapshot derives economic facts declared in its source profile without
  inventing absent values. A directly observed record with the same fact identity
  wins over the derived value. Derived facts are labelled estimated.
- Routing research and calibration evidence that can affect selection is durable,
  source-linked, bounded, and portable. Required bootstrap research briefs are
  trusted, versioned by identifier and digest, and fail before dispatch when
  missing or empty.

## Failures

An unknown source, incompatible snapshot, invalid import, or unservable
calibration cell is rejected before it affects routing. Legacy inventory-backed
calibration is refused with the current profile-snapshot command.

## Verification

Build a profile snapshot against the selected `models.yaml` profile and verify
source matching, fact precedence, and import atomicity.

## Related surfaces

- [Routing configuration](routing-config.md) owns the source model profile.
- [Cost anomaly](cost-anomaly.md) owns anomalous-charge release evidence.
- [Stage-limit calibration](stage-limit-calibration.md) owns learned limits.
