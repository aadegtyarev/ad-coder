import * as path from "node:path";
import type {
  AgentHarnessOptions,
  AgentLane,
  Context,
  ExecutionToolContext,
  Session,
} from "@earendil-works/pi-agent-core";
import { AgentHarness, BACKGROUND_CONTEXT, getOrThrow } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { CompactionPolicy, Summarizer } from "../context/compactor";
import {
  COMPACTION_SAFETY_PROMPT,
  ContextCompactor,
  resolveCompactionPolicy,
} from "../context/compactor";
import { assertContextFitsBudget, assertTurnFitsBudget } from "../context/preflight";
import type { CostAnomalyDetector } from "../economics/cost-anomaly";
import type { LedgerSink } from "../ledger/ledger";
import { FileLedgerSink, Ledger } from "../ledger/ledger";
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
import type { Role } from "../role";
import { toHarnessOptions } from "../role";
import { createBuiltinTools } from "../runner/builtin-tools";
import {
  assertRunId,
  assertUniqueToolNames,
  EmptyTurnError,
  ProviderQuotaError,
  ProviderRejectionError,
  providerQuotaFrom,
  providerRejectionStatusFrom,
  resolveTargetDir,
  SuspendedRunError,
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
  activityChannel?: ToolActivityChannel;
  activityConsumer?: ToolActivityConsumer;
  toolActivity?: Partial<ToolActivityConfig>;
  /** Optional headless source of content-free background lifecycle notices. */
  subscribeBackgroundRuns?: (consumer: BackgroundRunNoticeConsumer) => () => void;
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

/** Options for a single turn. */
export class TurnInterruptedError extends Error {
  readonly code = "interrupted" as const;
  constructor() {
    super("interrupted");
    this.name = "TurnInterruptedError";
  }
}

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
  const builtin = [...createBuiltinTools(env)];
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
  const explicitPolicy =
    config.compaction ??
    (config.summarizer === undefined ? undefined : { mode: "auto", summarizer: config.summarizer });
  const hasOpaqueSummarizer = explicitPolicy?.summarizer !== undefined;
  if (hasOpaqueSummarizer && (controller.limits.maxTurns > 0 || controller.limits.maxCostUsd > 0)) {
    throw new TypeError("custom summarizer cannot be used with positive session limits");
  }
  const compaction = resolveCompactionPolicy(explicitPolicy, limitedModels, config.model);

  const store =
    config.session === undefined
      ? new ProjectStore(absTargetDir, config.projectStoreConfig)
      : undefined;
  const acquiredSession = config.session ?? (await store?.openOrCreateSession(runId, context));
  if (acquiredSession === undefined)
    throw new Error("startConversation: failed to acquire session");
  const session: Session = acquiredSession;

  const base = toHarnessOptions(config.role, {
    session,
    models: recoveredModels,
    model: config.model,
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

  // The compactor is a transform_context handler; attaching it per turn would
  // compound handlers the same way a per-turn ledger attach would compound
  // rows. Attach ONCE here, never in step.
  const compactor =
    compaction.mode === "auto"
      ? new ContextCompactor({
          budget: config.role.contextBudget,
          summarizer: compaction.summarizer as Summarizer,
        })
      : undefined;
  compactor?.attach(harness.hooks);

  const lane: AgentLane = await harness.lane(config.laneName ?? "main", context);

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

  async function step(
    userInput: string,
    opts?: ConversationStepOptions,
  ): Promise<ConversationTurnResult> {
    if (closed) throw new Error("conversation is closed");
    if (stepping) throw new Error("conversation step already active");
    if (laneBusy) {
      throw new Error(
        "conversation lane is still stopping after interruption; wait for the provider call to settle before retrying",
      );
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
      const entries = await lane.findEntries({ type: "message", order: "oldestFirst" }, context);
      const pending = { role: "user" as const, content: userInput, timestamp: Date.now() };
      const messages = [
        ...entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
        pending,
      ];
      if (compaction.mode === "auto") {
        compactor?.assertHealthy(role.name, config.model.contextWindow);
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
      const providerPrompt = lane.prompt(userInput, undefined, context);
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
      const prompted = await Promise.race([providerPrompt, interruption]).catch((error) => {
        if (interrupted) throw new TurnInterruptedError();
        config.costAnomalyDetector?.assertNoBoundaryFailure();
        controller.assertNoBoundaryFailure();
        throw error;
      });
      if (interrupted) throw new TurnInterruptedError();
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
      const assistantText = await extractFinalText(session, context);
      if (result.status !== "completed" && assistantText.trim() === "") {
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
        throw new EmptyTurnError(runId, result.error?.code);
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
          requestAbort();
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
