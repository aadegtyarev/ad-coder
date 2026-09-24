# Slice audit: orchestrator guarantee `orchestrator.md:22` (g5-wake-delivery)
Audit base: ff07c9988923aeb4fa0b66106f3574103eb4b4cd, date 2026-09-24.
Rule text: "- Long-running work has durable event- or timer-based wake delivery. The product,
  not an orchestrator turn, polls sources without push support. A wait names its
  object and condition, has a finite timeout, reports unavailable conditions
  separately, and is interrupted immediately by an operator message. [Waiting](waiting.md)
  owns the shared wait operation and adapters."

## Verdict
conforming (for the durable wake-delivery surface this slice examined): wake records are
persisted as durable per-run JSON entries, drain into genuine orchestrator turns via a
single-flight pump with restart pickup, and rendering/activity noise never enqueues a model
turn; however one clause ("has a finite timeout") is in unresolved conflict with the owning
wait contract, which permits an *optional* deadline. Surfaces examined: wake record
persistence and coalescing (src/orchestration/background-runs.ts), the drain pump
(src/orchestration/wake.ts), orchestrator wiring (src/orchestration/orchestrator.ts), the
WaitService deadline field (src/orchestration/wait-service.ts), and the four named test
files. NOT examined: the TUI/machine-API wait surfaces, wait operator-interruption
behaviour mid-poll, telegram/session-transport wake rendering, and how the product polls
sources at runtime ("the product, not an orchestrator turn, polls").

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `ff07c9988923aeb4fa0b66106f3574103eb4b4cd` |
| `bun test test/orchestrator-wake.test.ts` | 19 pass, 0 fail, 472 expect() calls, exit 0 (1122ms) |
| `bun test test/wait-service.test.ts test/wait-adapters-timer.test.ts test/cli-console.test.ts` | 119 pass, 0 fail, 710 expect() calls, exit 0 (3.45s) |

Behaviour actually exercised (real test names, verified by grepping `^test(` in
test/orchestrator-wake.test.ts):
- `(a) a paused run wakes the orchestrator via durable state, then marks the wake handled`
  (line 96): the durable record initiates a turn; handled is set only after the turn.
- `(e) a wake recorded with no live session is picked up on the next start` (285): the
  "restart or wake delivery survives the session" clause.
- `(f)` (335) and `(h) a wake landing during a front turn is drained after it, never
  racing conversation.step` (525): wakes defer to the operator's live turn, not racing it.
- `(c) progress/activity events start no turn and record no wake` (178): rendering-only
  noise never becomes a model turn.
- `(d)` (254) and `(g) a racing runTurn failure is contained` (462): no loss, no hot loop.
- `durable lifecycle publishes ordered versioned events and safe bounded evidence`
  (test/wait-service.test.ts:38) and `timer adapter observes numeric deadline without
  scheduling` (test/wait-adapters-timer.test.ts:13): wait records are durable and the
  timer adapter observes a deadline rather than turning waiting into a scheduled turn.

## Evidence read
- `src/orchestration/background-runs.ts:913-961` — `coalesceWake()` records turn-initiating
  lifecycles as `{kind, firstAt, lastAt, count, handled}` windows; non-turn-initiating
  lifecycles never create a wake. `background-runs.ts:927-941` — retention evicts only the
  oldest HANDLED windows: "unhandled windows are the turn-initiating signal and must never
  be dropped by retention".
- `src/orchestration/background-runs.ts:953-965, 1140-1165` — `persist()` writes the wake
  entries into the per-run `<runId>.json` (`wake: {entries: ...}`, `PersistedEntry`) with a
  read-modify-write merge so a concurrent writer cannot clobber handled state; on reload
  (line 1157) wake entries are re-read from disk. This is the "durable ... wake delivery"
  clause.
- `src/orchestration/wake.ts:214-278` (`WakePump.drain`) — single-flight drain; the turn is
  only marked handled after `runTurn` resolves; the post-drain re-read compares
  windows-not-snapshots so a fresh pause during the turn gets its own later turn; every
  failure path returns with nothing marked and no reschedule (no hot loop).
- `src/orchestration/wake.ts:21-62` (`buildWakeTurnPrompt`) — the wake prompt carries only
  safe record fields (runId, kind, pause payload, metrics, count), never raw event prose.
- `src/orchestration/orchestrator.ts:2148-2176` — the pump is wired to real orchestrator
  turns (`conversation.step(prompt, {step})`), re-armed by `backgroundRuns.subscribe(...)`
  (event-based wake), and `void wakePump.startupScan()` at startup picks up wakes recorded
  while the session was gone ("Pick up any wake recorded while this session was gone
  (restart/reconnect)").
- `docs/contracts/wake-delivery.md:3-9, 15-20, 33-36` — the dedicated sub-contract
  restates the same guarantees (durable, owner-scoped, restart-survivable, drain bound,
  handled only after delivery checkpoint) and lines 33-36 additionally require the
  operator summary and not reporting a still-WIP task as complete. NOTE: this bullet at
  `orchestrator.md:22` does NOT name `wake-delivery.md`; the citation it makes is
  `[Waiting](waiting.md)` — wake-delivery.md exists and governs in practice, and this
  slice reads it as the governing sub-contract.
- `src/orchestration/wait-service.ts:71-75, 117, 229, 286-287` — `deadlineAt` is OPTIONAL
  ("Omit for no core deadline"); a wait can be created with no finite deadline. The timer
  source itself is deadline-observing (wait-adapters-timer test above), and
  `src/orchestration/wait-service.ts:286-287` transitions to `timed_out` at the deadline —
  but only when a deadline was supplied.

## Findings
- [contract-conflict, medium] `orchestrator.md:22` requires "A wait ... has a finite
  timeout", but the owning contract it delegates to, `waiting.md:29`, specifies an
  "**optional** absolute deadline", and `src/orchestration/wait-service.ts:71-75` implements
  exactly that. Two contracts disagree on one surface. Safe next step: an operator decision
  on which text is canonical, then a one-clause amendment to the losing contract. No code
  change proposed.

## Gaps and unverified
- "The product, not an orchestrator turn, polls sources": I verified the core never
  creates a poll timer from `pollIntervalMs` (src/orchestration/wait-service.ts:61; the
  bounded-gate test at test/wait-service.test.ts:111). I did NOT trace which product
  component performs the actual source polling at runtime — `unverified`.
- "is interrupted immediately by an operator message": the wake side defers to an
  operator turn (test (h)); the opposite direction — a live wait being cancelled when
  the operator types — is covered only by test/wait-service.test.ts:157 which I ran but
  did not read line-by-line, and no CLI/TUI cancel command path was examined —
  `unverified`.
- "reports unavailable conditions separately": waiting.md:24-25 guarantees a visible
  `unavailable`/`failed` state, and wait-service has `source_unavailable` lifecycle
  (src/orchestration/wait-service.ts:30). I did not run or read a test asserting the
  operator-visible separation of unavailable-wait reports from other reports —
  `unverified`.
- TUI, machine API, and telegram wait surfaces (waiting.md:88-89 and
  src/cli/console.ts wiring beyond the heartbeat/escape timers I grepped) were not
  examined — `unverified`.
- No end-to-end CLI run delivering a real wake turn against a live background run was
  executed; wake behaviour is established by the unit tests above plus code reading.

Command count note: two `bun test` runs (3 files total) and one `git rev-parse`
are the behaviour-bearing checks above; navigation used additional grep/sed commands
whose exact count is not tracked here.
