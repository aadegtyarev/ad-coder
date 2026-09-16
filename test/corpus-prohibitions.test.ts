import { expect, test } from "bun:test";
import { violatedProhibitions } from "../evals/runner/prohibitions";
import type { LedgerRecord } from "../src/ledger/types";

function row(toolCalls?: Record<string, number>): LedgerRecord {
  return {
    ts: 0,
    runId: "r",
    lane: "l",
    role: "security",
    step: "role:security",
    provider: "p",
    model: "m",
    stopReason: "end_turn",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

test("a forbidden tool is caught in whichever response called it", () => {
  const ledger = [row({ read: 2 }), row(), row({ read: 1, bash: 1 })];
  expect(violatedProhibitions(ledger, ["bash"])).toEqual(["bash"]);
  // A run that never reached for it. The point of the check is that obeying an
  // inconvenient instruction is invisible in the answer's quality, so it has to
  // be visible here or nowhere.
  expect(violatedProhibitions([row({ read: 2 }), row()], ["bash"])).toEqual([]);
});

test("every forbidden tool is named, and nothing else is", () => {
  const ledger = [row({ bash: 1, write: 3, read: 1 })];
  expect(violatedProhibitions(ledger, ["write", "bash"])).toEqual(["bash", "write"]);
  // `read` was called and is not forbidden; naming it would turn the check into
  // a tool inventory, which is not what a task declared.
  expect(violatedProhibitions(ledger, ["edit"])).toEqual([]);
  // A response with no tool calls omits the field entirely rather than carrying
  // an empty object, so the reader must tolerate its absence.
  expect(violatedProhibitions([row()], ["bash"])).toEqual([]);
});
