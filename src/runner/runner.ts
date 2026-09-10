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
  Context,
  ExecutionToolContext,
  OperationResultRecord,
  Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Summarizer } from "../context/compactor";
import { ContextCompactor } from "../context/compactor";
import { FileLedgerSink, Ledger, LEDGER_BASE_DIR } from "../ledger/ledger";
import type { LedgerSink } from "../ledger/ledger";
import type { Role } from "../role";
import { toHarnessOptions } from "../role";
import { assertLedgerDirWithinTarget, assertRunId, resolveTargetDir } from "./errors";

/**
 * Everything a single turn needs that is NOT baked into the Role.
 *
 * `targetDir` is REQUIRED and is the agent's working directory: the bash, read,
 * write and edit tools start there and the ledger lands under it. It is NOT the
 * harness's own cwd -- harness-dir and target-dir are distinct by construction.
 *
 * `models`/`model` are the ONLY source of provider credentials. The runner
 * never reads the process environment and never reads a dotenv file under
 * `targetDir`; auth arrives exclusively through the caller-configured models.
 * See the credential-boundary note on `runRole`.
 */
export interface RunRoleParams {
  role: Role;
  /** REQUIRED agent working directory; tools + ledger operate here, not in the harness cwd. */
  targetDir: string;
  models: Models;
  model: Model<Api>;
  prompt: string;
  /** Defaults to a fresh UUID. Validated as a file-name-safe token before any path is built. */
  runId?: string;
  /** Ledger attribution dimension. Defaults to "run". */
  step?: string;
  /** Lane to drive. Defaults to "main" (there is no exported default-lane constant). */
  laneName?: string;
  /** Reuse an existing session; a fresh in-memory session is created otherwise. */
  session?: Session;
  /** When supplied, a ContextCompactor is attached under the role's budget. Absent = no compaction. */
  summarizer?: Summarizer;
  /** Replaces the default file sink under targetDir; nothing touches disk when supplied. */
  ledgerSink?: LedgerSink;
  /** Defaults to BACKGROUND_CONTEXT. */
  context?: Context;
}

/**
 * The settled outcome of one turn.
 *
 * SECURITY: `result` is the full `OperationResultRecord`. It carries request
 * detail and settled-message metadata -- do NOT return or log it wholesale from
 * a place with a stdout discipline (the CLI keeps provider content off stdout).
 * A workflow that hands this record straight back undermines that guarantee;
 * return `runId`/`ledgerPath`/`status` or a narrowed projection instead.
 */
export interface RunRoleResult {
  runId: string;
  /** Absolute ledger path when the default file sink was used; undefined for a custom sink. */
  ledgerPath: string | undefined;
  /** Non-zero means the audit trail has holes for this run. */
  droppedRecords: number;
  result: OperationResultRecord;
}

/**
 * Construct a harness for `role`, root its tools at `targetDir`, attach the
 * ledger (and, if a summarizer is given, the compactor), and drive one
 * `lane.prompt` turn to a settled result.
 *
 * CREDENTIAL BOUNDARY. Provider auth comes ONLY from `params.models`/
 * `params.model`. This function never reads the process environment and never
 * reads a dotenv file under `targetDir`. That boundary additionally assumes the
 * harness process cwd is distinct from `targetDir`: Bun auto-loads a dotenv file
 * from the process cwd into the environment at startup, so launching ad-coder
 * with its cwd inside `targetDir` would fold the target's dotenv into the
 * environment the models are built from -- resolve credentials before/
 * independently of `targetDir`.
 *
 * SANDBOX BOUNDARY. `NodeExecutionEnv({ cwd })` sets the shell's STARTING
 * directory only. It is not a chroot, container, or egress boundary: a bash
 * turn can `cd /`, read any file the harness user can read, and reach the
 * network. `targetDir` content is untrusted. The real gate is the role's
 * `activeToolNames` -- do NOT grant bash to a role that ingests untrusted input
 * without an out-of-process sandbox.
 */
export async function runRole(params: RunRoleParams): Promise<RunRoleResult> {
  const absTargetDir = resolveTargetDir(params.targetDir);
  const runId = assertRunId(params.runId ?? crypto.randomUUID());
  const context = params.context ?? BACKGROUND_CONTEXT;

  const env = new NodeExecutionEnv({ cwd: absTargetDir });
  const toolContext: ExecutionToolContext = { env };
  const tools: AgentHarnessTool<ExecutionToolContext>[] = [
    createBashTool(),
    createReadTool(),
    createWriteTool(),
    createEditTool(),
  ];

  const session = params.session ?? (await new MemorySessionRepo().create({}, context));

  const base = toHarnessOptions(params.role, {
    session,
    models: params.models,
    model: params.model,
  });
  const options: AgentHarnessOptions<ExecutionToolContext> = {
    ...base,
    tools,
    toolContext,
  };

  let ledgerPath: string | undefined;
  let sink: LedgerSink;
  if (params.ledgerSink !== undefined) {
    sink = params.ledgerSink;
  } else {
    assertLedgerDirWithinTarget(absTargetDir, LEDGER_BASE_DIR);
    ledgerPath = path.join(absTargetDir, LEDGER_BASE_DIR, `${runId}.jsonl`);
    sink = new FileLedgerSink(ledgerPath);
  }

  const ledger = new Ledger({
    runId,
    role: params.role.name,
    step: params.step ?? "run",
    sink,
  });

  const compactor =
    params.summarizer !== undefined
      ? new ContextCompactor({ budget: params.role.contextBudget, summarizer: params.summarizer })
      : undefined;

  const { harness } = await AgentHarness.create<ExecutionToolContext>(options, context);
  ledger.attach(harness.hooks);
  compactor?.attach(harness.hooks);

  try {
    const lane = await harness.lane(params.laneName ?? "main", context);
    const result = getOrThrow(await lane.prompt(params.prompt, undefined, context));
    if ("status" in result && result.status === "suspended") {
      // lane.prompt returns OperationResultRecord | SuspendedRun. A single-turn
      // faux/live drive settles; a suspended run means a deferred provider
      // response this convenience path does not resume. Fail loud rather than
      // returning a record the caller would read as settled.
      throw new Error(`runRole: run ${runId} suspended; single-turn drive does not resume deferrals`);
    }
    return {
      runId,
      ledgerPath,
      droppedRecords: ledger.droppedRecords,
      result,
    };
  } finally {
    await harness.close(context);
    ledger.close();
  }
}
