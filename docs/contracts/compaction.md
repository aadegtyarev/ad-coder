# Context compaction contract

This contract governs how ad-coder shrinks a conversation that no longer fits
its context budget. It binds every role turn, whether it runs through `runRole`
(src/runner/runner.ts) or a multi-turn conversation
(src/conversation/conversation.ts), and it is the same policy in both.

- A compaction is a DURABLE write, not a request rewrite. The harness
  (pi-agent-core) decides when to compact, cuts the branch at
  `keepRecentTokens`, and commits a `compaction` entry whose summary REPLACES
  the summarized prefix for every later request. ad-coder owns the summary
  behind that entry, through the `before_compaction` hook. Rewriting one
  request's message list in flight is not compaction: the session stays over
  budget and the next request pays the same cost again (issue #444).
- The two thresholds must agree. The harness fires above
  `contextWindow - reserveTokens`; ad-coder's policy fires at
  `maxTokens - reserveTokens`. The harness reserve is therefore DERIVED as
  `contextWindow - (maxTokens - reserveTokens)` and clamped at zero -- never a
  copy of the role's own reserve, and never negative. `keepRecentTokens` maps
  verbatim: it is the same idea in both.
- The summary request carries DIALOGUE HISTORY ONLY: the prepared eviction set,
  the split-turn prefix, and the previous summary as an instruction. The role's
  system prompt, its tool descriptions and its skills catalogue are NOT part of
  it. Those are the byte-identical cacheable prefix, and rewriting them would
  cost the prompt cache on every turn -- the opposite of what compaction is for.
- Continuity is the summarizer's contract with its caller: the previous summary
  is passed in and must be folded into the new one. `messagesToSummarize` starts
  after it, so a summarizer that ignores the argument silently drops everything
  older than the current window -- the task, its acceptance criteria, and every
  path the run had established.
- The previous summary rides the summarizer's SYSTEM prompt, never the message
  list. It is an instruction about what the summary has to preserve, not a turn
  anyone took, and a later turn must not be able to read it as operator input.
- A summary is DATA. It is model output over a transcript that may itself carry
  instructions from files, tool results or a provider. It preserves prior
  operator requirements but never authorizes commands, secret access, external
  disclosure, tool use, or policy changes; roles are told exactly that
  (`COMPACTION_SAFETY_PROMPT`), and the entry is attributed as history.
- A summary carries the file-operation lists upstream appends
  (`<read-files>` / `<modified-files>`), because the NEXT compaction reads those
  lists back off the entry's `details`.
- The hook has exactly three answers, and which one it gives IS the policy.
  (a) A summary, which the harness commits. A failed configured summarizer is
  retried up to its configured limit and, when enabled, retried with the role's
  model under the configured output cap. (b) Nothing (`undefined`) allows
  pi-agent-core's emergency structural generation after both enabled routes
  fail, or when an overflow or manual compaction has no evictable messages;
  its length recovery must remain available (issue #368). (c) `{decline: true}`
  when role-model fallback is explicitly disabled and the configured route
  fails, the provider is unavailable (a typed admission or quota refusal must
  reach the caller intact), or a THRESHOLD compaction has nothing evictable.
  `undefined` with fallback disabled would silently invoke the role's model.
  A decline on an overflow or manual compaction settles the run as
  `compaction_declined`; on a threshold the run may continue beneath the model's
  physical window.
- A hook must not THROW. The harness's structural generation is outside the
  catch that recognises its own cancellation, so a raw provider error raised
  from here is wrapped as a harness fault and destroys the typed refusal it was
  carrying. An expected failure is an answer, not an exception.
- Every summarizer failure is announced, once per attempt, with names and
  numbers only: error class, stop reason, numeric status, provider code token,
  summarizer provider/model, measured tokens, threshold. Never the thrown
  message -- a provider error's text can carry the request it rejected, and the
  evicted head IS conversation. The success line follows the same rule: how many
  messages were replaced, what was measured, what the threshold was.
- When the harness's own compaction fails outright, the run settles as failed
  and ad-coder types it: `summarization_failed`, `compaction_declined` and
  `structural_interrupted` map to `ContextCompactionLostError` (a
  `ContextBudgetError`), whose advice is to restart the session and reopen it
  from its durable state (`--resume`), never to retry a prompt that cannot
  succeed. The stop is sticky for that session: a later turn refuses without
  dispatching, because the context is still over the threshold and the same
  operation would fail the same way.
- That stop is classified at the SETTLED-RUN boundary, before any empty-answer
  projection. A run that fails on turn N leaves turn N-1's answer as the newest
  assistant message, so a check nested under "the answer is empty" would report
  the failed run as a completed one.
- The summarization request asks for NO prompt cache. Its input is discarded the
  moment the summary replaces it, so nothing can ever read that cache entry
  back, and the write premium would be pure loss. A role turn is the opposite
  case and keeps its configured retention.
- `disabled-then-halt` compacts nothing: no threshold fires, no entry is
  committed, and the pre-flight refuses a turn the full branch cannot hold.
  `cache-aware` is not implemented and must fail loudly rather than be silently
  treated as `auto`.
- The summarizer is a generation path: it passes the same admission, session
  limit and cost boundaries as a role turn, and a custom summarizer is refused
  where the configured limits cannot be applied to it.
- Which model summarizes is configuration: it defaults to the role's own model,
  a different provider needs explicit authorization, and the summarizer's window
  must cover every reachable model's window.

A role with a 200k window on the shipped default budget (180k max, 20k reserve)
compacts at 160k tokens. The harness reserve is derived as
`200k - (180k - 20k) = 40k`, so the harness threshold is also 160k: one entry is
committed at that boundary, and every later request is built from it instead of
from the raw transcript.
