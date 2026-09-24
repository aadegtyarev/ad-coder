# Slice audit: orchestrator guarantee `orchestrator.md:39` (g6-visible-decisions)
Audit base: ff07c9988923aeb4fa0b66106f3574103eb4b4cd, date 2026-09-24.
Rule text: "- The orchestrator writes its material decisions, starts, waits, and next steps
  to the operator-facing session as they occur. A wake produces a short summary
  of the event, available data or error, and intended follow-up. It remains WIP
  and never reports the task complete until the durable outcome is actually
  closed or blocked."

## Verdict
conforming (for the console/wake-delivery surface this slice examined): wake turns are
delivered as they occur through a durable pump and rendered straight to the operator's
session with a started notice, the settled turn text, and an index step identifier,
verified end-to-end against a real orchestrator; the sentence-3 clauses (summary content
quality, premature completion ban) are enforced primarily by contract + turn prompt, not
hard code, and are explicitly listed as unverified below. Surfaces examined: console front
(src/cli/console.ts), wake pump (src/orchestration/wake.ts), orchestrator wiring
(src/orchestration/orchestrator.ts:2129-2208), contracts wake-delivery.md and
orchestrator.md. NOT examined: Telegram front, runPipeline/run-coordinator decision
writes, attaching material "decisions" made outside wake turns to the session, timer wakes (not
read or run this slice).

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `ff07c9988923aeb4fa0b66106f3574103eb4b4cd`; worktree has staged/added slice-review files, no runtime-staged changes to source |
| `bun test test/cli-console.test.ts` | 105 pass, 0 fail, 665 expect() calls, exit 0 (3.14s) |
| `bun test test/orchestrator-wake.test.ts` | 19 pass, 0 fail, 472 expect() calls, exit 0 (1.07s) |

Behaviour actually exercised (not just read):
- `test/cli-console.test.ts:203` "renders a durable wake through the real orchestrator and
  formatted console": a real background run pauses with `stage_limit`, the wake pump
  converts it into a turn against the real orchestrator/startConversation seam, and the
  running console asserts the operator saw BOTH `ad-coder: wake turn started (wake:1)`
  (error stream) AND the settled `settled wake result` turn text (output stream), with no
  ANSI escapes and the prompt re-drawn — delivery "as they occur," not after the fact.
- `test/orchestrator-wake.test.ts` (19 tests) asserts the pump drains durable wakes,
  marks handled only after durability (472 expects), and never races a foreground turn.

## Evidence read
- `src/orchestration/wake.ts:31-65` — `buildWakeTurnPrompt()` names each persisted wake
  event (`run`, `kind`, pause phase/code, metrics, coalesced count and since-time) and the
  resolution rule ("handled, or explicitly recorded why it cannot be"); safe fields only.
- `src/orchestration/wake.ts:146-204` — WakePump deps and the single-flight drain, listing
  the "durable" path contract comment that a dropped notice page loses nothing.
- `src/cli/console.ts:780-800` — `queueWakeRender()`: "Wake callbacks arrive outside the
  input lane. Serialize their projection with foreground output" then writes
  `wake turn started` / the settled render; the started notice and settled render are the
  operator-visible "start ... as they occur" signals, serialized to avoid interleaving.
- `test/cli-console.test.ts:203-270` (read, and run above) — end-to-end wake render.
- `src/orchestration/orchestrator.ts:2129-2208` — the orchestrator's WakePump wiring with
  owner-scoped `pendingWakes()`/`markWakesHandled()` and `startupScan()`, so a wake
  recorded while the session was gone still turns into a visible summary on reconnect.
- `docs/contracts/wake-delivery.md:24-26` — the explicit "short operator summary before
  choosing its next action ... does not turn a still-WIP task into a completion report."
  This is the reachable surrogate contract for sentences 2-3 of the target rule.

## Gaps and unverified
- The "available data or error, and intended follow-up" content of a wake summary is
  enforced by prompt wording + `wake-delivery.md:24`, not by an assertion of a concrete
  summary structure; I did not find or run a test pinning expected summary text beyond the
  echoed `settled wake result`. Summary-quality conformance is `unverified`.
- Sentence 3 ("remains WIP; never reports the task complete until the durable outcome is
  actually closed or blocked") was NOT exercised. No test I saw prevents an assistant from
  calling a wake turn a completion report; the guard lives in the prompt and follow-up
  validators, not the turn handler. Would need an adversarial test that feeds a
  "task complete" claim while the run is still `running`/`paused` and asserts the refusal
  or WIP status marker.
- "Material decisions ... waits ... next steps" outside wake turns (ordinary foreground
  turns, follow-up capture at `src/orchestration/follow-up.ts:9-81`) were read only
  superficially; durable writing of non-wake decisions to the operator-facing session is
  `unverified` this slice.
- Timer wakes and the Telegram/other fronts were not examined at all.
- 3 substantive commands were executed beyond navigation greps/reads.
