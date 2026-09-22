# Routing configuration contract

This contract owns the operator-authored model route and credentials vocabulary.

## Guarantees

- `models.yaml` is the only stored routing source. It declares providers, their
  enabled state, endpoint, credential source, models, profiles, and optional
  default profile. Legacy JSON inventories are neither read nor migrated; a
  request that names one is a typed refusal.
- An enabled provider has a resolvable endpoint and credential. A credential is
  an environment-variable name or the reserved literal `oauth`; oauth delegates
  to the provider's OAuth factory and does not expose a token as an environment
  variable. `ad-coder auth` supports every declared env-var provider.
- Model rows declare input and output price and may declare cache prices,
  context window, output `maxTokens`, and provider-native `id`. The row key is
  the route name; native id is sent to the provider and scopes ledger and charge
  records. Native ids are unique within a provider.
- A profile maps role or `role@complexity` to an ordered provider:model ladder;
  the tier-specific row replaces that tier. Current dispatch serves the first
  rung. A present unusable YAML file fails rather than falling back silently,
  and the chosen source/profile is visible at startup and in configuration.
- Every routing role has a measurable profile cell. A newly introduced role may
  temporarily use its prior route with a visible warning; an absent cell for an
  established role is an error. `defaultComplexity` is routing fallback, not a
  task assessment. The summarizer is a routing role and accepts a one-run model
  override.
- Coder and Reviewer use different model families at the same complexity when
  the inventory permits. If no second family exists, use distinct appropriate
  variants and record the unsatisfied constraint; an Auditor is not part of this
  pairing rule.
- Role-model overrides compose with the selected profile. An unknown override
  names both model and profile in a typed `unknown_model` error.

## Configuration

Provider and model fields, profile ladders, per-role overrides, and explicit
configuration paths are configured through `models.yaml` and the routing CLI
flags. See [configuration](config.md) for precedence and worker inheritance.

## Verification

Validate a route before dispatch, print its resolved source and role mapping,
and test both direct and detached-worker resolution after changing YAML parsing,
credentials, aliases, or profile selection.

## Related surfaces

- [Configuration](config.md) owns shared precedence and worker transport.
- [Routing calibration](routing-calibration.md) owns persisted routing overrides.
- [Cost anomaly](cost-anomaly.md) owns billed-price comparison.
