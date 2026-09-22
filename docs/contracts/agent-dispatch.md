# Agent dispatch contract

This contract owns running a named role or an ad-hoc agent as foreground or
background work.

## Guarantees

- An operator and the orchestrator can launch a named built-in or custom role in
  the background. Launch returns a durable run identity immediately; it does not
  block subsequent input, status, cancellation, or independent launches.
- Background work has the same durable lifecycle, ledger, provider admission,
  cancellation, wake, and terminal outcome as foreground work. Its progress is a
  projection, never a reason to consume or block the interactive input lane.
- An ad-hoc agent accepts an explicit task prompt without first creating a named
  role. It is durable and attributable as an ad-hoc dispatch, but does not add a
  role to the catalog or alter later dispatches.
- Every dispatch records initiator, prompt source, selected model, tool grant,
  target, budget, ceilings, and external-effect authority. The orchestrator may
  choose any model reachable in the selected profile; an operator may require a
  particular reachable model. An unavailable requested model fails loudly.
- Every terminal outcome is published to the orchestrator according to
  [orchestrator run observation](orchestrator-run-observation.md), independently
  of the initiating front.
- An ad-hoc agent and a custom role use the profile's `agents.defaultModel` when
  no explicit choice is supplied. A selected model remains subject to provider
  admission, cost controls, and all granted-authority boundaries.
- Independent agents may run concurrently only when their targets and mutable
  scope satisfy [delegation](delegation.md). A launch that would conflict is
  queued or refused with a recovery action; it is never silently serialized behind
  an unrelated interactive turn.

## Configuration

Agent default route, allowed profile models, default custom-role grants, and
background capacity are independently configurable. Explicit operator selection
wins over an orchestrator choice and the profile default.

## Verification

Test immediate non-blocking launch from TUI and orchestrator, durable recovery,
foreground/background parity, ad-hoc catalog non-mutation, route precedence,
unreachable-model refusal, concurrent independent work, and conflicting-target
handling.

## Related surfaces

- [Role catalog](role-catalog.md) owns reusable prompt identities.
- [Routing configuration](routing-config.md) owns profile model availability.
- [Provider admission](provider-admission.md) owns capacity.
- [Wake delivery](wake-delivery.md) owns completion notification.
