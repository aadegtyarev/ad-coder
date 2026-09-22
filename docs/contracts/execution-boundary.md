# Execution boundary contract

This contract owns how role tools execute code, subprocesses, files, and network
effects on the host.

## Guarantees

- `execution.mode` defaults to `open`: tools run with the invoking user's host
  authority. It is not a sandbox, chroot, filesystem boundary, or egress policy.
  The resolved mode and its source are visible before a mutable dispatch.
- Open mode has a configurable, enabled-by-default destructive-command guard.
  It refuses only unmistakably broad destructive commands aimed at `/` or a
  configured protected ancestor; it is a convenience rail, not a security
  control. Shell interpretation, alternative programs, and user-authorized
  scope can bypass such pattern checks, so no protection claim follows from it.
- Every built-in and module-provided tool that can read, write, spawn, or reach
  the network receives an `ExecutionBoundary` capability, not direct host
  construction. The boundary creates the execution environment, applies the
  selected policy, and emits durable external-action identity. Roles, fronts,
  workflows, and modules cannot select a weaker boundary for one invocation.
- A future sandbox is an execution-boundary provider selected by settings. It
  must enforce its declared filesystem, process, and network controls outside
  model text, report unavailable host support before dispatch, and fail closed
  rather than silently falling back to `open`.
- A future LLM guard may be an optional, explicitly labelled policy layer after
  the sandbox. It can assist or make configured allow/refuse decisions but is
  never described as isolation or the only security boundary; deterministic
  policy and the sandbox remain authoritative.

## Verification

Test visible open-mode disclosure, direct broad-destruction refusal, documented
guard bypass classification, one shared boundary for standalone and conversation
runs, module capability confinement, sandbox-provider refusal without host
support, and no silent fallback from a selected sandbox.

## Related surfaces

- [Security](security.md) owns trust and authority claims.
- [Extension modules](extension-modules.md) owns boundary providers.
- [Role and tool wiring](role-tools.md) owns tool registration.
- [Lifecycle hooks](hooks.md) owns external-action observation.
