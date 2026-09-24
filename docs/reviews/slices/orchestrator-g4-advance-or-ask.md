# Slice audit: orchestrator guarantee `orchestrator.md:19` (g4-advance-or-ask)
Audit base: ff07c9988923aeb4fa0b66106f3574103eb4b4cd, date 2026-09-24.
Rule text: "- An unfinished task advances without a new operator message or explicitly asks
  for a decision. A deliberate foreground interrupt preserves durable WIP and
  waits for the next operator input; it does not invent an automatic turn."

## Verdict
conforming for the surfaces this slice examined (foreground console conversation and the
wake pump): an unfinished task advances without a new operator message whenever a durable
wake is pending (the wake pump's own `runTurn`), explicitly asks for a decision when
bounded continuation makes no progress (`blockContinuation` writes a `blocked` record
carrying `decision{question,action}`), and a deliberate interrupt persists a durable WIP
checkpoint and is positively proven NOT to invent an automatic turn. The "no pending wake
AND no operator input" foreground staleness case is `unverified` (see Gaps).

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `ff07c9988923aeb4fa0b66106f3574103eb4b4cd` |
| `bun test test/orchestrator-wake.test.ts` | 19 pass, 0 fail, 472 expect() calls, exit 0 (1.08s) |
| `bun test test/cli-console.test.ts` | 105 pass, 0 fail, 665 expect() calls, exit 0 (3.18s) |

Behaviour actually exercised (test names verified by reading the files):
- `test/cli-console.test.ts:569` — "an Escape interruption returns to the prompt without
  an automatic continuation": a `TurnInterruptedError` carrying a WIP checkpoint results
  in `completedTurns === 0` and the prompt returning to the operator. This is the direct
  negative test for "does not invent an automatic turn".
- `test/orchestrator-wake.test.ts:382` — "an interrupted recovery block keeps pending
  wakes durable until operator input" and `:415` — "wakes arriving after recovery release
  retain normal behavior": an interrupted foreground task suppresses wake-driven
  advancement (`recoveryBlocked`) without losing the wake; it drains only on operator
  input. This is the exact "preserves durable WIP and waits for the next operator input"
  clause, tested at the boundary where automatic advancement COULD leak in.
- `test/orchestrator-wake.test.ts` tests (a)–(f) (lines 96, 150, 178, 254, 285, 335) and
  `(e)`'s restart path: a paused/failed background run durably wakes the orchestrator and
  the pump drives a turn (`turns.length === 1`) with no operator message, surviving a
  restart (a fresh manager + `startupScan()` drains it). This is the "advances without a
  new operator message" clause, from durable state, not memory.

## Evidence read
- `src/conversation/conversation.ts:903-918` — on Escape/Ctrl-C (`interrupted`), the turn
  `await checkpoint("Escape/Ctrl-C interrupted the provider turn")` (the WIP writer,
  lines 564-591, `state: "WIP"`, bounded `work`/`reason`/`next`) and throws
  `TurnInterruptedError` with the preserved checkpoint. Line 591 sets `recoveryBlocked`,
  gating any automatic advance out.
- `src/conversation/conversation.ts:592-625` — `blockContinuation()` writes a durable
  `state: "blocked"` record with named `evidence`, `decision{question,action}` and
  `work`; the "explicitly asks for a decision" path. (Note: the default evidence string
  at line 617 says "automatic continuation exhausted without progress" but I found NO
  automatic-continuation loop in this surface — the string is fallback text for an
  over-bound record. Misleading provenance; minor comment-vs-behaviour mismatch, not a
  contract violation.)
- `src/conversation/conversation.ts:632-667` — the `transform_context` hook re-drives a
  preserved WIP checkpoint into the next turn's context ("[Continuation preserved] Work…
  Next…") and marks it `consumed: true`. It fires only inside a later turn, so it resumes
  on the next operator input; it does not itself originate a turn.
- `src/conversation/conversation.ts:1118-1132` — the session's `interrupt` and
  `recoveryBlocked` accessors back the pump's deferral check.
- `src/orchestration/wake.ts:115-172` and the pump internals at lines 155-172: if
  `turnActive` or `recoveryBlocked`, the wake STAYS durably unhandled ("never lost, never
  hot-looped") and is deferred to the post-settle drain — automatic advancement cannot
  override a preserved foreground interrupt.
- `src/orchestration/wake.ts:172-245` — `drain()` drives `deps.runTurn` (the pump's own
  turn) over pending durable wakes, marks handled only after the turn resolves, and
  stays contained on failure (bounded stderr, no hot loop). This is the only automatic
  advance-without-operator-message mechanism I found, and it covers exactly the durable
  wake objects: paused and failed background runs.
- `src/orchestration/orchestrator.ts:2148-2174` — the pump is wired to
  `core.backgroundRuns.pendingWakes()` / `markWakesHandled`, `conversation.step` as
  `runTurn`, `conversation.recoveryBlocked?.() === true` as the deferral flag, and a
  `startupScan()` at start.
- `src/conversation/conversation.ts:285-299` — `TurnInterruptedError` and
  `ConversationRefusedError` carry the checkpoint and an authored reason; the
  interruption surfaces as a typed durable state, not a silent stop.

## Gaps and unverified
- Foreground staleness with no pending wake: if an unfinished foreground task is
  interrupted AND no durable wake is pending, nothing in `src/conversation/` advances or
  asks on its own; the task waits indefinitely for operator input. I did not establish
  whether any other surface (e.g. `telegram`, `src/orchestration/background-runs.ts` wake
  producers) generates a wake for such stalls — a wake-producing path stops making the
  task wait indefinitely, but I did not examine it beyond the `recoveryBlocked` deferral
  contracts in `wake.ts`. Residual risk `unverified`.
- I read only the interrupt/checkpoint/recovery seams of
  `src/conversation/conversation.ts` (grep-scoped reads), not `step()` in full
  (roughly lines 725-1117); another auto-advance hidden inside the step loop would not
  have been caught. The `cli-console.test.ts:569` behavioural test mitigates but does not
  replace reading the step code exhaustively.
- The g1 slice (docs/reviews/slices/orchestrator-g1-task-states.md) already audited the
  restart/persistence side of interrupted tasks (`conversation.test.ts`, 33 pass per that
  slice); I reused only its existence as cross-reference and did not re-run
  `test/conversation.test.ts` or re-verify its claims in this round.
- I did not run the CLI binary end-to-end against a real Escape keypress; the "no
  automatic continuation" behaviour is proven against the session seam by
  `test/cli-console.test.ts:569`, not through the interactive front's tty loop.
- Command count for this slice: 4 substantive commands beyond greps/navigation (the
  rev-parse and the two `bun test` runs are 3 of them plus one targeted `sed -n` read;
  all grep/navigation commands were read-only reconnaissance).
