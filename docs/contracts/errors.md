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
- Public error projections expose a stable `code`, concise safe text,
  `retryable`, and a next action whenever recovery exists. New front/API work
  must use this shape rather than inventing an untyped string. CLI exit-code
  categories are part of the compatibility surface and are tested when added or
  changed.
- A front handles EVERY typed error its surface can raise: each typed failure gets
  its own branch that names what happened and the action that clears it, in that
  front's rendering. Falling through to a generic "operation failed" is a
  violation, and so is advising a retry the typed error already knows cannot
  succeed. When the action is reachable in the current session, the front offers
  it there rather than sending the operator to another front.
- Preserve the causal error for programmatic callers while projecting only safe
  fields across human, model, ledger, and durable-state boundaries. Never include
  credentials, secret values, prompts, file contents, or uncontrolled response
  bodies in an error. ONE recorded exception: a durable pause cause for code
  `untyped_error` may carry the bounded, redacted first line of an otherwise
  unclassified error's own message (see the 2026-09-19 issue #403 entry below);
  model text and provider response bodies stay out beyond that bounded first
  line, which is quoted as untrusted data, never instructions.
- Catch an error only to recover, add safe context, translate it at a boundary, or
  release resources. Silent catches and success-shaped fallbacks are violations.
- Test failure output and recovery instructions as public behavior. Provider
  timeout, cancellation, and retry behavior must be explicit and configurable;
  automatic retry is never inferred for a potentially non-idempotent operation.
- 2026-09-16: A rejection carries the reason, not only the code, and a boundary
  that translates an error keeps the causal detail. A model holding
  `invalid_follow_up` cannot tell which field it got wrong, so its only move is
  to call again unchanged: observed as four identical rejections in a row until
  the stage limit ended the run, with the failure then surfacing as a provider
  fault while the provider was answering normally. The same day, a person was
  told `calibrated routing profile is invalid` when the validator underneath knew
  the file and the retired role that caused it. The validator's own sentence is
  the actionable part and must reach the caller -- `code: message`, never `code`
  alone -- whether that caller is a model or a human. Re-wrapping a typed error
  in a vaguer one discards the only part worth having.
- 2026-09-17: A permission failure gets permission advice, not path advice.
  The `/task` boundary had collapsed every unreadable reason into one
  `task_file_unreadable` code whose only action was "check the path and
  retry" -- the same defect class as 2026-09-16's swallowed cause one boundary
  up: a person whose file exists but denies read permission was told the one
  action that cannot fix EACCES, and a missing file was indistinguishable
  from a denied one. The errno class is kept as its own stable code
  (`task_file_not_found`, `task_file_denied`, `task_file_is_directory`, and
  `task_file_unreadable` with the errno token in the message for anything
  else), and the action follows from the class: a permissions failure names
  checking permissions, never re-checking the path. The file byte ceiling is
  also applied against a stat BEFORE the read, so the limit that bounds the
  read acts before the read instead of after an unbounded block.
- 2026-09-17 (issue #231): A failed `edit` call is self-serviceable INSIDE one failing call. The not-found error said
  the text
  must match exactly but not where the file's equivalent region sat, so the measured model's cheapest move after a
  failure was an invisible `sed -i` from bash -- no path, no diff, no observability. Now a not-found failure names the
  file's closest matching region (line and similarity, `close` vs. stale) and a non-uniqueness failure names bounded
  occurrence line numbers, each with one recovery sentence: read the named region, rebuild oldText from what the file
  contains, retry the EDIT. The evidence never includes file content, and it is skipped -- the unenriched upstream
  error passes through -- when the file cannot be read or exceeds the positive diagnostic read ceiling, because advice
  invented without evidence misdirects the retry more than no advice at all.
- 2026-09-17 (issue #237): A translating boundary never answers an unrecognised
  error with silence. The orchestration tool boundary collapsed every error not
  carrying a `code`+`detail` pair into a fixed string
  (`an unexpected internal error occurred`), so two independent diagnoses of
  the same defect each had to patch the boundary by hand to learn its one-word
  cause (`configured_tools_unavailable`, then `EmptyTurnError`) -- and after
  #236's deterministic fix, two of five intermittent delegated `run_role`
  failures remained undiagnosable behind the same line. Now the boundary
  projects in three ordered shapes, each safe by construction: the
  `code`+`detail` passthrough is unchanged; house classes whose message is an
  AUTHORED string (fixed wording, numbers, a validated run id, a harness
  failure-code token) are matched BY CLASS and keep it
  (`error: code (message; run <id>)`); an unrecognised error still names its
  inert constructor (`(TypeError)`) -- the one word that ends the
  investigation -- while its message, stack, and payloads stay withheld. A new
  class enters the allow-list only after a field-by-field audit of its message
  sources; `WorkflowStageFailureError` is excluded because its message re-wraps
  an uncontrolled source error. Deferral suspensions are typed
  (`SuspendedRunError`, `run <id>`) instead of bare `Error`s, so an
  intermittent empty read is now distinguishable -- by code, message, and the
  run id that locates the ledger -- from a tool-availability failure, a
  provider rejection, and a rate limit.
- 2026-09-19 (issue #356): A provider quota/rate-limit refusal (HTTP 429) is
  its own typed classification, distinct from `provider_rejected`, from
  `empty_turn`, and from a structured capacity signal. A structured 429 (a
  `status`/`statusCode` field, or a `Retry-After` header via the after-response
  hook) is `ProviderLimitError` (`provider_limit`, an optional bounded
  `retryAfterMs`). A message-embedded 429 -- pi-agent-core composes
  `providerError` as `{ code, message }` with no status field, so the status
  lives only in the message body -- is `ProviderQuotaError`
  (`provider_quota`), read at the settled-error boundary BEFORE the empty-turn
  fallback can misattribute it as an authentication failure. The quota error
  carries only bounded fields verbatim: the literal HTTP status (429), the
  provider's own error code/type as a strict-charset token
  (`[A-Za-z0-9_.-]{1,64}`, length-capped -- an OpenAI `type`/`code` or an
  Anthropic nested `type`; the bare envelope discriminator `"error"` is
  skipped), and a reset window as a safe-integer millisecond delay bounded by
  `MAX_PROVIDER_RETRY_HINT_MS`. The response body is otherwise never
  propagated: message prose, URLs, and uncontrolled values stay in the body
  they came from. The advice is retryable but NOT now -- wait for the reset
  window, or check the plan and usage -- never "verify authentication" and
  never "inspect the request". `401`/`403` remain `EmptyTurnError` (credential
  wording), `400`/`404`/`405`/`409`/`413`/`415`/`422` remain
  `ProviderRejectionError`, preserving the refusal-vs-credential distinction
  the 2026-09-16 entry required.
- 2026-09-19 (issue #368): A settled turn whose final assistant message
  carries no answer text and no tool call is not an empty success. Two shapes
  reach the caller as `GenerationTruncatedError` (`generation_truncated`): a
  turn the output-token limit cut off mid-thinking (the provider answered, so
  the turn settled `completed` and every settled-FAILURE classification was
  gated behind a status check that never fired -- the whole budget spent on
  reasoning, discoverable only by reading the raw session jsonl), and a
  length stop pi-agent-core compact-and-retried into a second truncation
  (settled `failed` with the generic `assistant_error`, which the empty-turn
  fallback had misread as "verify authentication"). The error carries only
  bounded fields, each dropped unless it matches: the provider's own stop
  reason as a strict-charset token (`[A-Za-z0-9_-]{1,32}`, e.g. `length`), and
  the truncated message's output/reasoning token counts as safe non-negative
  integers. The thinking prose and every other transcript value never cross:
  they stay in the session. Only BOUNDED silence classifies: a text block (even
  a partial one) or a tool call is usable content and stays today's behavior;
  an `error`/`aborted`/`pending` stop is a failure marker owned by the
  existing classifications (the one exception is pi-agent-core's exact
  length-recovery marker, an error-stopped bookkeeping for a generation that
  ran twice and answered neither time). The advice is retryable but NOT as-is:
  the same output budget truncates the same reasoning-heavy turn again, so the
  remedy is a raised output budget or bounded thinking, then retry -- never
  "verify authentication" and never a blind retry.
- 2026-09-19 (issue #391): A session whose context can no longer be compacted
  stops with the action that exists, and the failure that caused it is
  attributed rather than swallowed. `transform_context` is non-throwing by
  design -- a summarizer failure passes the turn through UNCOMPACTED and lets
  the pre-flight decide -- so the guard meant to prevent repeated attempts was
  refusing exactly the context the failed compaction left behind, on every
  later turn, in milliseconds and with no model call. The failure record lives
  on the compactor, which is created once per conversation, so one transient
  provider refusal was sticky for the whole session and only a relaunch cleared
  it; the summarizer's own error was dropped (`void error`), so nothing ever
  said which model refused or why. Three rules follow. (1) The refusal is
  BOUNDED, not permanent: `COMPACTION_ATTEMPT_LIMIT` (2) attempts, so one
  transient error is not a verdict on the session, and a later success clears
  the record. (2) Every failure is ATTRIBUTED, never quoted: attempt, error
  class name, provider stop reason, numeric HTTP status, provider code token,
  provider/model, and the measured/threshold token numbers -- each read from
  the error object's own fields and dropped unless it matches a strict
  machine-safe charset, never parsed out of the message. `createSummarizer`
  raises `SummarizerUnavailableError` carrying `oversized`, `provider_error`,
  `aborted`, or `empty_summary`, plus the provider and model, so "which
  summarizer refused it" is answerable from the projection. (3) The terminal
  condition is its own typed stop, `ContextCompactionLostError` (a
  `ContextBudgetError`, so existing budget handling keeps working), whose
  advice replaces the default "then retry" tail: retrying the same prompt
  cannot succeed, so the action is to restart the session and reopen it from
  its durable state (console: `--resume`), choosing a different summarizer
  model when the summarizer itself is what failed. The console renders its own
  branch and exits with reason `context_compaction_lost`, `retryable: false` in
  JSON mode. Provider/model names and numbers only: prompt text, summary text,
  and provider message prose never cross this boundary.
- 2026-09-19 (issue #412): An untyped failure renders a BOUNDED class token, or a
  fixed non-error label, and nothing else. The console's last-resort branch names
  the failing error's class because a turn that dies before any provider call
  leaves no ledger row and the class is the only evidence a reader gets -- but
  the message stays withheld (an untyped harness error is the case most likely to
  quote the request it rejected), and the fields that carry a class are ORDINARY
  properties that any thrown object can set to anything: an anonymous subclass
  has an empty `constructor.name` (rendering as an empty pair of parentheses), a
  thrown non-Error has no class at all, and a crafted error can point either
  field at text that would forge another class, a second record, or a message
  into a projection that is meant to be one bounded line. So it consults NO own
  property of the thrown value at all -- an own `name` or an own `constructor` is
  exactly how a forged class would be supplied, and neither is read: (1) the name
  comes from the PROTOTYPE's constructor, (2) it is accepted only when it is a
  plain identifier of bounded length, (3) anything else that IS an Error renders
  the base label `Error` (an anonymous subclass has an empty `constructor.name`
  and is still, truthfully, an Error), and (4) a thrown non-Error renders
  `non-error <typeof>`, with `null` named explicitly because `typeof null` is
  "object". Totality is part of the rule, not an aspiration, and it covers the
  WHOLE classification of a caught value: every read made of it -- `instanceof`,
  `[[GetPrototypeOf]]`, the `constructor` access -- runs through a Proxy's traps
  when the thrown value is one, and each of them can therefore THROW rather than
  answer. A diagnostic that dies while describing a failure replaces the turn's
  failure with its own (measured: the escape left the turn's catch and was
  rendered as `input_failed`, whose advice is to restart a console whose input
  stream is fine), so no classification step is allowed to propagate one: the
  typed checks ask through a total `instanceof` that treats a refusal as "not
  this type", and the classifier reports any refusal of its own reads as the
  fixed label `unclassified`. The TYPED branches are inside that rule, not
  beside it: each of them READS fields off the value (`status`, `failure`,
  `attempts`, `provider`, `block`, `retryAfterMs`), and passing the type check
  does not make those reads safe -- the check walks the prototype chain, so a
  Proxy answers it and traps the reads (measured: a Proxy around
  `ProviderRejectionError` whose `get` trap throws escaped the turn's own catch
  and rendered the fault as `input_failed`, advice to restart a console whose
  input stream was fine). The whole chain is therefore guarded, and the guard is
  sound only because every branch COMPUTES its entire line before writing it: a
  defeated branch has rendered nothing, so the untyped line replaces it and
  remains the turn's single failure record -- never a second one. The result is
  total and deterministic: every input
  -- including a hostile one -- yields one token from the closed set {bounded
  identifier, `Error`, `non-error <typeof>`, `unclassified`}, the same failure
  always renders the same line, and no message, stack, or provider payload can
  reach the reader through the class field. Class names and `typeof` labels only
  -- never a message, never an anonymous blank.
- 2026-09-19 (issue #403): a stage that fails on an UNCLASSIFIED error still
  names itself in durable state. A generic `stage_failed` pause that recorded
  nothing sent operators re-deriving the diagnosis from the session log, so the
  coordinator now persists a pause cause with the fixed `untyped_error` code
  token and a bounded, redacted message composed from the error's constructor
  name plus the FIRST line of its message -- and nothing else. The composition
  is ordered and bounded: the constructor name is read only through the
  PROTOTYPE chain (no own property is consulted, so a forged `constructor.name`
  cannot inject text), accepted only as a bounded single-line ASCII identifier
  (else the fixed token `Unknown`), every hostile read -- the prototype walk,
  the `constructor` access, the `message` access, the `String` coercion, each
  runnable through a Proxy trap or a throwing getter -- is guarded to a fixed
  fallback instead of crashing the failure catch, control characters are
  REMOVED so the printable-ASCII domain holds before any pattern matching,
  credential-shaped values are then redacted, and only then the line is
  clipped to the shared 512-char pause-cause ceiling
  (`MAX_PAUSE_CAUSE_MESSAGE_CHARS`). The accepted residual is exactly this
  bounded strip-and-clip of uncontrolled text in durable state: a durable pause
  cause with code `untyped_error` carries the bounded first line as quoted data
  in `cause.message`; the recorded `action` does NOT interpolate the bounded
  message -- the `action` field is bounded by `requiredString` to 256 chars
  (src/orchestration/background-runs.ts) and the cause message can reach the
  full 512-char ceiling, so any action that interpolated the message would
  itself be unreadable on round-trip. The action names the recorded code
  token (`untyped_error`) and points the operator at the recorded durable
  cause under `pause.cause`; the carry-over into the retry prompt reads the
  message from `cause.message` and treats it as untrusted data, not
  instructions; no other surface gains this carve-out -- model text and
  provider response bodies still never cross a projection beyond that bounded
  first line. The recurrence comparison for two `untyped_error` causes
  requires the recorded message to be identical, so two different concrete
  failures are never called a loop. The same bounded cause also settles a
  `review_not_run` pause (review round 4): the review stage failing on an
  unclassified error is the same durable-vs-log question, and its pause
  wording keeps the verdict frame and the harness-bug caveat.

- 2026-09-19 (issue #418): A provider failure that settles a turn as an empty
  one carries its bounded CAUSE past the boundary, so an operator can read
  "all presets fail with X" without re-running. When none of the owned
  boundaries fired (quota, rejection, credential), the empty-turn fallback
  records what the provider REPORTED: `providerStatus` is the HTTP status read
  from the same anchored message shapes or a structured
  `status`/`statusCode` field, validated to 400..599 (recording, not
  classification -- it moves no 2026-09-19 boundary), and
  `providerErrorCode` is the provider's own error code as a strict-charset
  token (`[A-Za-z0-9_.-]{1,64}`, the same extractor the quota error uses).
  When a non-credential status is carried the message names it (`HTTP <n> (…
  provider error code <token>); check the provider account for HTTP <n> and
  retry`) instead of repeating the credential advice `auth status` already
  disproves -- an OpenRouter 402 billing refusal is not an authentication
  failure. When no status is parsed, or the status IS 401/403, the message
  stays verbatim the pinned `verify authentication and retry` wording. A
  status or code that fails its bound is DROPPED, never truncated. Only the
  bounded pair ever crosses: the message it was read from -- and with it any
  echoed request values, URLs, and the response body -- is dropped at the
  same boundary. The same bounded pair is also recorded on the ledger row
  (`providerError {status?, code?}`, `ledger-report.md`), which is what
  makes the diagnosis readable from durable artifacts alone.
- 2026-09-20 (issue #444): **A summarizer failure is recoverable, and the
  recovery is the harness's own.** The compactor no longer counts attempts or
  remembers a failure: it is a `before_compaction` hook, and rule (1) of the
  2026-09-19 entry above is SUPERSEDED -- `COMPACTION_ATTEMPT_LIMIT` does not
  exist and nothing sticky is left behind by a single refusal. The hook has
  three answers, and which one it gives is the whole policy. (a) A summary:
  the harness commits it. (b) Nothing, for a summarizer failure on its OWN
  route -- the harness then summarizes with the role's own model, so a cheap
  summarizer that is down costs tokens rather than the session, and the
  fallback is bounded by the harness's retry policy instead of ours. (c)
  `{decline: true}`, and this answer is reserved for two cases where a
  fallback would be a LIE: the provider is unavailable (queue saturated,
  admission cancelled, provider limit, quota), so the typed refusal must
  survive to the caller, and a threshold compaction with NOTHING evictable,
  where the harness would otherwise call the role's own model to summarize an
  empty set. A decline on a threshold leaves the run running uncompacted; on
  an overflow or a manual compaction it would settle the run as
  `compaction_declined`, which is why pi-agent-core's length recovery -- the
  retried truncation of issue #368 -- is passed THROUGH as `undefined` and
  never declined. A THROW is not an answer: the harness's structural
  generation is not inside the catch that recognises `StructuralCancelled`, so
  a raw provider error raised from there is wrapped as
  `AgentHarness storage or invariant fault` and destroys the typed admission
  error it was carrying (measured). The terminal stop keeps its own rule: it
  is classified at the SETTLED-RUN boundary, from the settled result and never
  from the answer text -- a run that fails leaves the PREVIOUS turn's assistant
  text on the branch, so a classifier that reads the text reports a failed run
  as a completed turn (measured) -- it is typed as
  `ContextCompactionLostError` for `summarization_failed`,
  `compaction_declined` and `structural_interrupted` only, and it is STICKY:
  the spent session refuses every later turn before any provider dispatch,
  rather than re-dispatching into the same wall.
- 2026-09-20 (issue #430): A durable-read failure of one background run's
  persisted state does not take down the calling console turn. A stale or
  unreadable record re-fails loudly at the strict reader, but the wake pump's
  fire-and-forget drain (`pendingWakes()` behind `void this.drain()`) is not a
  caller path: one untyped escape there used to end a 0-second wake turn with
  an empty ledger, so reading a durable artifact killed a console turn that was
  not reading it. The rule follows the same containment the 2026-09-19 entries
  require: explicit typed paths (`status()`, `result()`, `events()`) keep the
  strict typed rejection, while the unobserved drain boundary contains the
  failure in one bounded, identifier-only stderr line (run id and failure code,
  never record content) and leaves the wake durably pending for the next nudge
  (`src/orchestration/wake.ts`). Silent catches and success-shaped fallbacks
  remain violations; containment here means one loud, bounded, attributed line
  -- not hiding the failure.
- 2026-09-20 (issue #467): The two RESEARCH refusal pauses compose their
  `action` under the same bounded-cause discipline the untyped stage failure
  already follows (issue #403). `unsafe_request` (the researcher request
  failing to prepare) and `research_rejected` (the research step failing)
  used to interpolate the raw `error.message` into the pause `action`
  verbatim; a message over 256 chars made the whole record -- the background
  run record and the coordinator checkpoint alike -- undecodable on
  round-trip (`requiredString` in src/orchestration/background-runs.ts
  rejects any persisted string field over 256 chars), and `background status`
  exited 1 with {"error":{"code":"not_found","detail":"background_run"}}.
  Both pauses now record the bounded, redacted cause under `pause.cause`
  (`pauseCauseFrom` for a typed harness-side error, `untypedPauseCause`
  otherwise, the `WorkflowStageFailureError` wrapper unwrapped first exactly
  like `stageFailurePause`), and the action is fixed harness text naming the
  pause's code token and the cause's code token -- never the message -- so it
  stays within the 256-char ceiling for ANY thrown value (measured: 656- and
  665-char actions before the fix; 209 and 196 chars at the worst-case
  64-char cause code after). The untyped cause's clip at the shared 512-char
  pause-cause ceiling (`MAX_PAUSE_CAUSE_MESSAGE_CHARS`) is VISIBLE now: a
  first line longer than the ceiling keeps its head and ends in the fixed
  `...[clipped]` marker inside the ceiling, so a cut is legible in the record
  instead of a silent slice; the remove-non-printables -> redact -> clip
  order is unchanged, and identical inputs still compose identical messages
  for the recurrence comparison.
