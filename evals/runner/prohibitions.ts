import type { LedgerRecord } from "../../src/ledger/types";

/**
 * Whether a run honoured the tools a task told it not to use.
 *
 * WHY THE LEDGER. Every response ad-coder records carries the tool NAMES that
 * response requested, for every role and every mode, so a prohibition is
 * checkable without new instrumentation and without a task per prohibition.
 * `orchestrator-tool-use-v1` already proved the shape against the console turn
 * stream; this is the same question asked of the ledger, which every mode
 * writes.
 *
 * WHY NAMES ARE ENOUGH, AND WHERE THEY ARE NOT. The ledger deliberately records
 * no call arguments, so "did the Planner run the test suite" is only answerable
 * as "did the Planner call `bash`". That is a real limit and it decides which
 * prohibitions can be scored here: a whole tool being off-limits can be, a
 * particular USE of an allowed tool cannot. A task must therefore prohibit a
 * tool, not an intention, and say so in its prompt -- scoring a rule the model
 * was never given is the mistake `planner-contract-carry-v1` already made.
 */
export function violatedProhibitions(
  ledger: readonly LedgerRecord[],
  forbidden: readonly string[],
): string[] {
  const called = new Set(ledger.flatMap((row) => Object.keys(row.toolCalls ?? {})));
  return forbidden.filter((tool) => called.has(tool)).sort();
}
