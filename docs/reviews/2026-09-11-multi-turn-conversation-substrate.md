# Multi-Turn Conversation Substrate

**Date:** 2026-09-11
**Verdict:** APPROVED
**Complexity:** medium
**Security surface:** none
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| conversation.ts defines required types and startConversation | passed | src/conversation/conversation.ts exports ConversationConfig, ConversationSession, ConversationTurnResult, ConversationToolCall; tsc --noEmit exit 0 |
| runner.ts and pipeline.ts byte-for-byte untouched | passed | git diff --stat -- src/runner/runner.ts src/orchestration/pipeline.ts produced no output |
| Per-turn ledger/tool_end listeners attached/unsubscribed in finally every turn | passed | Read src/conversation/conversation.ts: offLedger()/offEvents() called in finally block on every step; test 'exactly one ledger row per turn' passed with sink.records().length === 2 after 2 turns |
| ledger.close() never called in step(); sink closed only once in close() | passed | Reviewed close() implementation: guarded by closed flag, sink.close?.() called once |
| Exports appended after runner block in src/index.ts, append-only | passed | git diff src/index.ts shows new export block immediately after runner exports, no reordering of existing exports |
| package-exports.test.ts pins value export and all types | passed | bun test test/package-exports.test.ts green; startConversation + 5 Conversation* types pinned with standard pattern |
| Two-turn conversation retains history on live branch | passed | bun test: session.findEntries({type:'message'}) shows both turns' user+assistant entries on the durable Session branch, no replay |
| Exactly one ledger row per turn with attach/unsubscribe | passed | bun test: 2 turns yielded exactly 2 sink.records(), not 3+ |
| Tool invoked in turn appears in toolCalls | passed | bun test: tool call with matching toolName and toolCallId captured in result.toolCalls |
| ContextCompactor wired exactly once at startConversation | passed | bun test: compactor attached exactly once, not per-step; attachment test verified |
| Full suite green, no regression vs baseline | passed | bun test (unscoped) -> 159 pass, 0 fail (matching Coder's reported count); tsc --noEmit exit 0 |
| Revert-and-restore proof: tests fail without code, pass with it | passed | Removed src/conversation/ and export lines -> 2 module-not-found errors; restored via backup -> 6 pass; diff confirmed byte-identical pre-proof state |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Two overlapping step() calls without await (Promise.allSettled) | held | Custom test: turn1 completed, turn2 rejected synchronously with 'LaneBusy'; sink.records().length === 1, no duplication. Lane admits/rejects operations synchronously before any async event processing. |
| Empty-string user input to step() | held | pi-agent-core's Lane throws 'InvalidMessage' loudly; same unguarded behavior as runRole's existing lane.prompt call, no regression |
| Calling step() after close() released the harness | held | Threw 'HarnessClosed' error rather than hanging or returning bogus result |
| Custom tool named 'bash' colliding with builtin set | held | startConversation rejected before building harness: 'RunnerError: duplicate tool name "bash"'; assertUniqueToolNames working as specified |

## Issues found and fixed

- none

## Issues left unfixed (advisory)

- none

## Security findings (if any)

- none

## Cost

Output tokens only — no input tokens, no cache reads, no cache writes — so this figure cannot say whether prompt caching is helping, and on a measured run it was 0.2% of the bill. For the rest, run `scripts/ldo-cost.sh <transcriptDir>` after the run: the cache figures exist in the per-agent transcripts, just not here. A per-phase number is a delta measured around that phase, not an attribution: the token pool is shared across the whole turn.

- Total: 82858
- planner (Plan): 26371
- coder (Code): 29836
- reviewer (Review): 26651
