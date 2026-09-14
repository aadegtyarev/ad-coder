import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentHarnessOptions,
  AgentHarnessTool,
  Context,
  ExecutionToolContext,
  OperationResultRecord,
  Session,
} from "@earendil-works/pi-agent-core";
import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { requireModelAuthentication } from "../auth/operations";
import type { CompactionPolicy, Summarizer } from "../context/compactor";
import {
  COMPACTION_SAFETY_PROMPT,
  ContextCompactor,
  resolveCompactionPolicy,
} from "../context/compactor";
import { assertContextFitsBudget, assertTurnFitsBudget } from "../context/preflight";
import type { LedgerSink } from "../ledger/ledger";
import { FileLedgerSink, Ledger } from "../ledger/ledger";
import {
  attachToolActivity,
  ToolActivityChannel,
  type ToolActivityConfig,
  type ToolActivityConsumer,
} from "../observability/tool-activity";
import { type StageLimitController, StageLimitError } from "../orchestration/stage-limits";
import { ProjectStore } from "../project-store/project-store";
import type { ProjectStoreConfig } from "../project-store/types";
import type { Role } from "../role";
import { toHarnessOptions } from "../role";
import type { SessionLimitController } from "../session-limits";
import {
  assertRunId,
  assertUniqueToolNames,
  EmptyTurnError,
  providerLimitFrom,
  RunInterruptedError,
  RunnerError,
  resolveTargetDir,
} from "./errors";
import type { Tool } from "./tool";

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
  /** Continue the durable active lane operation instead of admitting a new prompt. */
  resumeActiveOperation?: boolean;
  /** Defaults to a fresh UUID. Validated as a file-name-safe token before any path is built. */
  runId?: string;
  /** Ledger attribution dimension. Defaults to "run". */
  step?: string;
  /** Lane to drive. Defaults to "main" (there is no exported default-lane constant). */
  laneName?: string;
  /** Reuse an existing session; a target-rooted durable session is created otherwise. */
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
  /**
   * Custom tools that EXTEND the built-in [bash,read,write,edit] set for this
   * turn. Absent means today's behavior exactly -- only the built-ins register.
   *
   * A name that collides with a built-in OR with another custom tool is rejected
   * with a typed `RunnerError` (code `tool_name_collision`) before the harness is
   * built, rather than silently shadowing. `activeToolNames` still gates the
   * COMBINED set: a role exposes a custom tool only by listing its name, and a
   * custom tool absent from a non-empty `activeToolNames` is filtered out exactly
   * like a built-in.
   */
  tools?: Tool[];
  /** Shared model-call controller for a larger session. */
  sessionLimitController?: SessionLimitController;
  /** Per-role-stage controller; zero-valued limits preserve prior behavior. */
  stageLimitController?: StageLimitController;
  /** Zero disables each legacy read-observation limit. */
  observability?: { maxReadPaths?: number; maxReadPathBytes?: number };
  /** Optional shared activity channel. A private channel is created when only a consumer is supplied. */
  activityChannel?: ToolActivityChannel;
  /** Optional lifecycle consumer; failures are isolated and counted by the channel. */
  activityConsumer?: ToolActivityConsumer;
  /** Bounded tool-activity settings used when this call creates its own channel. */
  toolActivity?: Partial<ToolActivityConfig>;
  /** Monotonic milliseconds seam for deterministic duration metrics. */
  monotonicNow?: () => number;
  /** Cancels a live harness turn and leaves the durable session resumable. */
  abortSignal?: AbortSignal;
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
  /** Non-zero means one or more ephemeral activity deliveries were lost. */
  droppedActivityEvents?: number;
  result: OperationResultRecord;
  observations: RoleObservations;
}

export interface RoleObservations {
  /** Additive safe efficiency fields; runRole always supplies them. */
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  durationMs?: number;
  input: number;
  cachedInput: number;
  freshInput: number;
  output: number;
  reasoning?: number;
  costUsd?: number;
  /** UTF-8 request-assembly sizes before provider-specific serialization. */
  requestBytes: {
    systemPrompt: number;
    prompt: number;
    toolDefinitions: number;
    total: number;
  };
  readFiles: string[];
  readFilesTotal: number;
  readFilesTruncated: number;
  diffBytes: number;
  contextStrategy: "auto" | "disabled-then-halt";
}

const SAFE_DIFF_ARGV = ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"] as const;
const SAFE_DIFF_NAMES_ARGV = [
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
  "--no-renames",
] as const;
export const DEFAULT_CHANGED_PATH_PROJECTION_LIMITS = {
  maxPaths: 128,
  maxPathBytes: 1024,
  maxAggregateBytes: 32 * 1024,
} as const;
const MAX_USAGE_INTEGER = 1_000_000_000_000;
const MAX_USAGE_NUMBER = 1_000_000_000;

function boundedUsageInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_USAGE_INTEGER)
    throw new RangeError(`provider ${field} usage is outside the safe range`);
  return value;
}

function boundedUsageNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_USAGE_NUMBER)
    throw new RangeError(`provider ${field} metric is outside the safe range`);
  return value;
}

function addUsageInteger(total: number, value: number, field: string): number {
  return boundedUsageInteger(total + boundedUsageInteger(value, field), field);
}

function addUsageNumber(total: number, value: number, field: string): number {
  return boundedUsageNumber(total + boundedUsageNumber(value, field), field);
}

function publicMetricLabel(value: string): string {
  if (
    Buffer.byteLength(value) > 100 ||
    !/^[A-Za-z0-9._:/-]+$/.test(value) ||
    value.includes("://") ||
    /(?:secret|token|credential|password|api[_-]?key)/i.test(value)
  )
    return "unknown";
  return value;
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return {
    ...environment,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
  };
}

function isSafeReportedPath(value: string): boolean {
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint < 32 ||
      codePoint === 127 ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      /\p{Cf}/u.test(character)
    );
  });
}

/** Stream and discard diff content so observability cannot buffer an unbounded patch. */
export function measureSafeGitDiffBytes(
  targetDir: string,
  spawnGit: typeof spawn = spawn,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnGit("git", [...SAFE_DIFF_ARGV], {
      cwd: targetDir,
      env: safeGitEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
    });
    child.once("error", () =>
      reject(new RunnerError("diff_metric_failed", targetDir, "git diff metric failed")),
    );
    child.once("close", (code) => {
      if (code === 0) resolve(bytes);
      else if (code === 129)
        resolve(0); // A target without a Git worktree has no measurable diff.
      else reject(new RunnerError("diff_metric_failed", targetDir, "git diff metric failed"));
    });
  });
}

export interface SafeGitChangedFiles {
  files: string[];
  total: number;
  truncated: number;
}

export interface SafeGitDiffProjection {
  text: string;
  bytes: number;
  sha256: string;
  redactedLines: number;
}

const DIFF_SECRET =
  /(?:bearer\s+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]|(?:^|\W)sk-[a-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

/** Read one bounded patch projection and redact credential-like added lines. */
export function readSafeGitDiffProjection(
  targetDir: string,
  maxBytes: number,
  spawnGit: typeof spawn = spawn,
): Promise<SafeGitDiffProjection> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    return Promise.reject(new RangeError("maxBytes must be a positive safe integer"));
  return new Promise((resolve, reject) => {
    const child = spawnGit("git", [...SAFE_DIFF_ARGV], {
      cwd: targetDir,
      env: safeGitEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= maxBytes) chunks.push(chunk);
      else overflow = true;
    });
    child.once("error", () =>
      reject(new RunnerError("diff_metric_failed", targetDir, "git diff projection failed")),
    );
    child.once("close", (code) => {
      if (code === 129)
        return resolve({
          text: "",
          bytes: 0,
          sha256: createHash("sha256").digest("hex"),
          redactedLines: 0,
        });
      if (code !== 0 || overflow)
        return reject(
          new RunnerError("diff_metric_failed", targetDir, "git diff projection failed"),
        );
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return reject(new RunnerError("diff_metric_failed", targetDir, "git diff is not UTF-8"));
      }
      let redactedLines = 0;
      const text = decoded
        .split("\n")
        .map((line) => {
          const isHeader =
            line.startsWith("diff --git ") ||
            line.startsWith("index ") ||
            line.startsWith("--- ") ||
            line.startsWith("+++ ") ||
            line.startsWith("@@ ");
          if (!isHeader && DIFF_SECRET.test(line)) {
            redactedLines += 1;
            return "+[REDACTED: possible credential]";
          }
          return line;
        })
        .join("\n");
      resolve({
        text,
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
        redactedLines,
      });
    });
  });
}

/** Read changed names with NUL framing and mandatory positive safety ceilings. */
export function readSafeGitChangedFiles(
  targetDir: string,
  spawnGit: typeof spawn = spawn,
  limits: {
    maxPaths: number;
    maxPathBytes: number;
    maxAggregateBytes: number;
  } = DEFAULT_CHANGED_PATH_PROJECTION_LIMITS,
): Promise<SafeGitChangedFiles> {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      return Promise.reject(new RangeError(`${name} must be a positive safe integer`));
  }
  return new Promise((resolve, reject) => {
    const child = spawnGit("git", [...SAFE_DIFF_NAMES_ARGV], {
      cwd: targetDir,
      env: safeGitEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= limits.maxAggregateBytes) chunks.push(chunk);
      else overflow = true;
    });
    child.once("error", () =>
      reject(new RunnerError("diff_metric_failed", targetDir, "git changed paths failed")),
    );
    child.once("close", (code) => {
      if (code === 129) return resolve({ files: [], total: 0, truncated: 0 });
      if (code !== 0 || overflow)
        return reject(new RunnerError("diff_metric_failed", targetDir, "git changed paths failed"));
      let decoded: string;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return reject(
          new RunnerError("diff_metric_failed", targetDir, "git changed path is not UTF-8"),
        );
      }
      const entries = decoded.split("\0").filter(Boolean);
      const names = entries.map((entry) => entry.slice(3));
      const safe = names.filter(
        (name) =>
          Buffer.byteLength(name) <= limits.maxPathBytes &&
          !path.isAbsolute(name) &&
          !name.split("/").includes("..") &&
          isSafeReportedPath(name),
      );
      if (safe.length !== names.length)
        return reject(
          new RunnerError("diff_metric_failed", targetDir, "git changed path is unsafe"),
        );
      resolve({
        files: safe.slice(0, limits.maxPaths),
        total: safe.length,
        truncated: Math.max(0, safe.length - limits.maxPaths),
      });
    });
  });
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
  const monotonicNow = params.monotonicNow ?? (() => performance.now());
  const roleStartedAt = monotonicNow();
  const absTargetDir = resolveTargetDir(params.targetDir);
  const runId = assertRunId(params.runId ?? crypto.randomUUID());
  const context = params.context ?? BACKGROUND_CONTEXT;

  await requireModelAuthentication(params.models, params.model.provider);

  const env = new NodeExecutionEnv({ cwd: absTargetDir });
  const toolContext: ExecutionToolContext = { env };
  const builtin: AgentHarnessTool<ExecutionToolContext>[] = [
    createBashTool(),
    createReadTool(),
    createWriteTool(),
    createEditTool(),
  ];
  // Concatenate before validating so the collision guard sees the full set
  // (built-in-vs-custom and custom-vs-custom). `?? []` avoids ever registering
  // `undefined` when no custom tools were supplied -- prior behavior byte-for-byte.
  const tools = [...builtin, ...(params.tools ?? [])].map((tool) =>
    params.stageLimitController === undefined
      ? tool
      : {
          ...tool,
          execute: async (...args: Parameters<typeof tool.execute>) => {
            params.stageLimitController?.admitToolTurn();
            return tool.execute(...args);
          },
        },
  );
  assertUniqueToolNames(tools);

  const controller = params.sessionLimitController;
  const sessionModels = controller?.wrap(params.models) ?? params.models;
  const models = params.stageLimitController?.wrap(sessionModels) ?? sessionModels;
  const explicitPolicy =
    params.compaction ??
    (params.summarizer === undefined ? undefined : { mode: "auto", summarizer: params.summarizer });
  if (
    explicitPolicy?.summarizer !== undefined &&
    controller !== undefined &&
    (controller.limits.maxTurns > 0 || controller.limits.maxCostUsd > 0)
  ) {
    throw new TypeError("custom summarizer cannot be used with positive session limits");
  }
  const compaction = resolveCompactionPolicy(explicitPolicy, models, params.model);
  const usage = { freshInput: 0, cachedInput: 0, output: 0, reasoning: 0, costUsd: 0 };
  let providerLimitObservation: ReturnType<typeof providerLimitFrom>;
  let usageFailure: RangeError | undefined;
  const readFiles = new Set<string>();
  const seenReadFiles = new Set<string>();
  const maxReadPaths = params.observability?.maxReadPaths ?? 0;
  const maxReadPathBytes = params.observability?.maxReadPathBytes ?? 0;

  const store =
    params.session === undefined
      ? new ProjectStore(absTargetDir, params.projectStoreConfig)
      : undefined;
  const session = params.session ?? (await store?.openOrCreateSession(runId, context));
  if (session === undefined) throw new Error("runRole: failed to acquire session");

  const base = toHarnessOptions(params.role, {
    session,
    models,
    model: params.model,
  });
  const effectiveSystemPrompt =
    compaction.mode === "auto"
      ? `${params.role.systemPrompt}\n\n${COMPACTION_SAFETY_PROMPT}`
      : params.role.systemPrompt;
  const options: AgentHarnessOptions<ExecutionToolContext> = {
    ...base,
    systemPrompt: effectiveSystemPrompt,
    tools,
    toolContext,
  };
  const systemPromptBytes = Buffer.byteLength(effectiveSystemPrompt);
  const promptBytes = params.resumeActiveOperation === true ? 0 : Buffer.byteLength(params.prompt);
  const toolDefinitionBytes = Buffer.byteLength(
    JSON.stringify(
      tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    ),
  );

  let ledgerPath: string | undefined;
  let sink: LedgerSink;
  if (params.ledgerSink !== undefined) {
    sink = params.ledgerSink;
  } else {
    const projectStore = store ?? new ProjectStore(absTargetDir, params.projectStoreConfig);
    ledgerPath = path.join(projectStore.layout.ledger, `${runId}.jsonl`);
    sink = new FileLedgerSink(ledgerPath, projectStore.byteLimits.jsonlRecord);
  }

  const ledger = new Ledger({
    runId,
    role: params.role.name,
    step: params.step ?? "run",
    sink,
  });

  const compactor =
    compaction.mode === "auto"
      ? new ContextCompactor({
          budget: params.role.contextBudget,
          summarizer: compaction.summarizer as Summarizer,
        })
      : undefined;

  let harness: Awaited<ReturnType<typeof AgentHarness.create<ExecutionToolContext>>>["harness"];
  try {
    ({ harness } = await AgentHarness.create<ExecutionToolContext>(options, context));
  } catch (error) {
    if (store !== undefined) await session.close(context);
    await store?.close(context);
    throw error;
  }
  ledger.attach(harness.hooks);
  compactor?.attach(harness.hooks);
  const ownsActivityChannel = params.activityChannel === undefined;
  const activityChannel = params.activityChannel ?? new ToolActivityChannel(params.toolActivity);
  const offActivityConsumer =
    params.activityConsumer === undefined
      ? undefined
      : activityChannel.subscribe(params.activityConsumer);
  const offActivity = attachToolActivity({
    channel: activityChannel,
    events: harness.events,
    targetDir: absTargetDir,
    role: params.role.name,
    runId,
    step: params.step ?? "run",
  });
  harness.hooks.on("after_response", (event) => {
    try {
      const freshInput = boundedUsageInteger(event.message.usage.input, "input");
      const cachedInput = boundedUsageInteger(event.message.usage.cacheRead, "cacheRead");
      const output = boundedUsageInteger(event.message.usage.output, "output");
      const reasoning = boundedUsageInteger(event.message.usage.reasoning ?? 0, "reasoning");
      if (reasoning > output) throw new RangeError("provider reasoning usage exceeds output");
      const costUsd = boundedUsageNumber(event.message.usage.cost.total, "cost");
      usage.freshInput = addUsageInteger(usage.freshInput, freshInput, "input");
      usage.cachedInput = addUsageInteger(usage.cachedInput, cachedInput, "cacheRead");
      usage.output = addUsageInteger(usage.output, output, "output");
      usage.reasoning = addUsageInteger(usage.reasoning, reasoning, "reasoning");
      usage.costUsd = addUsageNumber(usage.costUsd, costUsd, "cost");
    } catch (error) {
      usageFailure = error instanceof RangeError ? error : new RangeError("invalid provider usage");
    }
    if (event.status === 429) {
      const retryAfter = Object.entries(event.headers ?? {}).find(
        ([name]) => name.toLowerCase() === "retry-after",
      )?.[1];
      const retryAfterSeconds =
        retryAfter !== undefined && /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter)
          : undefined;
      providerLimitObservation = providerLimitFrom({ status: 429, retryAfterSeconds });
    }
    return undefined;
  });
  harness.hooks.on("after_tool", (event) => {
    if (event.toolName !== "read" || event.isError) return undefined;
    const candidate = event.args.path;
    if (typeof candidate !== "string" || candidate.includes("\0")) return undefined;
    try {
      const resolved = fs.realpathSync(path.resolve(absTargetDir, candidate));
      const relative = path.relative(absTargetDir, resolved);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
        return undefined;
      if (
        (maxReadPathBytes > 0 && Buffer.byteLength(relative) > maxReadPathBytes) ||
        !isSafeReportedPath(relative)
      )
        return undefined;
      const normalized = relative.split(path.sep).join("/");
      if (seenReadFiles.has(normalized)) return undefined;
      seenReadFiles.add(normalized);
      if (maxReadPaths === 0 || readFiles.size < maxReadPaths) readFiles.add(normalized);
    } catch {
      // A successful tool hook may still name a virtual or subsequently removed file; omit it safely.
    }
    return undefined;
  });

  let interrupted = false;
  let activeLane: Awaited<ReturnType<typeof harness.lane>> | undefined;
  const interrupt = () => {
    interrupted = true;
    // abort() settles the active lane operation; closeout in finally then releases
    // the session lease and flushes the ledger before the caller sees the pause.
    void activeLane?.abort(context).catch(() => undefined);
  };
  const isInterrupted = () => interrupted || params.abortSignal?.aborted === true;
  params.abortSignal?.addEventListener("abort", interrupt, { once: true });
  if (params.abortSignal?.aborted === true) interrupt();

  try {
    const lane = await harness.lane(params.laneName ?? "main", context);
    activeLane = lane;
    if (isInterrupted()) throw new RunInterruptedError(runId);
    if (params.resumeActiveOperation !== true) {
      const entries = await lane.findEntries({ type: "message", order: "oldestFirst" }, context);
      const pending = {
        role: "user" as const,
        content: params.prompt,
        timestamp: Date.now(),
      };
      const messages = [
        ...entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
        pending,
      ];
      if (compaction.mode === "auto") {
        compactor?.assertHealthy(params.role.name, params.model.contextWindow);
        assertTurnFitsBudget(params.role, messages, params.model);
      } else {
        assertContextFitsBudget(params.role, messages, params.model);
      }
    }
    params.stageLimitController?.assertActive();
    const promptOperation =
      params.resumeActiveOperation === true
        ? (async () => {
            const execution = await lane.inspectExecution(context);
            if (execution.current !== null) return lane.resume(context);
            const settled =
              execution.lastOperationId === null
                ? undefined
                : await lane.getResult(execution.lastOperationId, context);
            return settled === undefined
              ? lane.prompt(params.prompt, undefined, context)
              : ({ ok: true, value: settled } as const);
          })()
        : lane.prompt(params.prompt, undefined, context);
    const maxDurationMs = params.stageLimitController?.limits.maxDurationMs ?? 0;
    const remainingDurationMs =
      maxDurationMs === 0
        ? 0
        : Math.max(0, maxDurationMs - (params.stageLimitController?.snapshot().elapsedMs ?? 0));
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const prompted = await (maxDurationMs === 0
      ? promptOperation
      : Promise.race([
          promptOperation,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () =>
                reject(
                  new StageLimitError(
                    "duration",
                    maxDurationMs,
                    maxDurationMs,
                    params.stageLimitController?.snapshot(),
                  ),
                ),
              remainingDurationMs,
            );
          }),
        ])
    )
      .finally(() => {
        if (deadline !== undefined) clearTimeout(deadline);
      })
      .catch((error) => {
        if (isInterrupted()) throw new RunInterruptedError(runId);
        params.stageLimitController?.assertNoBoundaryFailure();
        controller?.assertNoBoundaryFailure();
        const providerLimit = providerLimitFrom(error);
        if (providerLimit !== undefined) throw providerLimit;
        throw error;
      });
    if (isInterrupted()) throw new RunInterruptedError(runId);
    controller?.assertNoBoundaryFailure();
    if (usageFailure !== undefined) throw usageFailure;
    if (providerLimitObservation !== undefined) throw providerLimitObservation;
    const result = (() => {
      try {
        if (!prompted.ok) throw prompted.error;
        return prompted.value;
      } catch (error) {
        const providerLimit = providerLimitFrom(error);
        if (providerLimit !== undefined) throw providerLimit;
        throw error;
      }
    })();
    if (result.status === "failed" && result.error !== undefined) {
      const details =
        result.error.details !== null &&
        typeof result.error.details === "object" &&
        !Array.isArray(result.error.details)
          ? result.error.details
          : {};
      const providerLimit = providerLimitFrom({
        ...details,
        code: "code" in details ? details.code : result.error.code,
      });
      if (providerLimit !== undefined) throw providerLimit;
    }
    if (result.status === "failed") {
      const entries = await session.findEntries(
        { type: "message", order: "desc", limit: 20 },
        context,
      );
      let text = "";
      for (const entry of entries) {
        if (entry.type !== "message" || entry.message.role !== "assistant") continue;
        text = entry.message.content
          .filter((part): part is TextContent => part.type === "text")
          .map((part) => part.text)
          .join("");
        break;
      }
      if (text.trim() === "" && usage.freshInput + usage.cachedInput + usage.output === 0) {
        throw new EmptyTurnError(runId);
      }
    }
    if ("status" in result && result.status === "suspended") {
      // lane.prompt returns OperationResultRecord | SuspendedRun. A single-turn
      // faux/live drive settles; a suspended run means a deferred provider
      // response this convenience path does not resume. Fail loud rather than
      // returning a record the caller would read as settled.
      throw new Error(
        `runRole: run ${runId} suspended; single-turn drive does not resume deferrals`,
      );
    }
    const diffBytes = await measureSafeGitDiffBytes(absTargetDir);
    params.stageLimitController?.assertActive();
    const totalInput = boundedUsageInteger(usage.freshInput + usage.cachedInput, "total input");
    return {
      runId,
      ledgerPath,
      droppedRecords: ledger.droppedRecords,
      droppedActivityEvents: activityChannel.droppedCount,
      result,
      observations: {
        provider: publicMetricLabel(params.model.provider),
        model: publicMetricLabel(params.model.id),
        thinkingLevel: params.role.thinkingLevel ?? "unknown",
        durationMs: boundedUsageNumber(monotonicNow() - roleStartedAt, "duration"),
        input: totalInput,
        cachedInput: usage.cachedInput,
        freshInput: usage.freshInput,
        output: usage.output,
        reasoning: usage.reasoning,
        costUsd: usage.costUsd,
        requestBytes: {
          systemPrompt: systemPromptBytes,
          prompt: promptBytes,
          toolDefinitions: toolDefinitionBytes,
          total: systemPromptBytes + promptBytes + toolDefinitionBytes,
        },
        readFiles: [...readFiles].sort(),
        readFilesTotal: seenReadFiles.size,
        readFilesTruncated: Math.max(0, seenReadFiles.size - readFiles.size),
        diffBytes,
        contextStrategy: compaction.mode === "disabled-then-halt" ? "disabled-then-halt" : "auto",
      },
    };
  } finally {
    params.abortSignal?.removeEventListener("abort", interrupt);
    await harness.close(context);
    offActivity();
    if (ownsActivityChannel) await activityChannel.close();
    else offActivityConsumer?.();
    if (params.model.api === "openai-codex-responses") {
      closeOpenAICodexWebSocketSessions(runId);
    }
    ledger.close();
    await store?.close(context);
  }
}
