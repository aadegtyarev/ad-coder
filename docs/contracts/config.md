# Configuration contract

This contract owns shared behaviour settings and how their effective value is
resolved. It does not own model routing; see [routing configuration](routing-config.md).

## Guarantees

- Every parameter or flag that changes behaviour is a setting with an efficient
  default; no behaviour-changing source constant or CLI-only switch is allowed.
  Resolution is built-in default, user profile, project override, then explicit
  launch override. The effective configuration makes each value and source
  visible through the grouped settings interface.
- Numeric resource limits default to `0` and `0` disables them, unless their
  owning contract declares a positive safety ceiling or an immediate-action
  meaning. Values that change behaviour are not hidden source constants.
- Stage budgets accumulate across durable resume. Four independently configurable
  final-response reserves default to 12 model turns, 90 seconds, 24 tool turns,
  and 300,000 reported input tokens; zero disables each. On reserve entry,
  ordinary tools are refused and generation is told to close out, while granted
  workflow submission tools remain available.
- A switchable shipped capability is enabled by default and can be overridden by
  persistent setting and explicit launch parameter; the latter wins. A set-valued
  capability supports selecting and excluding members. A capability that cannot
  be disabled at both layers needs an explicit safety or cost exception.
- `orchestration.directEdits` is `off` or `reviewed`; `reviewed` permits the
  orchestrator's recorded small-edit judgement only with independent review.
  Required roles and the context-output delegation threshold are independently
  configurable. Profile values supply defaults and project values override them;
  effective values and sources are visible before dispatch and in configuration
  output.
- Explicit launch selections cross every detached-worker boundary verbatim:
  capability choices, routing/config paths, profile or registry selections,
  credential path, and provider pin. Absent flags remain absent; a credential
  path is never persisted in profile or run data.
- A malformed present `settings.yaml` fails loudly; an absent file uses defaults.
  Its review settings resolve once and apply equally to stamp writing and checking.
- Declared pipeline quality gates replace the built-in list as data, validate
  before dispatch, and have a positive non-zero output capture ceiling.
- `quality.bootstrap.enabled` defaults to enabled. Its proposal/installation
  authority, network research allowance, and saved project decision follow
  standard settings precedence; a project setting overrides the profile value.
- Hook enablement, order, scope, and resource limits are declared settings with
  the same profile/project/launch precedence; see [lifecycle hooks](hooks.md).
- Cost-reference precedence, catalogue refresh/cache policy, observed-price
  overlay aggregation and retention, variance notices, and provider/model
  tolerances are settings; see [cost anomaly](cost-anomaly.md).
- Documentation language and selected project-practice bundles are settings;
  see [documentation](documentation.md) and [project practices](project-practices.md).
- Durable-state backend, checkpoint cadence, retention, integrity validation, and
  recovery limits are settings; see [resumability](resumability.md).
- Pipeline change-context strategy, limits, widening triggers, redaction, and
  full-context fallback are settings; see [built-in pipeline context](builtin-pipeline-context.md).
- Route capacity ceilings, queue policy, adaptive learning/probing, routing-ladder
  fallback policy, and forge delivery-summary publication are settings; see
  [provider admission](provider-admission.md), [routing configuration](routing-config.md),
  and [product changes](product-change.md).
- Execution mode, destructive-command guard, protected roots, and a selected
  sandbox or optional LLM-guard provider are settings; see
  [execution boundary](execution-boundary.md).
- Set-valued configuration reports enabled/disabled state and count, including
  member ids only within the documented line budget. A missing renderer branch
  fails loudly by key rather than exposing an object representation or its value.

## Failures

Invalid setting values and an explicitly pinned route that cannot resolve fail as
typed errors before provider dispatch. A background worker never silently
substitutes an unpinned provider for an explicit selection.

## Verification

`ad-coder api settings` exposes effective values and source by group. Exercise
both TUI and detached-worker paths when adding a setting or changing precedence.

## Related surfaces

- [Routing configuration](routing-config.md) owns `models.yaml` and model choice.
- [Routing calibration](routing-calibration.md) owns portable routing evidence.
- [Compaction](compaction.md), [wake delivery](wake-delivery.md), and
  [quality](quality.md) own their specific ceilings.
- [Extension modules](extension-modules.md) owns optional module capabilities.
- [Quality bootstrap](quality-bootstrap.md) owns project gate bootstrap.
- [Settings interface](settings-interface.md) owns settings discovery and editing.
- [Lifecycle hooks](hooks.md) owns hook-specific settings.
- [Execution boundary](execution-boundary.md) owns execution settings.
