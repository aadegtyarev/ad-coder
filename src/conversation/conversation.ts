import * as path from "node:path";
import type {
  AgentHarnessOptions,
  AgentHarnessTool,
  AgentLane,
  Context,
  ExecutionToolContext,
  JsonValue,
  Session,
} from "@earendil-works/pi-agent-core";
import { AgentHarness, BACKGROUND_CONTEXT, getOrThrow } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { CompactionPolicy, Summarizer } from "../context/compactor";
import {
  attachDurableCompaction,
  COMPACTION_SAFETY_PROMPT,
  type ContextCompactionLostError,
  compactionLostErrorFrom,
  resolveCompactionPolicy,
} from "../context/compactor";
import { assertContextFitsBudget, assertTurnFitsBudget } from "../context/preflight";
import type { CostAnomalyDetector } from "../economics/cost-anomaly";
import type { LedgerSink } from "../ledger/ledger";
import { FileLedgerSink, Ledger } from "../ledger/ledger";
import type { LedgerRecord } from "../ledger/types";
import {
  attachToolActivity,
  type ToolActivityAttachment,
  ToolActivityChannel,
  type ToolActivityConfig,
  type ToolActivityConsumer,
  type ToolActivitySnapshot,
} from "../observability/tool-activity";
import type { BackgroundRunNoticeConsumer } from "../orchestration/background-runs";
import { ProjectStore } from "../project-store/project-store";
import type { ProjectStoreConfig } from "../project-store/types";
import { admissionFailureFrom, type ProviderAdmissionController } from "../provider-admission";
import type { Role } from "../role";
import { toHarnessOptions } from "../role";
import { createBuiltinTools } from "../runner/builtin-tools";
import type { SettledTurnMessage } from "../runner/errors";
import {
  assertRunId,
  assertUniqueToolNames,
  EmptyTurnError,
  GenerationTruncatedError,
  ProviderQuotaError,
  ProviderRejectionError,
  providerErrorCauseFrom,
  providerQuotaFrom,
  providerRejectionStatusFrom,
  resolveTargetDir,
  SuspendedRunError,
  truncatedGenerationFrom,
} from "../runner/errors";
import { wrapModelsForToolCallRecovery } from "../runner/native-tool-calls";
import type { Tool } from "../runner/tool";
import type { SessionLimits } from "../session-limits";
import { SessionLimitController } from "../session-limits";

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
export interface DurableContinuationStatus {
  status?: string;
  next?: string;
}

export interface DurableContinuationCheckpoint {
  version: 1;
  state: "WIP";
  artifact: { type: typeof CONTINUATION_CHECKPOINT_TYPE; id: string };
  work: string;
  reason: string;
  next: string;
  truncated?: true;
}

export const CONTINUATION_CHECKPOINT_TYPE = "console_continuation_checkpoint";
const CONTINUATION_CHECKPOINT_MAX_BYTES = 2_048;
const CONTINUATION_PREAMBLE_MAX_CHARS = 600;

export function truncateContinuationUtf8(
  value: string,
  maxBytes: number,
): {
  value: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { value, truncated: false };
  const marker = "… [truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (maxBytes < markerBytes) return { value: ".".repeat(maxBytes), truncated: true };
  const room = maxBytes - markerBytes;
  let end = Math.min(value.length, room);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > room) end--;
  while (end > 0 && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff)
    end--;
  return { value: `${value.slice(0, end)}${marker}`.slice(0, maxBytes), truncated: true };
}

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
  /** Reuse an existing session; otherwise create or resume the durable session named by runId. */
  session?: Session;
  /** Runtime-store retention and byte limits. Zero/omitted disables each limit. */
  projectStoreConfig?: ProjectStoreConfig;
  /** Legacy summarizer injection seam; absent policy still defaults to auto compaction. */
  summarizer?: Summarizer;
  /** Context policy. Absent defaults to efficient auto compaction. */
  compaction?: CompactionPolicy;
  /** Replaces the default file sink under targetDir; nothing touches disk when supplied. */
  ledgerSink?: LedgerSink;
  /** Defaults to BACKGROUND_CONTEXT. */
  context?: Context;
  /** Custom tools that EXTEND the built-in [bash,read,write,edit] set. See `RunRoleParams.tools`. */
  tools?: Tool[];
  /**
   * Internal seam for the orchestrator front ONLY. It maps the freshly-built
   * built-in array (bash/read/write/edit) to the array actually registered.
   * It may wrap or drop built-ins, but must NOT introduce new names:
   * `assertUniqueToolNames` still guards the concatenated set, and a name
   * introduced here that collides with `tools` would fail exactly as a
   * duplicate today. Delegated role conversations and pipeline stages must
   * NEVER pass it -- the coder edits freely; this is the bound the
   * orchestrator's own direct `edit`/`write` calls travel through (issue
   * #388).
   */
  wrapBuiltinTools?: (
    tools: readonly AgentHarnessTool<ExecutionToolContext>[],
  ) => readonly AgentHarnessTool<ExecutionToolContext>[];
  /** Optional resource thresholds. Zero/omitted disables each threshold. */
  sessionLimits?: SessionLimits;
  /** Internal sharing seam for nested work; takes precedence over sessionLimits. */
  sessionLimitController?: SessionLimitController;
  /**
   * Refuses a turn whose (provider, model) scope the operator has blocked.
   *
   * Carried here because a conversation reaches the provider through its OWN
   * `Models` wrap, not through `runRole`: wiring the detector only into the
   * pipeline left the console -- and the `run_role` tool the orchestrator
   * delegates through -- able to start a run on a scope `cost status` reports
   * as blocked. The block is core behavior, so every front that can begin a
   * turn passes the same gate.
   */
  costAnomalyDetector?: CostAnomalyDetector;
  /**
   * Shared provider-capacity admission boundary (issue #365). Carried here
   * because a conversation reaches the provider through its OWN `Models` wrap,
   * not through `runRole`: wiring admission only into the pipeline left the
   * console — and the `run_role` tool — able to open a provider client that no
   * outermost gate watched.
   */
  providerAdmissionController?: ProviderAdmissionController;
  activityChannel?: ToolActivityChannel;
  activityConsumer?: ToolActivityConsumer;
  toolActivity?: Partial<ToolActivityConfig>;
  /** Optional headless source of content-free background lifecycle notices. */
  subscribeBackgroundRuns?: (consumer: BackgroundRunNoticeConsumer) => () => void;
  /** Mutable status reported by the foreground orchestrator's report_status tool. */
  continuationStatus?: DurableContinuationStatus;
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
  /** Cumulative loss in the ephemeral activity stream. */
  droppedActivityEvents?: number;
}

/**
 * The closed set of reasons a conversation can refuse a turn BEFORE the provider
 * is ever reached (issue #422). One token per refusal check in `step`, in the
 * order those checks run.
 */
export type ConversationRefusalReason = "closed" | "step_active" | "lane_stopping";

/**
 * The authored refusal sentences. The single source of the refusal wording:
 * the console front renders from THIS map, not from the caught value's own
 * `message` (issue #412 discipline -- `instanceof` passing does not make a
 * message read safe), and the ledger refusal row carries the same text. The
 * wording is the pre-typing behavior, kept verbatim.
 */
export const CONVERSATION_REFUSAL_TEXT: Record<ConversationRefusalReason, string> = {
  closed: "conversation is closed",
  step_active: "conversation step already active",
  lane_stopping:
    "conversation lane is still stopping after interruption; wait for the provider call to settle before retrying",
};

/**
 * A house error for a turn the conversation refuses before dispatching to a
 * provider: session closed, a step already active, or the lane still settling
 * after an interruption. Follows the #237 discipline -- an AUTHORED message from
 * the fixed map above, matched BY CLASS at a front, no dynamic content ever.
 */
export class ConversationRefusedError extends Error {
  static readonly CODE = "conversation_refused" as const;
  override readonly name = "ConversationRefusedError";
  readonly code = "conversation_refused" as const;

  constructor(readonly reason: ConversationRefusalReason) {
    super(CONVERSATION_REFUSAL_TEXT[reason]);
  }
}

/**
 * A house error for a `startConversation` call whose durable session could not
 * be SEATED (issue #428). Defensive acquisition guard: it reaches only when a
 * caller supplied no `session` AND the project store still returned no session
 * -- an admission refusal BEFORE any model step, thrown from
 * `startConversation`, never from the step family (which throws
 * `ConversationRefusedError` instead, a closed set that must not grow a new
 * reason for it). Authored message and next action from the class itself --
 * a front renders from THESE constants, never from a caught value's own
 * dynamic text (#412 discipline).
 */
export class SessionNotAcquiredError extends Error {
  static readonly CODE = "session_not_acquired" as const;
  static readonly NEXT_ACTION = "restart the console to open a fresh session" as const;
  override readonly name = "SessionNotAcquiredError";
  readonly code = "session_not_acquired" as const;

  /** `runId` is a validated file-name-safe token, safe as a detail field. */
  constructor(readonly runId: string) {
    super("conversation failed to open or resume its durable session");
  }
}

export class TurnInterruptedError extends Error {
  readonly code = "interrupted" as const;
  constructor(readonly checkpoint?: DurableContinuationCheckpoint) {
    super("interrupted");
    this.name = "TurnInterruptedError";
  }
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
  /** Abort only the currently active turn; the session remains usable afterwards. */
  interrupt?(): Promise<boolean>;
  /** Optional for compatibility with external ConversationSession implementations. */
  subscribeToolActivity?(
    consumer: ToolActivityConsumer,
    options?: { replay?: boolean },
  ): () => void;
  toolActivitySnapshot?(): ToolActivitySnapshot;
  /** Optional content-free pipeline notices; subscribing never starts a model turn. */
  subscribeBackgroundRuns?(consumer: BackgroundRunNoticeConsumer): () => void;
  /** Settled turns initiated by the wake pump, for the owning interactive front. */
  subscribeWakeTurns?(
    consumer: (
      event:
        | { phase: "started"; step: string }
        | { phase: "settled"; result: ConversationTurnResult },
    ) => void,
  ): () => void;
  readonly runId: string;
  /** Absolute ledger path when the default file sink was used; undefined for a custom sink. */
  readonly ledgerPath: string | undefined;
  /**
   * Resolves when the currently-active step settles (no provider work in
   * flight), or immediately when no step is active. A front awaiting this
   * can safely dispatch the next prompt; it is the read-only waiter the
   * internal `activeSettled` promise already serves internally.
   */
  whenSettled(): Promise<void>;
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
  const rawBuiltin = [...createBuiltinTools(env)];
  // The orchestrator-front seam wraps/drops built-ins BEFORE the custom tools
  // are concatenated (issue #388). It must not introduce names; the collision
  // guard below still sees the full set.
  const builtin = config.wrapBuiltinTools ? [...config.wrapBuiltinTools(rawBuiltin)] : rawBuiltin;
  // Concatenate before validating so the collision guard sees the full set,
  // exactly as runRole does. `?? []` never registers `undefined`.
  const tools = [...builtin, ...(config.tools ?? [])];
  assertUniqueToolNames(tools);

  const controller =
    config.sessionLimitController ?? new SessionLimitController(config.sessionLimits);
  const sessionModels = controller.wrap(config.models);
  // OUTERMOST for the same reason as `runRole`: each proxy delegates inward, so
  // the wrapper applied LAST is entered FIRST, and a refused start must not
  // first consume one of the session's counted turns.
  const limitedModels =
    config.costAnomalyDetector?.wrap(sessionModels, config.model.provider, config.model.id) ??
    sessionModels;
  // Also at this boundary: recovery for a provider that serialized a tool call
  // as assistant text instead of a structured tool-call block (issue #292),
  // granted the names this invocation actually registered.
  const recoveredModels = wrapModelsForToolCallRecovery(
    limitedModels,
    tools.map((tool) => tool.name),
  );
  // ADMISSION OUTERMOST, for the same reason as `runRole`: each proxy
  // delegates inward, so the wrapper applied last is entered first, and a
  // saturated scope must refuse before session/stage/cost-anomaly reserve
  // anything. Scope identity is the provider-account id — `config.model.provider`
  // (e.g. `work-openrouter` vs `home-openrouter`, docs/provider-catalogs.md) —
  // passed as both the provider and the account label, never a secret or a raw
  // credential id; `admissionScopeKey` hashes it so only the digest persists.
  const models =
    config.providerAdmissionController?.wrap(
      recoveredModels,
      config.model.provider,
      config.model.provider,
    ) ?? recoveredModels;
  const explicitPolicy =
    config.compaction ??
    (config.summarizer === undefined ? undefined : { mode: "auto", summarizer: config.summarizer });
  const hasOpaqueSummarizer = explicitPolicy?.summarizer !== undefined;
  if (hasOpaqueSummarizer && (controller.limits.maxTurns > 0 || controller.limits.maxCostUsd > 0)) {
    throw new TypeError("custom summarizer cannot be used with positive session limits");
  }
  // The compaction summarizer is an LLM GENERATION PATH, so it rides the same
  // outermost chain the harness turns ride (contract
  // docs/contracts/provider-admission.md: every generation path through
  // admission). `models` is admission -> tool-call recovery -> cost anomaly ->
  // session -- hierarchically IDENTICAL limits to `limitedModels`, only with
  // admission outermost -- mirroring `runRole`, which passes its wrapped
  // `models` here for exactly the same reason. Scope identity matches the turn
  // stream (admission did the wrapping above), so a summarizer call counts
  // against the same scope's concurrency and cooldown and cannot probe a
  // provider whose scope is saturated or standing down.
  const compaction = resolveCompactionPolicy(explicitPolicy, models, config.model);

  const store =
    config.session === undefined
      ? new ProjectStore(absTargetDir, config.projectStoreConfig)
      : undefined;
  const acquiredSession = config.session ?? (await store?.openOrCreateSession(runId, context));
  if (acquiredSession === undefined) throw new SessionNotAcquiredError(runId);
  const session: Session = acquiredSession;

  const base = toHarnessOptions(config.role, {
    session,
    models,
    model: config.model,
    compactionMode: compaction.mode,
  });
  const options: AgentHarnessOptions<ExecutionToolContext> = {
    ...base,
    ...(compaction.mode === "auto" && {
      systemPrompt: `${base.systemPrompt}\n\n${COMPACTION_SAFETY_PROMPT}`,
    }),
    tools,
    toolContext,
  };

  let ledgerPath: string | undefined;
  let sink: LedgerSink;
  if (config.ledgerSink !== undefined) {
    sink = config.ledgerSink;
  } else {
    const projectStore = store ?? new ProjectStore(absTargetDir, config.projectStoreConfig);
    ledgerPath = path.join(projectStore.layout.ledger, `${runId}.jsonl`);
    sink = new FileLedgerSink(ledgerPath, projectStore.byteLimits.jsonlRecord);
  }

  let harness: Awaited<ReturnType<typeof AgentHarness.create<ExecutionToolContext>>>["harness"];
  try {
    ({ harness } = await AgentHarness.create<ExecutionToolContext>(options, context));
  } catch (error) {
    if (store !== undefined) await session.close(context);
    await store?.close(context);
    throw error;
  }

  // The summarizer is a before_compaction handler; attaching it per turn would
  // compound handlers the same way a per-turn ledger attach would compound
  // rows. Attach ONCE here, never in step.
  if (compaction.mode === "auto") {
    attachDurableCompaction(harness.hooks, {
      budget: config.role.contextBudget,
      summarizer: compaction.summarizer as Summarizer,
      // Names only: recorded on the failure so a compaction failure says
      // WHICH model refused it (issue #391).
      ...(compaction.summarizerModel !== undefined && {
        summarizerScope: {
          provider: compaction.summarizerModel.provider,
          model: compaction.summarizerModel.id,
        },
      }),
    });
  }

  const lane: AgentLane = await harness.lane(config.laneName ?? "main", context);
  const continuationStatus = config.continuationStatus;
  const continuationBranch = config.laneName ?? "main";
  const appendContinuationCheckpoint = async (data: JsonValue): Promise<void> => {
    // Every field is bounded before serialization. This is deliberately not a
    // byte-count-and-drop guard: dropping the record would turn valid Unicode
    // progress into a lost task.
    const encoded = JSON.stringify(data);
    if (Buffer.byteLength(encoded, "utf8") > CONTINUATION_CHECKPOINT_MAX_BYTES) {
      throw new Error("continuation checkpoint exceeded its byte bound after truncation");
    }
    const branch = await session.branch(continuationBranch, context);
    if (branch === undefined) {
      throw new Error(
        `cannot persist continuation checkpoint: lane ${continuationBranch} does not exist`,
      );
    }
    await branch.appendCustomEntry(CONTINUATION_CHECKPOINT_TYPE, data, context);
  };
  const checkpoint = async (reason: string): Promise<DurableContinuationCheckpoint> => {
    const rawWork =
      continuationStatus?.status ?? "the foreground console turn (no status was reported)";
    const rawNext = continuationStatus?.next ?? "continue from the durable checkpoint";
    const work = truncateContinuationUtf8(rawWork, 512);
    const next = truncateContinuationUtf8(rawNext, 512);
    const boundedReason = truncateContinuationUtf8(reason, 384);
    const checkpointId = `${runId}:continuation`;
    const record: DurableContinuationCheckpoint = {
      version: 1,
      state: "WIP",
      artifact: { type: CONTINUATION_CHECKPOINT_TYPE, id: checkpointId },
      work: work.value,
      reason: boundedReason.value,
      next: next.value,
      ...((work.truncated || next.truncated || boundedReason.truncated) && { truncated: true }),
    };
    // The fixed metadata plus the three bounded fields fits today, but retain a
    // truthful minimal record if a future serializer adds overhead.
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > CONTINUATION_CHECKPOINT_MAX_BYTES) {
      record.version = 1;
      record.work = "foreground console turn";
      record.reason = "turn interrupted";
      record.next = "continue from durable checkpoint [truncated]";
      record.truncated = true;
    }
    await appendContinuationCheckpoint(record as unknown as JsonValue);
    return record;
  };
  const offContinuationHook = harness.hooks.on(
    "transform_context",
    async (event) => {
      const entries = await session.findEntries({ type: "custom", order: "desc" }, context);
      const entry = entries.find(
        (candidate) =>
          candidate.type === "custom" && candidate.customType === CONTINUATION_CHECKPOINT_TYPE,
      );
      if (entry === undefined || entry.type !== "custom" || entry.data === undefined)
        return undefined;
      const data = entry.data as {
        work?: unknown;
        reason?: unknown;
        next?: unknown;
        consumed?: boolean;
      };
      if (data.consumed === true) return undefined;
      const work = typeof data.work === "string" ? data.work : "the foreground console turn";
      const reason = typeof data.reason === "string" ? data.reason : "the turn was interrupted";
      const next = typeof data.next === "string" ? data.next : "send the next prompt to resume";
      await appendContinuationCheckpoint({ consumed: true });
      return {
        messages: [
          {
            role: "user",
            content:
              `[Continuation preserved] Work: ${work}. Stopped because: ${reason}. Next: ${next}.`.slice(
                0,
                CONTINUATION_PREAMBLE_MAX_CHARS,
              ),
            timestamp: Date.now(),
          },
          ...event.messages,
        ],
      };
    },
    { id: "ad-coder-continuation" },
  );

  const role = config.role;
  const ownsActivityChannel = config.activityChannel === undefined;
  const activityChannel = config.activityChannel ?? new ToolActivityChannel(config.toolActivity);
  const offConfiguredConsumer =
    config.activityConsumer === undefined
      ? undefined
      : activityChannel.subscribe(config.activityConsumer);
  let turnCounter = 0;
  let cumulativeDropped = 0;
  let closed = false;
  let stepping = false;
  let activeSettled: Promise<void> | undefined;
  let settleActive: (() => void) | undefined;
  let activeActivityCleanup: ToolActivityAttachment | undefined;
  let interrupted = false;
  let interruptActive: (() => void) | undefined;
  // A provider can observe abort yet never settle. Do not dispatch another turn
  // into that lane until its original prompt has actually settled.
  let laneBusy = false;
  // The session's compaction is spent, once and for all: the context is over the
  // threshold, no summary can be produced for it, and every later drive would
  // re-attempt -- and re-pay for -- the same doomed compaction before failing
  // the same way. Sticky, and checked before the budget pre-flight, so a spent
  // session refuses without dispatching (issue #391's contract, which the
  // pre-#444 pre-flight assertion used to enforce).
  let spentCompaction: ContextCompactionLostError | undefined;
  let abortRequested = false;
  let closePromise: Promise<void> | undefined;

  const requestAbort = (): void => {
    if (abortRequested) return;
    abortRequested = true;
    // Abort is best-effort: some lane implementations wait for a provider that
    // ignores AbortSignal. Its rejection is observed here, while the active turn
    // is settled through interruptActive below.
    void lane.abort(context).catch(() => {
      if (!closed) {
        console.error(
          "ad-coder: lane abort failed; wait for the active provider call before retrying",
        );
      }
    });
  };

  // Zero usage for a turn that never reached a provider: nothing was read,
  // written or billed -- the numbers that distinguish a refusal row (#422)
  // from a provider-failure row, which carries the provider's own usage.
  const zeroUsage: LedgerRecord["usage"] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  /**
   * Trace a refused turn into the SAME ledger sink every turn uses, then
   * return the typed refusal to throw. Before this, a pre-provider refusal
   * threw with no ledger and no durable trace at all: the run showed 0s, no
   * provider call, and a durable session stuck in `pending` with nothing to
   * explain it (issue #422). The row is attributable by its zero usage plus
   * the `refusal` field, carries ONLY the authored sentence from
   * `CONVERSATION_REFUSAL_TEXT` -- never the prompt, never harness context
   * that is in scope at every throw site -- and a failed write never
   * replaces the refusal itself, exactly as `Ledger.record` treats drops.
   */
  const refusedTurn = (reason: ConversationRefusalReason): ConversationRefusedError => {
    try {
      sink.write({
        ts: Date.now(),
        runId,
        lane: config.laneName ?? "main",
        role: role.name,
        step: `turn:${turnCounter + 1}`,
        provider: config.model.provider,
        model: config.model.id,
        stopReason: "refusal",
        usage: zeroUsage,
        refusal: {
          code: ConversationRefusedError.CODE,
          reason,
          message: CONVERSATION_REFUSAL_TEXT[reason],
        },
      });
    } catch (error) {
      process.stderr.write(
        `ad-coder: ledger write failed, records are being dropped: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    return new ConversationRefusedError(reason);
  };

  async function step(
    userInput: string,
    opts?: ConversationStepOptions,
  ): Promise<ConversationTurnResult> {
    if (closed) {
      throw refusedTurn("closed");
    }
    if (stepping) {
      throw refusedTurn("step_active");
    }
    if (laneBusy) {
      throw refusedTurn("lane_stopping");
    }
    controller.assertActive();
    stepping = true;
    interrupted = false;
    abortRequested = false;
    activeSettled = new Promise<void>((resolve) => {
      settleActive = resolve;
    });
    const n = ++turnCounter;
    const stepName = opts?.step ?? `turn:${n}`;

    try {
      if (spentCompaction !== undefined) throw spentCompaction;
      const entries = await lane.findEntries({ type: "message", order: "oldestFirst" }, context);
      const pending = { role: "user" as const, content: userInput, timestamp: Date.now() };
      const messages = [
        ...entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
        pending,
      ];
      if (compaction.mode === "auto") {
        assertTurnFitsBudget(role, messages, config.model);
      } else {
        assertContextFitsBudget(role, messages, config.model);
      }
    } catch (error) {
      stepping = false;
      settleActive?.();
      settleActive = undefined;
      activeSettled = undefined;
      throw error;
    }

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
    const offActivity = attachToolActivity({
      channel: activityChannel,
      events: harness.events,
      targetDir: absTargetDir,
      role: role.name,
      runId,
      step: stepName,
    });
    activeActivityCleanup = offActivity;

    try {
      laneBusy = true;
      // A conversation reopened after a process kill still OWNS the operation
      // that was in flight when the process died: the durable state records
      // `control.status` "running", so the lane refuses every new prompt with
      // LaneBusy -- an untyped harness error, which the console could only
      // render as a bare "console turn failed" before any provider call. That
      // made a killed session unresumable in practice: every turn after
      // `--resume` died the same way, with no ledger row to explain it.
      //
      // The single-turn runner already drives exactly this case when it is
      // asked to resume a stage (`resumeActiveOperation`,
      // src/runner/runner.ts) -- settle the installed operation first, then
      // decide what to run. The multi-turn conversation is that primitive's
      // counterpart (`startConversation`), so it settles the interrupted
      // operation the same way and only then dispatches the operator's turn.
      // The recovered turn's own answer stays in the durable history; this
      // step returns the answer to the input the operator just sent.
      const providerPrompt = (async () => {
        const execution = await lane.inspectExecution(context);
        if (execution.current === null) return lane.prompt(userInput, undefined, context);
        const recovered = getOrThrow(await lane.resume(context));
        if ("status" in recovered && recovered.status === "suspended") {
          // Settling left the lane occupied by a deferred run, exactly as a
          // suspended prompt would; the same typed refusal applies, because a
          // record the caller reads as settled would hide a run still pending.
          throw new SuspendedRunError(runId);
        }
        return lane.prompt(userInput, undefined, context);
      })();
      // Always observe the detached provider result. This both prevents a late
      // rejection from becoming unhandled and releases the lane only when its
      // original operation has really stopped.
      void providerPrompt.then(
        () => {
          laneBusy = false;
        },
        () => {
          laneBusy = false;
        },
      );
      const interruption = new Promise<never>((_resolve, reject) => {
        interruptActive = () => reject(new TurnInterruptedError());
      });
      const prompted = await Promise.race([providerPrompt, interruption]).catch(async (error) => {
        if (interrupted) {
          const preserved = await checkpoint("Escape/Ctrl-C interrupted the provider turn");
          throw new TurnInterruptedError(preserved);
        }
        config.costAnomalyDetector?.assertNoBoundaryFailure();
        controller.assertNoBoundaryFailure();
        throw error;
      });
      if (interrupted) {
        const preserved = await checkpoint("Escape/Ctrl-C interrupted the provider turn");
        throw new TurnInterruptedError(preserved);
      }
      config.costAnomalyDetector?.assertNoBoundaryFailure();
      controller.assertNoBoundaryFailure();
      const result = getOrThrow(prompted);
      if ("status" in result && result.status === "suspended") {
        // lane.prompt returns OperationResultRecord | SuspendedRun. A suspended
        // run is a deferred provider response this loop does not resume; fail
        // loud rather than returning a record the caller reads as settled --
        // same discipline as runRole (src/runner/runner.ts).
        throw new SuspendedRunError(runId);
      }
      const finalMessage = await newestAssistantMessage(session, context);
      const assistantText = assistantMessageText(finalMessage);
      if (result.status !== "completed") {
        // The harness could not produce the compaction this run needed, so the
        // run itself settled as failed. That is not an empty turn and not a
        // provider refusal: the session's context can no longer be summarized,
        // and the answer is to reopen it, not to retry it (#444, #391).
        //
        // Classified BEFORE the empty-answer projection and outside it: a run
        // that fails on turn N leaves turn N-1's answer as the newest assistant
        // message on the branch, so `assistantText` is not empty and a check
        // nested under that condition would report the failed run as a
        // completed one. The compaction stop is the one settled failure this
        // loop types even when text survives, because retrying cannot clear it.
        const compactionLost = compactionLostErrorFrom(result.error, {
          role: role.name,
          budget: role.contextBudget,
          contextWindow: config.model.contextWindow,
        });
        if (compactionLost !== undefined) {
          spentCompaction = compactionLost;
          throw compactionLost;
        }
      }
      if (assistantText.trim() === "") {
        if (result.status !== "completed") {
          // An admission refusal settles as a stream-terminal error message, and
          // the durable drive composes every settled failure as
          // `assistant_error` -- the typed class is destroyed at that boundary
          // exactly as an HTTP status is. Recover it BEFORE the empty-turn
          // projection: "verify authentication" is the wrong instruction for a
          // scope this conversation saturated, and `queue_saturated` is
          // retryable while an empty turn is not.
          if (config.providerAdmissionController !== undefined) {
            const admissionFailure = admissionFailureFrom(result.error, config.model.provider);
            if (admissionFailure !== undefined) throw admissionFailure;
          }
          // Same attribution rule as runRole: a named client-error status means
          // the provider answered and refused, which is not an authentication
          // failure. See ProviderRejectionError for why only the number crosses.
          // Quota/rate-limit (429) is classified first, for the same reason as
          // runRole: a spent quota is not a request-shape problem and not a
          // credential problem (#356).
          const quota = providerQuotaFrom(result.error);
          if (quota !== undefined)
            throw new ProviderQuotaError(runId, quota.providerCode, quota.retryAfterMs);
          const rejection = providerRejectionStatusFrom(result.error);
          if (rejection !== undefined) throw new ProviderRejectionError(runId, rejection);
          // A generation that ran and produced nothing usable is a truncation,
          // not an empty turn: the provider answered, the tokens were spent, and
          // "verify authentication" cannot fix either (#368). An error/aborted
          // stop is a failure marker, not a settled generation, and keeps the
          // empty-turn wording.
          const truncated = truncatedGenerationFrom(finalMessage);
          if (truncated !== undefined) {
            throw new GenerationTruncatedError(
              runId,
              truncated.stopReason,
              truncated.outputTokens,
              truncated.reasoningTokens,
            );
          }
          // Bounded provider-cause enrichment for the FALLBACK only (#418),
          // same as the runner's settled-failure boundary: none of the
          // allow-list classifications above owned this failure, so the cause
          // the provider actually named must still cross. Extraction is
          // bounded by `providerErrorCauseFrom`/the `EmptyTurnError`
          // constructor; the message never carries provider prose or a body.
          const cause =
            providerErrorCauseFrom(result.error) ??
            providerErrorCauseFrom({
              ...(typeof finalMessage?.errorMessage === "string" && {
                message: finalMessage.errorMessage,
              }),
            });
          throw new EmptyTurnError(runId, result.error?.code, cause?.status, cause?.code);
        }
        // A settled-SUCCESS turn with no answer text is still not a completed
        // turn when the final assistant message carries nothing usable (#368):
        // the provider answered, so every failure classification above is gated
        // behind a status check that never fired, and a generation truncated by
        // the output limit (whole budget spent on reasoning) reached the caller
        // as an empty success. A text block or a tool call is usable content;
        // only silence -- thinking-only or empty -- classifies here.
        const truncated = truncatedGenerationFrom(finalMessage);
        if (truncated !== undefined) {
          throw new GenerationTruncatedError(
            runId,
            truncated.stopReason,
            truncated.outputTokens,
            truncated.reasoningTokens,
          );
        }
        // Same bounded provider-cause enrichment as the settled-FAILURE
        // fallback above (#418): a completed-but-silent turn carries no
        // `result.error`, so the message channel is often the only one; both
        // are read for the bounded status/code pair and nothing else crosses.
        const cause =
          providerErrorCauseFrom(result.error) ??
          providerErrorCauseFrom({
            ...(typeof finalMessage?.errorMessage === "string" && {
              message: finalMessage.errorMessage,
            }),
          });
        throw new EmptyTurnError(runId, result.error?.code, cause?.status, cause?.code);
      }
      cumulativeDropped += ledger.droppedRecords;
      return {
        runId,
        step: stepName,
        status: result.status,
        assistantText,
        toolCalls: seen,
        droppedRecords: cumulativeDropped,
        droppedActivityEvents: activityChannel.droppedCount,
      };
    } finally {
      offLedger();
      offEvents();
      offActivity();
      if (activeActivityCleanup === offActivity) activeActivityCleanup = undefined;
      interruptActive = undefined;
      stepping = false;
      settleActive?.();
      settleActive = undefined;
      activeSettled = undefined;
    }
  }

  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    closePromise = (async () => {
      try {
        if (stepping) {
          const settled = activeSettled;
          const activity = activeActivityCleanup;
          void requestAbort();
          activity?.cancelActive();
          if (settled !== undefined && activityChannel.config.closeDrainMs > 0) {
            await Promise.race([
              settled,
              new Promise<void>((resolve) =>
                setTimeout(resolve, activityChannel.config.closeDrainMs),
              ),
            ]);
          }
        }
        const closingHarness = harness.close(context).catch((error) => {
          if (!stepping) throw error;
        });
        if (activityChannel.config.closeDrainMs > 0) {
          await Promise.race([
            closingHarness,
            new Promise<void>((resolve) =>
              setTimeout(resolve, activityChannel.config.closeDrainMs),
            ),
          ]);
        }
      } finally {
        offContinuationHook();
        activeActivityCleanup?.();
        activeActivityCleanup = undefined;
        if (ownsActivityChannel) await activityChannel.close();
        else offConfiguredConsumer?.();
        if (config.model.api === "openai-codex-responses") {
          closeOpenAICodexWebSocketSessions(runId);
        }
        sink.close?.();
        await store?.close(context);
      }
    })();
    return closePromise;
  }

  return {
    step,
    interrupt: async () => {
      if (!stepping) return false;
      interrupted = true;
      activeActivityCleanup?.cancelActive();
      interruptActive?.();
      requestAbort();
      return true;
    },
    close,
    subscribeToolActivity: (consumer, options) => activityChannel.subscribe(consumer, options),
    toolActivitySnapshot: () => activityChannel.snapshot(),
    ...(config.subscribeBackgroundRuns !== undefined && {
      subscribeBackgroundRuns: config.subscribeBackgroundRuns,
    }),
    runId,
    ledgerPath,
    whenSettled: () => activeSettled ?? Promise.resolve(),
  };
}

/**
 * The newest assistant message on the live session branch, or `undefined` when
 * the session carries none.
 *
 * Reimplemented (not imported) from the private scan in
 * src/orchestration/pipeline.ts: reading `result.tipId` directly is fragile
 * because a run whose LAST entry is a tool-result would miss the message, so we
 * scan the most recent message entries newest-first for the first assistant
 * message. The settled-turn boundary reads BOTH the message's text and its
 * stop reason/usage (#368), so it needs the message, not only its text.
 */
async function newestAssistantMessage(
  session: Session,
  context: Context,
): Promise<SettledTurnMessage | undefined> {
  const entries = await session.findEntries({ type: "message", order: "desc", limit: 20 }, context);
  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message;
    if (message.role !== "assistant") {
      continue;
    }
    return message;
  }
  return undefined;
}

/** The answer text of the newest assistant message: its joined text blocks. */
function assistantMessageText(message: SettledTurnMessage | undefined): string {
  if (message === undefined) {
    return "";
  }
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}
