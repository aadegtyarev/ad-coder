# Configuration contract

This contract owns shared behaviour settings and how their effective value is
resolved. It does not own model routing; see [routing configuration](routing-config.md).

## Guarantees

- Any behaviour a reasonable user may want to change is a setting with an
  efficient default. Resolution is built-in default, user profile, project
  override, then explicit launch parameter. The effective configuration makes
  each value and its source visible; a human `config show` row is
  `name=value (source)`, and JSON reports the same resolved state.
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
- Explicit launch selections cross every detached-worker boundary verbatim:
  capability choices, routing/config paths, profile or registry selections,
  credential path, and provider pin. Absent flags remain absent; a credential
  path is never persisted in profile or run data.
- A malformed present `settings.yaml` fails loudly; an absent file uses defaults.
  Its review settings resolve once and apply equally to stamp writing and checking.
- Declared pipeline quality gates replace the built-in list as data, validate
  before dispatch, and have a positive non-zero output capture ceiling.
- Set-valued configuration reports enabled/disabled state and count, including
  member ids only within the documented line budget. A missing renderer branch
  fails loudly by key rather than exposing an object representation or its value.

## Failures

Invalid setting values and an explicitly pinned route that cannot resolve fail as
typed errors before provider dispatch. A background worker never silently
substitutes an unpinned provider for an explicit selection.

## Verification

`ad-coder config show` exposes effective values and source. Exercise both console
and detached-worker paths when adding a launch setting or changing precedence.

## Related surfaces

- [Routing configuration](routing-config.md) owns `models.yaml` and model choice.
- [Routing calibration](routing-calibration.md) owns portable routing evidence.
- [Compaction](compaction.md), [wake delivery](wake-delivery.md), and
  [quality](quality.md) own their specific ceilings.
