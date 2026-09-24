# Slice audit: orchestrator guarantee `orchestrator.md:9` (task states)
Audit base: ff07c9988923aeb4fa0b66106f3574103eb4b4cd, date 2026-09-24.
Rule text: "- An accepted task is exactly one of WIP, blocked, or closed. Waiting is WIP.
  There is no quietly stopped state: the orchestrator can name its state,
  durable evidence, and next event or action. A new message, restart, or context
  boundary does not close an unfinished task."

## Verdict
conforming (for the conversation/console orchestration surface this slice examined): the
implementation types exactly two durable task states (`WIP`, `blocked`) with named
exceptionally well-named evidence, work and next-action fields, persists them as durable
session entries, closes only by deliberate `close()`, and a restart or new operator
message resumes rather than discards the unfinished task; the "closed" third state is
enforced as a refusal path rather than a persisted silently-stopped state.

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `ff07c9988923aeb4fa0b66106f3574103eb4b4cd`, worktree clean |
| `bun test test/conversation.test.ts` | 33 pass, 0 fail, 138 expect() calls, exit 0 (2.47s) |
| `bun test test/orchestrator-wake.test.ts test/background-runs.test.ts` | 44 pass, 0 fail, 618 expect() calls, exit 0 (1.91s) |

Behaviour actually exercised includes (test names verified by reading
`test/conversation.test.ts`):
- `interruption checkpoints durable status and resumes once after reopening` (line 164):
  an interrupted turn persists a state-"WIP" checkpoint with `work` and `next`, the
  session is reopened from disk, and the next operator message resumes with the
  preserved continuation preamble instead of starting over — this is the exact
  "restart or new message does not close an unfinished task" clause.
- `blocked recovery is stored separately and never consumed as WIP continuation` (305)
  and `durable recovery remains blocked across reconnect until operator input` (426):
  the blocked state is durable across a context/reconnect boundary and cannot be
  conflated with WIP.
- `a completed conversation turn does not create a continuation checkpoint` (533): a
  no-op turn does not manufacture a stopped state for a task that is not stopped.
- `a closed conversation refuses with the authored sentence ...` (1600): "closed" is a
  deliberate transition that refuse-turns with an explicit reason
  (`ConversationRefusalReason = "closed" | "step_active" | "lane_stopping"`,
  src/conversation/conversation.ts:236), never a silent stop.

## Evidence read
- `src/conversation/conversation.ts:88-102` — `DurableContinuationCheckpoint.state` is
  the literal `"WIP"` and `DurableBlockedRecovery.state` is the literal `"blocked"`.
  The type system admits exactly these two durable task states; there is no third
  persisted state and no "waiting" state distinct from WIP (waiting is checkpointed as
  WIP with its `next` action named).
- `src/conversation/conversation.ts:566-599` — the `checkpoint()` writer sets
  `state: "WIP"` together with bounded `work`, `reason` and `next` fields; the record is
  bounded (2 KiB, `CONTINUATION_CHECKPOINT_MAX_BYTES`, conversation.ts:107) and appended
  as a durable custom session entry (conversation.ts:546-551). This is the "name its
  state, durable evidence, and next event or action" clause at the code level.
- `src/conversation/conversation.ts:601-617` — `blockContinuation()` writes a
  `state: "blocked"` record with named `evidence` and `decision{question,action}`,
  matching the blocked clause of the rule.
- `src/conversation/conversation.ts:442-456` — on (re)open, recovery is derived from the
  durable session journal, not from process memory: a non-consumed WIP checkpoint or
  blocked record re-arms the gate, so a restart or context boundary preserves state.
- `src/conversation/conversation.ts:569-584` and `644-652` — consumption is a journal
  transition (`consumed: true` appended entry), not an in-memory flag.
- `src/cli/console.ts:956-957` — the operator surface names the state
  ("a durable continuation checkpoint (state WIP ...)"), the artifact identity,
  preserved work and the next action; the orchestrator can genuinely answer "where is
  my task".

## Gaps and unverified
- This slice audited the conversational orchestration surface only. It did NOT verify
  the same guarantee for `runPipeline`/`WorkflowState` (src/orchestration/types.ts:875),
  which has `phase`/`done`/`approved` fields but no WIP/blocked/closed literal whose
  exhaustiveness I checked — residual risk `unverified` for the pipeline-drive surface.
- The background/background-run surface tests passed, but I did not read their state
  recording to confirm durable naming of state+evidence+next beyond BgRun's internal
  `closed` flag (src/orchestration/background-runs.ts:165) — partially unverified.
- I did not run any CLI command end-to-end against a real invalid-transition refusal;
  the "closed refuses a turn" behaviour is established by reading the test at
  test/conversation.test.ts:1600 and src/conversation/conversation.ts:770, not by
  executing the CLI binary.
- No adversarial/fuzz check that a malformed checkpoint (e.g. state "stopped") could be
  persisted by a future writer and be silently treated as neither WIP nor blocked.
- One command count: 3 commands were executed beyond navigation/greps (git status/rev-parse
  combined, and the two `bun test` runs).
