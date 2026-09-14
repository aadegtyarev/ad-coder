# Provider admission contract

This contract governs the headless `ProviderAdmissionController`: the shared
provider-capacity boundary for every LLM request. It is independent of a
conversation, a SessionManager front, and a provider transport. A SessionManager
owns and supplies it in normal managed operation; standalone callers may supply
the same programmatic boundary.

- Admission is keyed by the effective provider capacity scope: provider plus
  credential/account scope and any provider-documented capacity partition. It
  must never use the secret credential itself as a key or persist it.
- A session has one ordered interactive turn stream, but independent sessions
  may execute concurrently after admission. Physical HTTP/WebSocket connection
  reuse is a transport concern and must not decide concurrency.
- Every LLM generation path passes through admission, including role turns,
  tool-follow-up generations, background pipelines, resume, and asynchronous
  title generation. A front must not bypass it by opening its own provider
  client.
- Per-scope concurrency, queue capacity, fairness/aging, priority classes,
  retry policy, and provider cooldown behavior are configurable. Defaults must
  be finite and efficient. An interactive user turn outranks background work;
  title generation is lowest priority and is deferred rather than competing with
  waiting user work.
- A request that cannot receive a permit is queued, not falsely reported as
  failed. Its safe status includes provider scope label, queue position or
  bounded state, and a supported cancel/wait action. Queue saturation returns a
  typed actionable resource-limit failure.
- A structured provider-capacity rejection (`provider_limit`, including 429)
  releases its permit and creates a scope-wide cooldown until the bounded
  `Retry-After`/reset hint, or the configured retry delay, expires. During that
  cooldown no queued request may probe the provider. The controller resumes
  fairly afterwards; it never creates a retry storm.
- Admission status, cooldown, cancellation, and terminal outcome are durable
  wherever a request is durable. After restart, a queued or paused durable run
  remains inspectable and resumable/cancellable; an uncertain in-flight request
  is never silently duplicated.
- The public failure projection contains a stable `code`, concise safe human
  text, `retryable`, and at least one next action when recovery exists. CLI
  machine output retains this shape on stderr and exits non-zero. It never
  exposes credentials, account identifiers, prompts, files, raw provider bodies,
  or internal transport errors.
- Cancellation while queued removes only that request. Cancellation after a
  permit is admitted follows the existing durable turn/run cancellation policy;
  it must release the permit exactly once.

For a provider limit of three, the controller admits at most three requests in
that scope. A fourth becomes visible as queued; a 429 closes the shared gate,
rather than making each session independently retry.
