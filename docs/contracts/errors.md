# Error behavior contract

For library, CLI, workflow, provider, and tool authors, this contract answers: how
does a failed operation remain understandable and actionable to humans and stable
for machines?

- Every expected boundary failure has a stable typed code or discriminated result.
  Human text names the failed operation and the next useful action without requiring
  a stack trace or source-code knowledge.
- Distinguish invalid input, missing configuration or credentials, denied policy,
  provider rejection, timeout, cancellation, exhausted limits, unavailable service,
  and internal defects. Do not collapse them into an empty result or generic
  `failed` message.
- A CLI failure writes concise diagnostics to stderr and exits non-zero. Machine
  modes preserve a stable structured error shape; progress and diagnostics never
  corrupt result stdout.
- Preserve the causal error for programmatic callers while projecting only safe
  fields across human, model, ledger, and durable-state boundaries. Never include
  credentials, secret values, prompts, file contents, or uncontrolled response
  bodies in an error.
- Catch an error only to recover, add safe context, translate it at a boundary, or
  release resources. Silent catches and success-shaped fallbacks are violations.
- Test failure output and recovery instructions as public behavior. Provider
  timeout, cancellation, and retry behavior must be explicit and configurable;
  automatic retry is never inferred for a potentially non-idempotent operation.
