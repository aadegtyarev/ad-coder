import * as readline from "node:readline";
import { MemoryLedgerSink } from "../ledger/ledger";
import {
  applyTransition,
  autoDriver,
  toPipelineResult,
} from "../orchestration/session";
import type { WorkflowSession } from "../orchestration/session";
import type {
  AvailableTransition,
  PipelineResult,
} from "../orchestration/types";

/**
 * Why a driver's chosen transition was rejected at the drive boundary.
 *
 * - `transition_not_offered`: a driver returned a transition the completed
 *   `step` did not offer (no match by kind+toPhase+toRound). It is a hard,
 *   loud failure BECAUSE a driver -- human, `--auto`, or a future orchestrator
 *   -- must only ever commit an edge the engine itself put on the table; a
 *   forged or reconstructed edge that slipped past would drive the run off its
 *   own graph.
 */
export type DriveErrorCode = "transition_not_offered";

/**
 * Raised when the drive loop is handed a transition the step did not offer.
 * Carries a `code` discriminant and a names-only `detail` holding ONLY the
 * rejected transition's `kind` -- never model text, prompt content, or a runId
 * body. Mirrors `OrchestrationError`/`RunnerError` house style: safe tokens
 * only, dense WHY in JSDoc, nothing that leaks.
 */
export class DriveError extends Error {
  override readonly name = "DriveError";
  readonly code: DriveErrorCode;
  /** The rejected transition's kind (`advance`/`rework`/`stop`). Never content. */
  readonly detail: string;

  constructor(code: DriveErrorCode, detail: string, message: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

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
      "ad-coder: warning: the turn produced no assistant text and cost nothing; " +
      "the provider may need authentication (e.g. codex login) or the model returned nothing\n"
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
 * Reject a transition the step did not offer. Matches by VALUE
 * (kind+toPhase+toRound), not reference identity: `autoDriver` and the human
 * mapping return an object from the offered array, but a future
 * orchestrator-driver may hand a reconstructed-but-equivalent edge, and a
 * reference-only check would wrongly reject it. `step` guarantees each kind is
 * unique within one offered set, so value equality is unambiguous.
 */
export function assertTransitionOffered(
  chosen: AvailableTransition,
  transitions: readonly AvailableTransition[],
): void {
  const offered = transitions.some(
    (t) =>
      t.kind === chosen.kind &&
      t.toPhase === chosen.toPhase &&
      t.toRound === chosen.toRound,
  );
  if (!offered) {
    throw new DriveError(
      "transition_not_offered",
      chosen.kind,
      "chosen transition was not offered by the step",
    );
  }
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
  const takeDefault = (): AvailableTransition | undefined =>
    transitions.find((t) => t.isDefault);
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

  let state = session.initialState();
  try {
    while (!state.done) {
      const costBefore = ledgerSink.records().length;
      const { state: settled, result, transitions } = await session.step(state);
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
      }

      const chosen = auto
        ? autoDriver(transitions)
        : await readChoice(reader as LineReader, transitions, output);
      assertTransitionOffered(chosen, transitions);
      state = applyTransition(settled, chosen);
    }
  } finally {
    reader?.close();
  }

  const pipelineResult = toPipelineResult(state);
  output.write(
    `\napproved: ${pipelineResult.approved} | rounds: ${pipelineResult.rounds} | ` +
      `total cost: $${totalCost(ledgerSink).toFixed(8)}\n`,
  );
  return pipelineResult;
}
