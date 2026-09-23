# Waiting contract

This contract governs the headless `WaitService`: durable, typed condition
waits. It answers what a host may persist and reconcile without turning waiting
into a timer, a process runner, or a front-only feature.

## Durable record and lifecycle

- A wait record has schema version `WAIT_RECORD_VERSION`, a safe wait id, typed
  `source` (adapter, version, target kind/id), condition kind, owner kind/id,
  delivery policy, optional absolute deadline, recovery action, timestamps,
  lifecycle, event sequence, and bounded event/evidence histories. These are
  identifiers and enums only: URLs, commands, PIDs, headers, provider payloads,
  task text, and credentials are never wait state or evidence.
- Persisted record, event, and evidence shapes are closed: an unknown field is
  a typed refusal, never a field copied through `get`, `events`, or `reopen`.
- Only a registered adapter at the record's exact version validates a source and
  reconciles it. Adapters receive the safe source and condition plus a minted
  operation id; they do not supply arbitrary persisted fields.
- Creation atomically writes the initial `pending` event before returning.
  `pending` is the only non-terminal lifecycle. `satisfied`, `failed`,
  `unavailable`, `timed_out`, `stalled`, and `cancelled` are terminal and may
  never change to another lifecycle. Repeated cancellation and terminal
  reconciliation are idempotent.
- Terminal evidence is typed and content-free: `condition_met`,
  `condition_failed`, `source_unavailable`, `deadline_exceeded`,
  `source_stalled`, or `cancelled`. Core-generated timeout and cancellation
  always use `deadline_exceeded` and `cancelled` respectively. Adapter evidence
  is an optional bounded diagnostic, so the terminal lifecycle—not a missing or
  adapter-supplied code—is the authoritative outcome. `reconcile_uncertain` is
  deliberately not terminal evidence: it is a typed recovery refusal with a
  durable dispatched-operation witness.

## Events, polling, and delivery

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
- Event delivery is a host-owned hint. The core creates no listener, timer,
  subprocess, notification, or wake turn. A host calls `reconcile` after an
  adapter event or at its own bounded cadence, then separately applies the
  wake-delivery contract to persisted state.
- `poll` only makes reconciliation eligible after its configured interval; it
  never schedules or busy-waits. The interval is required and at least the
  positive `minPollIntervalMs`; `events` has no interval.

## Checkpoint and recovery

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

## Configuration and related surfaces

All retention and cadence limits above are constructor configuration with
positive defaults in `DEFAULT_WAIT_SERVICE_LIMITS`; zero and negative values
are refused. Hosts expose any user-facing choice under
[configuration](config.md). The implementation is
`src/orchestration/wait-service.ts`; private atomic storage is
`src/project-store/project-store.ts`. The system map is
[architecture](../ARCHITECTURE.md), recovery is [resumability](resumability.md),
and host wake turns are [wake delivery](wake-delivery.md).
