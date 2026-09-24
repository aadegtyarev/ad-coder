# Waiting contract

This contract owns durable non-blocking waits for an internal or external
condition: the headless `WaitService` with typed condition waits. It answers
what a host may persist and reconcile without turning waiting into a timer, a
process runner, or a front-only feature.

## Guarantees

- One core `WaitService` creates a durable wait identity from a typed source,
  target, condition, timeout, polling/event policy, owner, and recovery action.
  Creation returns immediately; it never holds an orchestrator turn, input editor,
  or provider permit while waiting.
- Built-in sources cover role/agent/workflow run state, an owned tool or subprocess,
  and a timer/alarm. A forge, CI, research, or other extension supplies a versioned
  source adapter for its own status; the core has no GitHub, GitLab, or provider-
  specific polling logic.
- A wait may observe only a durable run identity, a proven owned process handle, or
  an adapter-validated external resource. It never discovers a process by command
  text/PID guess or runs an arbitrary shell predicate repeatedly.
- The core records ownership and a platform-appropriate verifiable identity before
  reporting an owned process as started. On harness restart it reconnects that
  process and its wait when identity, owner, and start-instance evidence agree;
  it never starts a duplicate merely because the harness died. If the process is
  gone or identity cannot be proven, the wait becomes a visible `unavailable` or
  `failed` state with inspect, retry, and explicit replacement actions.
- A wait record has schema version `WAIT_RECORD_VERSION`, a safe wait id, typed
  `source` (adapter, version, target kind/id), condition kind, owner kind/id,
  delivery policy, optional absolute deadline, recovery action, timestamps,
  lifecycle, event sequence, and bounded event/evidence histories. These are
  identifiers and enums only: URLs, commands, PIDs, headers, provider payloads,
  task text, and credentials are never wait state or evidence.
- Persisted record, event, and evidence shapes are closed: an unknown field is
  a typed refusal, never a field copied through `get`, `events`, or `reopen`.
  A persisted `WaitCondition` is exactly `{ kind: string }` or
  `{ kind: string, at: number }`, where `at` is an optional non-negative safe
  integer (`0 <= at <= Number.MAX_SAFE_INTEGER`) used as an observation
  threshold by the timer adapter. This bound keeps the condition numeric,
  finite, and content-free; it is not a delay, callback, or secret-bearing
  payload.
- Only a registered adapter at the record's exact version validates a source and
  reconciles it. Adapters receive the safe source and condition plus a minted
  operation id; they do not supply arbitrary persisted fields.
- Creation atomically writes the initial `pending` event before returning.
  `pending` is the only non-terminal lifecycle. `satisfied`, `failed`,
  `unavailable`, `timed_out`, `stalled`, and `cancelled` are terminal and may
  never change to another lifecycle. Repeated cancellation and terminal
  reconciliation are idempotent.
- Source adapters prefer declared event delivery and use configured bounded polling
  only where push is unavailable. They report `satisfied`, `failed`, `unavailable`,
  `timed_out`, `stalled`, or `cancelled` distinctly with safe condition evidence;
  they never manufacture success after lost access or a dropped poll.
- Terminal evidence is typed and content-free: `condition_met`,
  `condition_failed`, `source_unavailable`, `deadline_exceeded`,
  `source_stalled`, or `cancelled`. Core-generated timeout and cancellation
  always use `deadline_exceeded` and `cancelled` respectively. Adapter evidence
  is an optional bounded diagnostic, so the terminal lifecycle—not a missing or
  adapter-supplied code—is the authoritative outcome. `reconcile_uncertain` is
  deliberately not terminal evidence: it is a typed recovery refusal with a
  durable dispatched-operation witness.
- Every transition checkpoints before it is reported. Resume restores a pending
  wait without duplicating an external subscription or command, reconciles an
  uncertain observation, and preserves timeout/deadline semantics.
- The core atomically checkpoints a reconciliation operation id before calling
  an adapter. It writes the returned observation, including a terminal event,
  before reporting that result. Store compare-and-swap serialization rejects
  stale writers.
- If the adapter throws, crashes, or cannot be proven to have returned, the
  durable witness remains and `reconcile` fails `reconcile_uncertain`. Reopen
  validates and exposes that state; it MUST NOT replay the operation. The
  owner follows the record's explicit `inspect`, `retry`, or `replace` recovery
  policy through a later, source-specific flow.
- Reopening a valid pending or terminal record has no external side effect.
  Reconciliation of a terminal record has no external side effect. A malformed
  record fails typed and remains intact; an unknown or mismatched adapter fails
  typed before reconciliation rather than being called.
- `WaitService` publishes its lifecycle changes through the existing versioned
  harness event bus; it creates no parallel notification channel. Durable wakes
  are derived from those persisted transitions, while fronts use the same stream
  for rendering and replay. Event delivery is a host-owned hint: the core
  creates no listener, timer, subprocess, notification, or wake turn. A host
  calls `reconcile` after an adapter event or at its own bounded cadence, then
  separately applies the [wake delivery](wake-delivery.md) contract to persisted
  state.
- Completion, failure, timeout, and cancellation create the normal durable wake.
  The orchestrator receives a bounded result and states the next action; the
  operator can inspect, cancel, retry, or submit unrelated input throughout.
- TUI, machine API, and the orchestrator expose the same wait list, create,
  inspect, cancel, and supported retry actions. A no-argument wait command is
  local help that lists available source adapters and examples, not a model turn.

## Events, cursors, and limits

- Each lifecycle event has `WAIT_EVENT_VERSION`, a strictly increasing,
  per-wait sequence and the wait id. Event and evidence retention are bounded
  by positive `maxEventsPerWait` and `maxEvidenceEntries` limits. A separate,
  mandatory positive `maxPersistedStateBytes` ceiling includes the versioned
  storage envelope: it applies before a record is created or mutated and before
  `get`, `events`, or `reopen` expose a persisted record. An oversized record
  fails the typed, content-free `state_too_large` refusal; it is not truncated,
  silently accepted, or used as an event page.
- `events(waitId, cursor, limit)` returns events strictly after the cursor and
  the last returned sequence as `nextCursor`. A cursor behind retained history
  sets `gap`; consumers reconcile from `get`/`reopen` rather than treating a
  page as complete history. An empty page retains the supplied cursor.
- `poll` only makes reconciliation eligible after its configured interval; it
  never schedules or busy-waits. The interval is required and at least the
  positive `minPollIntervalMs`; `events` has no interval.

## Configuration

Enabled source adapters, polling interval/backoff, timeout/stall limits, event
subscription, concurrency, retention, and retry policy are independently
configurable. Defaults favour adapter events, bounded polling fallback, and no
busy waiting. All retention and cadence limits above are constructor
configuration with positive defaults in `DEFAULT_WAIT_SERVICE_LIMITS`; zero and
negative values are refused. Hosts expose any user-facing choice under
[configuration](config.md).

## Verification

Test immediate return and continuously available input, every built-in source,
one event-bus lifecycle sequence and durable wake per terminal transition, event
versus polling source, typed terminal states, owned-process refusal, reconnect
after a harness crash, missing or identity-mismatched process, no duplicate
process or external observation, extension-adapter absence, timeout/stall,
oversized-state refusal, cursor gap/empty pages, durable restart, wake delivery,
cancellation/retry, and TUI/API/orchestrator parity.

## Related surfaces

- [Wake delivery](wake-delivery.md) owns post-wait orchestration turns.
- [Architecture](../ARCHITECTURE.md) owns the harness event bus.
- [Resumability](resumability.md) owns durable wait recovery.
- [Run control](run-control.md) owns owned-process cancellation.
- [Extension modules](extension-modules.md) owns forge and other adapters.
- [UI responsiveness](ui-responsiveness.md) owns continuously available input.
