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
  bodies in an error.
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
