import * as readline from "node:readline";
import type { MemoryLedgerSink } from "../ledger/ledger";
import type { WorkflowSession } from "../orchestration/session";
import { autoDriver } from "../orchestration/session";
import { assertTransitionOffered } from "../orchestration/transition-guard";
import type { AvailableTransition, PipelineResult } from "../orchestration/types";
import { OrchestrationError } from "../orchestration/types";
import { ProjectOperationsError } from "../project-operations/errors";
import { RunCoordinator, type RunCoordinatorOptions } from "../project-operations/run-coordinator";
import { EmptyTurnError } from "../runner/errors";

export type { DriveErrorCode } from "../orchestration/transition-guard";
// The transition guard (DriveError/DriveErrorCode/assertTransitionOffered) lives
// in ../orchestration/transition-guard so a core module (the orchestrator) can
// depend on it without pulling in this CLI front. Re-exported byte-for-byte so
// every existing importer (src/index.ts, the drive tests) is unchanged.
export { assertTransitionOffered, DriveError } from "../orchestration/transition-guard";

/**
 * The operator-facing signal for a silent no-op turn: empty assistant text AND
 * zero recorded cost together mean nothing happened, which most often means the
 * provider needs authentication (e.g. `codex login`) or the model returned
 * nothing. Returns the fixed warning string in that case, otherwise `undefined`
 * -- a nonzero cost or any assistant text is a real turn and needs no warning.
 */
export function silentNoopWarning(text: string, cost: number): string | undefined {
  if (text.trim() === "" && cost === 0) {
    return (
      "ad-coder: empty_turn: the provider returned no usable output; " +
      "verify authentication (for example, codex login) and retry\n"
    );
  }
  return undefined;
}

/** Everything `driveWorkflow` needs; every stream is injected so the loop is TTY-free. */
export interface DriveWorkflowParams {
  session: WorkflowSession;
  ledgerSink: MemoryLedgerSink;
  auto: boolean;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  error: NodeJS.WritableStream;
  coordinator?: RunCoordinator;
  coordinatorOptions?: RunCoordinatorOptions;
}

/**
 * Sum the cost of the ledger records appended in the half-open range
 * [from, to). Per-step cost is attributed by POSITION, not by a runId join: a
 * record's `runId` is the harness operation id (`event.runId`), NOT the ledger's
 * file-name/step runId that `session.step` reports on `result.runId` (see the
 * Ledger.record note in src/ledger/ledger.ts and test/runner.test.ts) -- so
 * matching `record.runId === result.runId` never held and reported $0 for every
 * step while the total was right. The drive loop runs one role turn per step,
 * awaited to completion with no concurrency, so the records the sink grew by
 * during that await ARE exactly that step's records.
 */
function costForRange(ledgerSink: MemoryLedgerSink, from: number, to: number): number {
  let cost = 0;
  const records = ledgerSink.records();
  for (let i = from; i < to; i++) {
    cost += records[i]?.usage.cost.total ?? 0;
  }
  return cost;
}

/** Sum the total cost across every ledger record the whole run produced. */
function totalCost(ledgerSink: MemoryLedgerSink): number {
  let cost = 0;
  for (const record of ledgerSink.records()) {
    cost += record.usage.cost.total;
  }
  return cost;
}

/**
 * A line reader over an injected stream that SURVIVES the stream's EOF.
 *
 * WHY not `rl.question`: readline consumes a finite scripted `Readable` eagerly
 * and fires `close` at EOF, so a `question` issued after the (still-running,
 * async) step turn completes throws `ERR_USE_AFTER_CLOSE`. Buffering `line`
 * events into a queue decouples reading from asking: a queued line answers
 * immediately, a pending ask waits, and EOF resolves any waiter with `undefined`
 * so the caller can fall back rather than hang.
 */
interface LineReader {
  next(): Promise<string | undefined>;
  close(): void;
}

function createLineReader(input: NodeJS.ReadableStream): LineReader {
  const rl = readline.createInterface({ input });
  const buffered: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];
  let closed = false;
  rl.on("line", (line: string) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      buffered.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      (waiters.shift() as (line: string | undefined) => void)(undefined);
    }
  });
  return {
    next(): Promise<string | undefined> {
      if (buffered.length > 0) {
        return Promise.resolve(buffered.shift());
      }
      if (closed) {
        return Promise.resolve(undefined);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    close(): void {
      rl.close();
    },
  };
}

/**
 * Prompt the operator for a choice among the offered transitions and map the
 * reply to one of them: an empty line takes the default, a case-insensitive
 * kind (`advance`/`rework`/`stop`) or a 1-based index selects that edge, and
 * anything else re-prompts. When the input stream is exhausted (`undefined`),
 * the default is taken so a scripted or piped run cannot hang on a half-consumed
 * prompt; a step with no default is the only case that then errors.
 */
async function readChoice(
  reader: LineReader,
  transitions: AvailableTransition[],
  output: NodeJS.WritableStream,
): Promise<AvailableTransition> {
  const takeDefault = (): AvailableTransition | undefined => transitions.find((t) => t.isDefault);
  for (;;) {
    output.write("transitions:\n");
    transitions.forEach((t, i) => {
      const marker = t.isDefault ? " (default)" : "";
      output.write(`  ${i + 1}) ${t.kind} -> ${t.toPhase} (round ${t.toRound})${marker}\n`);
    });
    output.write("choose [kind, number, or empty for default]: ");
    const line = await reader.next();
    if (line === undefined) {
      const fallback = takeDefault();
      if (fallback !== undefined) {
        return fallback;
      }
      throw new Error("input exhausted and this step has no default transition");
    }
    const answer = line.trim();
    if (answer === "") {
      const fallback = takeDefault();
      if (fallback !== undefined) {
        return fallback;
      }
      output.write("no default transition; enter a kind or number\n");
      continue;
    }
    const lower = answer.toLowerCase();
    const byKind = transitions.find((t) => t.kind === lower);
    if (byKind !== undefined) {
      return byKind;
    }
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= transitions.length) {
      return transitions[index - 1] as AvailableTransition;
    }
    output.write(`unrecognized choice: ${answer}\n`);
  }
}

/**
 * Drive the stepped workflow engine one phase at a time over injected streams.
 *
 * The loop steps until the state settles: it prints each turn's phase/runId, its
 * key assistant text and any verdict/plan, and the per-step cost summed from the
 * ledger. On a silent no-op turn (empty text AND zero cost) it writes the
 * `silentNoopWarning` to the error stream. A driver then chooses the next edge:
 * `--auto` uses `autoDriver` (reproducing `runPipeline`) and never reads input;
 * otherwise the operator's choice is read from `input` via `node:readline`. The
 * chosen edge is validated by `assertTransitionOffered` -- the guard the future
 * orchestrator-driver relies on -- before the pure `applyTransition` commits it.
 *
 * Model-authored step text is printed as DATA only; this front opens no new
 * shell/SQL/path/URL sink and adds nothing to the credential boundary.
 */
export async function driveWorkflow(params: DriveWorkflowParams): Promise<PipelineResult> {
  const { session, ledgerSink, auto, input, output, error } = params;
  // Never open a reader in --auto mode: it would consume/block on the injected
  // input stream in a script or CI where nothing is piped in.
  const reader = auto ? undefined : createLineReader(input);

  try {
    const coordinator =
      params.coordinator ??
      new RunCoordinator(session, session.projectStore, params.coordinatorOptions);
    let costBefore = ledgerSink.records().length;
    const completed = await coordinator.run(
      async (transitions) => {
        const chosen = auto
          ? autoDriver(transitions)
          : await readChoice(reader as LineReader, transitions, output);
        assertTransitionOffered(chosen, transitions);
        return chosen;
      },
      async ({ result }) => {
        output.write(`\n[${result.phase}] runId ${result.runId}\n`);
        if (result.text.trim() !== "") {
          output.write(`${result.text}\n`);
        }
        if (result.verdict !== undefined) {
          output.write(`verdict: ${result.verdict.status} -- ${result.verdict.summary}\n`);
        }
        if (result.plan !== undefined) {
          output.write(
            `plan: complexity ${result.plan.complexity}, security ${result.plan.securitySurface}\n`,
          );
        }
        const stepCost = costForRange(ledgerSink, costBefore, ledgerSink.records().length);
        output.write(`cost: $${stepCost.toFixed(8)}\n`);
        const warning = silentNoopWarning(result.text, stepCost);
        if (warning !== undefined) {
          error.write(warning);
          throw new EmptyTurnError(result.runId);
        }
        costBefore = ledgerSink.records().length;
      },
    );
    if (completed.result === undefined) {
      if (completed.status === "paused" && completed.checkpoint.pause !== undefined) {
        error.write(
          `ad-coder: pipeline paused; runId=${completed.checkpoint.runId} ` +
            `checkpoint=${coordinator.checkpointFile}\n` +
            `resume: ad-coder drive <same-task> --resume-run ${completed.checkpoint.runId} <same-options>\n`,
        );
        throw new OrchestrationError(
          "requirements_unresolved",
          completed.checkpoint.runId,
          completed.checkpoint.pause.action,
        );
      }
      const pending = completed.checkpoint.decisions.find(
        (decision) => decision.status === "pending",
      );
      throw new ProjectOperationsError(
        "pending_decision",
        pending?.id ?? completed.checkpoint.runId,
      );
    }
    output.write(
      `\napproved: ${completed.result.approved} | rounds: ${completed.result.rounds} | ` +
        `total cost: $${totalCost(ledgerSink).toFixed(8)}\n`,
    );
    return completed.result;
  } finally {
    reader?.close();
  }
}
