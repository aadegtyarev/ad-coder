# Quality bootstrap contract

This contract owns establishing project quality gates before code is changed.

## Guarantees

- `quality.bootstrap.enabled` defaults to enabled. After local stack detection
  and before the first code mutation in a project without a verified quality
  profile, the orchestrator asks the operator whether to configure one. An
  explicit project setting overrides the profile default; a recorded decline is
  visible and never mistaken for configured gates.
- The built-in `quality-bootstrap` workflow first uses the researcher to select
  a stack-appropriate profile from local evidence and, when available, bounded
  current research. Its proposal names the detected stack, commands, required
  tools, configuration files, expected cost/effects, and evidence. It covers a
  unit-test runner, formatter, linter/static analysis, build or type checking,
  and applicable dependency/security checks; unsupported categories are named.
- After approval, the `quality-bootstrapper` role inventories installed tools,
  writes only the approved project configuration, and validates the gates. It
  may install an approved tool only through the normal explicit external-effect
  authority. It never silently runs a package manager, downloads a binary, or
  changes a lockfile.
- With unavailable network research, the workflow reports `network_unavailable`
  without guessing a current tool. It offers: operator-supplied gate commands;
  a local installed-tool inventory and generated profile; or a deferred explicit
  bootstrap run when research becomes available. Code remains awaiting the
  operator's quality decision rather than claiming a profile exists.
- A verified profile is durable, versioned, and visible in session inspection.
  Its declared argv gates run after coding and before required review. A failing
  or missing gate blocks settlement as defined by [quality](quality.md); an
  unsupported project never receives an invented success-shaped check.
- A detected change to language, build system, framework, component, dependency
  class, or test surface marks the profile `stale`. Before the next related code
  mutation, the workflow proposes and revalidates the affected strategy under
  the same operator-installation authority. A prior green gate does not certify
  a stale profile.
- Operator controls and the machine API can show status, propose, approve,
  decline, inventory, and revalidate the profile. The orchestrator receives the
  same headless operations and role results; all actions retain durable evidence
  and resume safely.

## Verification

Test detected and unknown stacks, first-mutation decision gating, project-over-
profile precedence, approved and declined paths, no-install without authority,
offline local inventory, generated profile validation, failing gates, resume, and
TUI/API/orchestrator parity, and stale-profile detection/revalidation after a
stack or framework change.

## Related surfaces

- [Quality](quality.md) owns gate execution and review blocking.
- [Role catalog](role-catalog.md) owns built-in role identity.
- [Configuration](config.md) owns settings precedence.
- [Security](security.md) owns network and installation authority.
- [Runtime inspection](runtime-inspection.md) owns profile projection.
