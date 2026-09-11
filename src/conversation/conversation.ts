import * as path from "node:path";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  getOrThrow,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import type {
  AgentHarnessOptions,
  AgentHarnessTool,
  AgentLane,
  Context,
  ExecutionToolContext,
  Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import type { Summarizer } from "../context/compactor";
import { ContextCompactor } from "../context/compactor";
import { FileLedgerSink, Ledger, LEDGER_BASE_DIR } from "../ledger/ledger";
import type { LedgerSink } from "../ledger/ledger";
import type { Role } from "../role";
import { toHarnessOptions } from "../role";
import {
  assertLedgerDirWithinTarget,
  assertRunId,
  assertUniqueToolNames,
  resolveTargetDir,
} from "../runner/errors";
import type { Tool } from "../runner/tool";

/**
 * Everything a multi-turn conversation needs. Mirrors `RunRoleParams` but the
 * harness, lane, ledger sink and compactor are built ONCE at
 * `startConversation` and reused across every `step`; only the per-turn Ledger
 * is rebuilt each turn (see `ConversationSession.step`).
 *
 * CREDENTIAL BOUNDARY. Provider auth comes ONLY from `models`/`model`, exactly
 * as `runRole` (src/runner/runner.ts): never the process environment, never a
 * dotenv under `targetDir`. `targetDir` is the tools' starting directory, not a
 * sandbox.
 */
export interface ConversationConfig {
  role: Role;
  /** REQUIRED agent working directory; tools + ledger operate here, not in the harness cwd. */
  targetDir: string;
  models: Models;
  model: Model<Api>;
  /** Defaults to a fresh UUID. Validated as a file-name-safe token before any path is built. */
  runId?: string;
  /** Lane to drive. Defaults to "main". */
  laneName?: string;
  /** Reuse an existing session; a fresh in-memory session is created otherwise. */
  session?: Session;
  /** When supplied, a ContextCompactor is attached ONCE under the role's budget. Absent = no compaction. */
  summarizer?: Summarizer;
  /** Replaces the default file sink under targetDir; nothing touches disk when supplied. */
  ledgerSink?: LedgerSink;
  /** Defaults to BACKGROUND_CONTEXT. */
  context?: Context;
  /** Custom tools that EXTEND the built-in [bash,read,write,edit] set. See `RunRoleParams.tools`. */
  tools?: Tool[];
}

/** A tool invocation observed during a single turn: names only, never args or content. */
export interface ConversationToolCall {
  toolName: string;
  toolCallId: string;
}

/**
 * The narrowed outcome of one turn.
 *
 * SECURITY: this is the ONLY thing a turn hands back -- deliberately NOT the
 * full `OperationResultRecord`, which carries request detail and settled-message
 * metadata (see the `RunRoleResult` note at src/runner/runner.ts). `status` and
 * `assistantText` are projected from that record; the record itself never leaves
 * `step`.
 */
export interface ConversationTurnResult {
  runId: string;
  /** The ledger step attributed to this turn (`turn:N` unless overridden). */
  step: string;
  status: string;
  assistantText: string;
  toolCalls: ConversationToolCall[];
  /** CUMULATIVE dropped-record count across every turn so far. Non-zero means audit holes. */
  droppedRecords: number;
}

/** Options for a single turn. */
export interface ConversationStepOptions {
  /** Ledger attribution for this turn. Defaults to `turn:N` where N is the 1-based turn index. */
  step?: string;
}

/**
 * A live multi-turn conversation over ONE harness, ONE session branch and ONE
 * ledger sink. `step` re-drives the same `lane.prompt` seam; pi retains history
 * on the durable Session branch tip, so there is no transcript replay. `close`
 * releases the harness and the shared sink exactly once.
 */
export interface ConversationSession {
  step(userInput: string, opts?: ConversationStepOptions): Promise<ConversationTurnResult>;
  close(): Promise<void>;
  readonly runId: string;
  /** Absolute ledger path when the default file sink was used; undefined for a custom sink. */
  readonly ledgerPath: string | undefined;
}

/**
 * Build a harness for `config.role`, root its tools at `config.targetDir`,
 * acquire the lane and attach the compactor (if a summarizer is given) ONCE, and
 * return a `ConversationSession` whose `step` re-drives that lane turn after
 * turn on the same durable Session branch.
 *
 * This is the multi-turn counterpart to `runRole` (src/runner/runner.ts), which
 * stays the single-turn primitive. Both reuse the same seams; the difference is
 * lifetime -- `runRole` builds and closes per turn, this builds once and reuses.
 *
 * CREDENTIAL BOUNDARY / SANDBOX BOUNDARY are identical to `runRole`: auth comes
 * only from `config.models`/`config.model`, and `NodeExecutionEnv({ cwd })` sets
 * the shell's starting directory, not a chroot or egress boundary.
 */
export async function startConversation(config: ConversationConfig): Promise<ConversationSession> {
  const absTargetDir = resolveTargetDir(config.targetDir);
  const runId = assertRunId(config.runId ?? crypto.randomUUID());
  const context = config.context ?? BACKGROUND_CONTEXT;

  const env = new NodeExecutionEnv({ cwd: absTargetDir });
  const toolContext: ExecutionToolContext = { env };
  const builtin: AgentHarnessTool<ExecutionToolContext>[] = [
    createBashTool(),
    createReadTool(),
    createWriteTool(),
    createEditTool(),
  ];
  // Concatenate before validating so the collision guard sees the full set,
  // exactly as runRole does. `?? []` never registers `undefined`.
  const tools = [...builtin, ...(config.tools ?? [])];
  assertUniqueToolNames(tools);

  const session = config.session ?? (await new MemorySessionRepo().create({}, context));

  const base = toHarnessOptions(config.role, {
    session,
    models: config.models,
    model: config.model,
  });
  const options: AgentHarnessOptions<ExecutionToolContext> = {
    ...base,
    tools,
    toolContext,
  };

  let ledgerPath: string | undefined;
  let sink: LedgerSink;
  if (config.ledgerSink !== undefined) {
    sink = config.ledgerSink;
  } else {
    assertLedgerDirWithinTarget(absTargetDir, LEDGER_BASE_DIR);
    ledgerPath = path.join(absTargetDir, LEDGER_BASE_DIR, `${runId}.jsonl`);
    sink = new FileLedgerSink(ledgerPath);
  }

  const { harness } = await AgentHarness.create<ExecutionToolContext>(options, context);

  // The compactor is a transform_context handler; attaching it per turn would
  // compound handlers the same way a per-turn ledger attach would compound
  // rows. Attach ONCE here, never in step.
  if (config.summarizer !== undefined) {
    new ContextCompactor({ budget: config.role.contextBudget, summarizer: config.summarizer }).attach(
      harness.hooks,
    );
  }

  const lane: AgentLane = await harness.lane(config.laneName ?? "main", context);

  const role = config.role;
  let turnCounter = 0;
  let cumulativeDropped = 0;
  let closed = false;

  async function step(
    userInput: string,
    opts?: ConversationStepOptions,
  ): Promise<ConversationTurnResult> {
    const n = ++turnCounter;
    const stepName = opts?.step ?? `turn:${n}`;

    // A FRESH per-turn Ledger sharing the ONE sink. Its attach/unsubscribe must
    // bracket exactly this turn: hooks.on/events.on have no dedup, so a listener
    // left attached would duplicate this turn's rows and tool calls into the
    // next. ledger.close() is never called here -- it would close the SHARED
    // sink; only `close` (below) closes it, exactly once.
    const ledger = new Ledger({ runId, role: role.name, step: stepName, sink });
    const offLedger = ledger.attach(harness.hooks);
    const seen: ConversationToolCall[] = [];
    const offEvents = harness.events.on("tool_end", (event) => {
      seen.push({ toolName: event.toolName, toolCallId: event.toolCallId });
    });

    try {
      const result = getOrThrow(await lane.prompt(userInput, undefined, context));
      if ("status" in result && result.status === "suspended") {
        // lane.prompt returns OperationResultRecord | SuspendedRun. A suspended
        // run is a deferred provider response this loop does not resume; fail
        // loud rather than returning a record the caller reads as settled --
        // same discipline as runRole (src/runner/runner.ts).
        throw new Error(`conversation: run ${runId} suspended; step does not resume deferrals`);
      }
      cumulativeDropped += ledger.droppedRecords;
      return {
        runId,
        step: stepName,
        status: result.status,
        assistantText: await extractFinalText(session, context),
        toolCalls: seen,
        droppedRecords: cumulativeDropped,
      };
    } finally {
      offLedger();
      offEvents();
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    await harness.close(context);
    sink.close?.();
  }

  return {
    step,
    close,
    runId,
    ledgerPath,
  };
}

/**
 * The newest assistant text on the live session branch.
 *
 * Reimplemented (not imported) from the private `extractFinalText` in
 * src/orchestration/pipeline.ts: reading `result.tipId` directly is fragile
 * because a run whose LAST entry is a tool-result would miss the text, so we
 * scan the most recent message entries newest-first for the first assistant
 * message and join its `{ type: 'text' }` blocks, returning `''` when none.
 */
async function extractFinalText(session: Session, context: Context): Promise<string> {
  const entries = await session.findEntries({ type: "message", order: "desc", limit: 20 }, context);
  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message;
    if (message.role !== "assistant") {
      continue;
    }
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}
