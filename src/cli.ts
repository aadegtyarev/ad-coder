#!/usr/bin/env bun
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Session, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { assertCredentialPathOutsideProject, FileCredentialStore } from "./auth/credential-store";
import { createCredentialEnvironment } from "./auth/environment-boundary";
import { resolveBuildInfo } from "./build-info";
import { runAuthCommand } from "./cli/auth";
import { runConsole } from "./cli/console";
import { driveWorkflow, silentNoopWarning } from "./cli/drive";
import type {
  BudgetPercents,
  ConfigurableRole,
  ResolvableProvider,
  ResolvePipelineConfigOptions,
} from "./cli/resolve-config";
import { resolvePipelineConfig } from "./cli/resolve-config";
import { ToolActivityRenderer } from "./cli/tool-activity";
import type { CompactionPolicy } from "./context/compactor";
import { parseModelInventoryConfig } from "./inventory/validate";
import { Ledger, type LedgerSink, MemoryLedgerSink } from "./ledger/ledger";
import {
  DEFAULT_TOOL_ACTIVITY_CONFIG,
  resolveToolActivityConfig,
  type ToolActivityConfig,
  type ToolActivityConsumer,
} from "./observability/tool-activity";
import {
  type BackgroundHostLauncher,
  BackgroundRunError,
  type BackgroundRunLimits,
  BackgroundRunManager,
} from "./orchestration/background-runs";
import {
  createOrchestratorControlPlane,
  type DecisionRequest,
  MAX_AUTOMATIC_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  type StartRunInput,
  triageControlPlaneTask,
} from "./orchestration/control-plane";
import { startOrchestrator } from "./orchestration/orchestrator";
import { runPipeline } from "./orchestration/pipeline";
import { createWorkflowSession } from "./orchestration/session";
import {
  StageLimitError,
  type StageLimitReason,
  type StageLimitSnapshot,
  type StageLimits,
} from "./orchestration/stage-limits";
import type { Complexity, PipelineConfig, RoleSpec, WorkflowPhase } from "./orchestration/types";
import { parseProfile } from "./profiles/validate";
import {
  createProjectCalibrationSnapshot,
  writeProjectCalibrationSnapshot,
} from "./project-calibration";
import type { ClaimInput } from "./project-operations/backlog";
import { routeDocumentationFollowUp } from "./project-operations/documentation";
import { ProjectOperationsError } from "./project-operations/errors";
import { aggregateFollowUps, validateFollowUp } from "./project-operations/follow-ups";
import type { GitHubCommandExecutor } from "./project-operations/github-backlog";
import {
  createBacklogStore,
  probeBacklogMigration,
  probeGitHubBacklogCapability,
} from "./project-operations/github-backlog";
import {
  detectLdoProject,
  importLdoArtifacts,
  inspectImportedLdoWork,
  previewLdoImport,
  resumeImportedLdoWork,
} from "./project-operations/ldo-import";
import type {
  FinishPublishingInput,
  PublishingCommandExecutor,
  StartPublishingInput,
} from "./project-operations/repository-publishing";
import {
  finishRepositoryPublishing,
  preflightRepositoryPublishing,
  startRepositoryPublishing,
} from "./project-operations/repository-publishing";
import { RunCoordinator } from "./project-operations/run-coordinator";
import { ProjectStore } from "./project-store/project-store";
import type { ProjectStoreConfig } from "./project-store/types";
import { ProjectStoreError } from "./project-store/types";
import { parseRegistryConfig } from "./registry/validate";
import type { Role } from "./role";
import { defineRole } from "./role";
import { resolveTargetDir } from "./runner/errors";
import { createRoleRunner } from "./runner/role-runner";
import type { Tool } from "./runner/tool";
import type { SessionLimits } from "./session-limits";
import { SessionLimitController } from "./session-limits";
import {
  createDefaultUserProfileStore,
  exportUserProfile,
  FileUserProfileStore,
  parseUserProfileJson,
  UserProfileError,
} from "./user-profile";
import type { WorkflowContext } from "./workflow";
import { isWorkflowModule } from "./workflow";
import {
  BUILT_IN_PIPELINE_WORKFLOW,
  BUILT_IN_PIPELINE_WORKFLOW_NAME,
} from "./workflows/builtin-pipeline";

const ROLE_NAMES = ["planner", "researcher", "coder", "reviewer", "auditor", "security"] as const;
type RoleName = (typeof ROLE_NAMES)[number];
const PROVIDERS = ["deepseek", "openrouter", "openai-codex"] as const;
const COMPLEXITIES = ["trivial", "medium", "complex"] as const;
let operationsJsonFront = false;
const DEFAULT_HEARTBEAT_MS = 10_000;

function fail(message: string): never {
  if (operationsJsonFront) {
    process.stderr.write(`${JSON.stringify({ error: { code: "usage", detail: message } })}\n`);
    process.exit(2);
  }
  process.stderr.write(`ad-coder: ${message}\n${renderRootHelp()}\n`);
  process.exit(2);
}

/**
 * The module is imported into this process and inherits the whole environment,
 * including provider credentials. These checks keep a run from loading code off
 * the network or out of a directory anyone can write to; they are not a
 * sandbox, so the path argument is trusted input either way.
 */
function resolveScriptPath(specifier: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) {
    fail(`refusing to load a URL specifier: ${specifier}`);
  }
  const resolved = path.resolve(process.cwd(), specifier);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    fail(`cannot read ${resolved}: ${errorMessage(error)}`);
  }
  if (stat.isSymbolicLink()) fail(`refusing to load a symlink: ${resolved}`);
  if (!stat.isFile()) fail(`not a regular file: ${resolved}`);
  if ((stat.mode & 0o002) !== 0) fail(`refusing to load a world-writable file: ${resolved}`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    fail(`refusing to load a file owned by another user (uid ${stat.uid}): ${resolved}`);
  }
  // Group-writable is a warning, not a refusal: a umask of 002 makes every
  // checked-out file group-writable under the owner's own private group, and
  // whether that group has other members is not knowable from a stat.
  if ((stat.mode & 0o020) !== 0) {
    process.stderr.write(
      `ad-coder: warning: ${resolved} is writable by group ${stat.gid}; anyone in it can change the code this run executes\n`,
    );
  }
  return resolved;
}

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | undefined>;
  booleans: Record<string, boolean>;
};

type CommandDefinition = {
  name: string;
  description: string;
  positionals: readonly { name: string; description: string }[];
  options: readonly { name: string; value?: string; description: string; required?: boolean }[];
  run: (args: ParsedArgs) => Promise<void>;
};

/** Split a command's positionals from its registry-declared options. */
function parseArgs(argv: string[], command: CommandDefinition): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | undefined> = {};
  const booleans: Record<string, boolean> = {};
  outer: for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    for (const option of command.options) {
      if (arg === option.name && option.value === undefined) {
        booleans[option.name] = true;
        continue outer;
      }
      if (arg === option.name && option.value !== undefined) {
        const value = argv[i + 1];
        if (value === undefined) fail(`${option.name} requires a value`);
        flags[option.name] = value;
        i++;
        continue outer;
      }
      if (option.value !== undefined && arg.startsWith(`${option.name}=`)) {
        flags[option.name] = arg.slice(option.name.length + 1);
        continue outer;
      }
    }
    if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    positionals.push(arg);
  }
  return { positionals, flags, booleans };
}

/**
 * Warn when the process cwd is inside targetDir: Bun auto-loads a `.env` from
 * the process cwd into the environment at startup, so a dotenv under targetDir
 * would be folded into `process.env` and could supply the target's own
 * credentials -- erasing the credential boundary. Numbers/paths only.
 */
function credentialEnvForTarget(absTargetDir: string): (name: string) => string | undefined {
  return createCredentialEnvironment(absTargetDir, {
    warn: (message) => process.stderr.write(message),
  });
}

/**
 * Build the RoleRunner a `--target-dir` run exposes as `ctx.runRole`.
 *
 * Credentials come from `builtinModels()` -- the CLI's OWN process
 * environment -- never from `<targetDir>/.env`.
 */
function buildRunner(targetDirArg: string): WorkflowContext["runRole"] {
  const absTargetDir = resolveTargetDir(targetDirArg);
  const env = credentialEnvForTarget(absTargetDir);
  const models = builtinModels({
    authContext: {
      env: async (name) => env(name),
      fileExists: async (file) =>
        fs.existsSync(file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file),
    },
  });
  return createRoleRunner({ targetDir: absTargetDir, models });
}

/**
 * The newest assistant text in a settled session. A LOCAL copy of the private
 * `extractFinalText` (duplicated by house convention, never imported): scan the
 * most recent message entries newest-first for the first assistant message and
 * join its `{ type: 'text' }` blocks (skipping thinking and tool-call blocks).
 * Returns `''` when no assistant text exists.
 */
async function extractFinalText(session: Session, context: Context): Promise<string> {
  const entries = await session.findEntries({ type: "message", order: "desc", limit: 20 }, context);
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "assistant") continue;
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

/**
 * Drive ONE role turn standalone against a fresh in-memory session and return
 * its final assistant text plus the per-run cost summed from the ledger.
 *
 * Dependencies are injected (`models`/`model`/`ledgerSink`) so a faux-backed
 * registry substitutes for a real provider in tests -- no network, no key. The
 * settled `OperationResultRecord` is deliberately NOT returned or printed (it
 * carries request detail); only the extracted assistant text and the numeric
 * cost cross the boundary.
 */
export async function runRoleStandalone(params: {
  role: Role;
  model: Model<Api>;
  models: Models;
  targetDir: string;
  task: string;
  runId?: string;
  resumeExisting?: boolean;
  ledgerSink?: LedgerSink;
  tools?: Tool[];
  activityConsumer?: ToolActivityConsumer;
  compaction?: CompactionPolicy;
  projectStoreConfig?: ProjectStoreConfig;
  toolActivity?: Partial<ToolActivityConfig>;
  stageLimits?: StageLimits;
}): Promise<{
  text: string;
  cost: number;
  ledgerPath: string | undefined;
  observations: import("./runner/runner").RoleObservations;
}> {
  const runId = params.runId ?? crypto.randomUUID();
  const store = new ProjectStore(params.targetDir, params.projectStoreConfig);
  const checkpointPath = path.join(store.layout.runs, `standalone-${store.validateId(runId)}.json`);
  type Checkpoint = {
    schemaVersion: 2;
    runId: string;
    role: string;
    provider: string;
    modelId: string;
    taskDigest: string;
    cumulativeUsage: Pick<
      StageLimitSnapshot,
      "elapsedMs" | "modelTurns" | "toolTurns" | "inputTokens" | "lastInputTokens" | "costUsd"
    >;
    status: "running" | "paused" | "complete";
    result?: {
      text: string;
      cost: number;
      ledgerPath?: string;
      observations: import("./runner/runner").RoleObservations;
    };
    pause?: {
      code: "stage_limit";
      reason: StageLimitReason;
      limit: number;
      observed: number;
    };
  };
  const taskDigest = new Bun.CryptoHasher("sha256").update(params.task).digest("hex");
  let checkpoint: import("./project-store/types").VersionedState<Checkpoint>;
  let stageLimitInitial: Checkpoint["pause"] extends infer _
    ?
        | Pick<
            StageLimitSnapshot,
            "elapsedMs" | "modelTurns" | "toolTurns" | "inputTokens" | "lastInputTokens" | "costUsd"
          >
        | undefined
    : never;
  let session: Session;
  if (params.resumeExisting === true) {
    checkpoint = store.readVersionedJson<Checkpoint>(checkpointPath);
    const prior = checkpoint.value;
    if (prior.schemaVersion !== 2 || prior.runId !== runId || prior.role !== params.role.name)
      throw new ProjectStoreError(
        "invalid_config",
        checkpointPath,
        "standalone checkpoint does not match this role",
      );
    if (prior.provider !== params.model.provider || prior.modelId !== params.model.id)
      throw new ProjectStoreError(
        "invalid_config",
        checkpointPath,
        "standalone checkpoint provider/model does not match",
      );
    if (prior.taskDigest !== taskDigest)
      throw new ProjectStoreError(
        "invalid_config",
        checkpointPath,
        "standalone checkpoint task does not match",
      );
    if (prior.status === "complete")
      throw new ProjectStoreError(
        "invalid_config",
        checkpointPath,
        "standalone role is already complete",
      );
    const cumulativeUsage = {
      ...prior.cumulativeUsage,
      lastInputTokens:
        (prior.cumulativeUsage as { lastInputTokens?: number }).lastInputTokens ??
        prior.cumulativeUsage.inputTokens,
    };
    stageLimitInitial = cumulativeUsage;
    if (prior.pause !== undefined) {
      const key: Record<StageLimitReason, keyof StageLimits | undefined> = {
        duration: "maxDurationMs",
        model_turns: "maxModelTurns",
        tool_turns: "maxToolTurns",
        input: "maxInputTokens",
        cost: "maxCostUsd",
        cost_in_flight: "maxCostUsd",
        cost_unknown: "maxCostUsd",
      };
      const configured =
        key[prior.pause.reason] === undefined
          ? undefined
          : params.stageLimits?.[key[prior.pause.reason] as keyof StageLimits];
      if (configured !== 0 && (configured === undefined || configured <= prior.pause.limit))
        throw new ProjectStoreError(
          "invalid_config",
          checkpointPath,
          `resume requires a larger ${String(key[prior.pause.reason])} or 0`,
        );
    }
    const { pause: _pause, ...resumed } = prior;
    checkpoint = store.writeVersionedJson(
      checkpointPath,
      { ...resumed, cumulativeUsage, status: "running" },
      checkpoint.version,
    );
    session = await store.resumeSession(runId, BACKGROUND_CONTEXT);
  } else {
    checkpoint = store.writeVersionedJson(
      checkpointPath,
      {
        schemaVersion: 2,
        runId,
        role: params.role.name,
        provider: params.model.provider,
        modelId: params.model.id,
        taskDigest,
        cumulativeUsage: {
          elapsedMs: 0,
          modelTurns: 0,
          toolTurns: 0,
          inputTokens: 0,
          lastInputTokens: 0,
          costUsd: 0,
        },
        status: "running",
      },
      0,
    );
    session = await store.createSession(runId, BACKGROUND_CONTEXT);
  }
  let result: Awaited<ReturnType<ReturnType<typeof createRoleRunner>["runRole"]>>;
  try {
    result = await createRoleRunner({
      targetDir: params.targetDir,
      models: params.models,
      ...(params.compaction !== undefined && { compaction: params.compaction }),
      ...(params.projectStoreConfig !== undefined && {
        projectStoreConfig: params.projectStoreConfig,
      }),
      ...(params.toolActivity !== undefined && { toolActivity: params.toolActivity }),
      ...(params.activityConsumer !== undefined && { activityConsumer: params.activityConsumer }),
      ...(params.stageLimits !== undefined && { stageLimits: params.stageLimits }),
    }).runRole(params.role, params.model, params.task, {
      runId,
      session,
      ...(params.resumeExisting === true && { resumeActiveOperation: true }),
      ...(stageLimitInitial !== undefined && { stageLimitInitial }),
      stageLimitObserver: (snapshot) => {
        const { elapsedMs, modelTurns, toolTurns, inputTokens, lastInputTokens, costUsd } =
          snapshot;
        checkpoint = store.writeVersionedJson(
          checkpointPath,
          {
            ...checkpoint.value,
            cumulativeUsage: {
              elapsedMs,
              modelTurns,
              toolTurns,
              inputTokens,
              lastInputTokens,
              costUsd,
            },
          },
          checkpoint.version,
        );
      },
      ...(params.ledgerSink !== undefined && { ledgerSink: params.ledgerSink }),
      ...(params.tools !== undefined && { tools: params.tools }),
    });
  } catch (error) {
    try {
      await session.close(BACKGROUND_CONTEXT);
    } catch {
      // The runner normally owns closeout; this covers failures before harness creation.
    }
    if (error instanceof StageLimitError) {
      if (error.snapshot === undefined)
        throw new ProjectStoreError(
          "invalid_config",
          checkpointPath,
          "stage-limit failure did not provide resumable cumulative usage",
        );
      const { elapsedMs, modelTurns, toolTurns, inputTokens, lastInputTokens, costUsd } =
        error.snapshot;
      store.writeVersionedJson(
        checkpointPath,
        {
          ...checkpoint.value,
          status: "paused",
          cumulativeUsage: {
            elapsedMs,
            modelTurns,
            toolTurns,
            inputTokens,
            lastInputTokens,
            costUsd,
          },
          pause: {
            code: "stage_limit",
            reason: error.reason,
            limit: error.limit,
            observed: error.observed,
          },
        },
        checkpoint.version,
      );
    }
    throw error;
  }
  // runRole closes the session facade it was handed; reopen a fresh readable
  // facade from the durable store to scan the settled transcript.
  const readable = await store.resumeSession(runId, BACKGROUND_CONTEXT);
  let text: string;
  try {
    text = await extractFinalText(readable, BACKGROUND_CONTEXT);
  } finally {
    await readable.close(BACKGROUND_CONTEXT);
  }
  const durableResult = {
    text,
    cost: result.observations.costUsd ?? 0,
    ...(result.ledgerPath !== undefined && { ledgerPath: result.ledgerPath }),
    observations: result.observations,
  };
  const { pause: _pause, ...completed } = checkpoint.value;
  store.writeVersionedJson(
    checkpointPath,
    { ...completed, status: "complete", result: durableResult },
    checkpoint.version,
  );
  return {
    text,
    cost: durableResult.cost,
    ledgerPath: result.ledgerPath,
    observations: result.observations,
  };
}

/** The resolved RoleSpec for a validated shipped role name. */
function roleSpecFor(config: PipelineConfig, name: RoleName): RoleSpec {
  const spec =
    name === "planner"
      ? config.roles.planner
      : name === "researcher"
        ? config.roles.researcher
        : name === "security"
          ? config.roles.security
          : name === "coder"
            ? config.roles.coder
            : name === "reviewer"
              ? config.roles.reviewer
              : config.roles.auditor;
  if (spec === undefined) {
    throw new Error(`ad-coder: internal error: resolved config has no ${name} role`);
  }
  return spec;
}

function parseProviderFlag(value: string | undefined): ResolvableProvider | undefined {
  if (value === undefined) return undefined;
  if (!(PROVIDERS as readonly string[]).includes(value)) {
    fail(`unknown provider: ${value} (expected one of ${PROVIDERS.join(", ")})`);
  }
  return value as ResolvableProvider;
}

function parseComplexityFlag(value: string | undefined): Complexity | undefined {
  if (value === undefined) return undefined;
  if (!(COMPLEXITIES as readonly string[]).includes(value)) {
    fail(`invalid --default-complexity: ${value} (expected one of ${COMPLEXITIES.join(", ")})`);
  }
  return value as Complexity;
}

function parseThinkingLevelFlag(value: string | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  const levels: readonly ThinkingLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  if (!levels.includes(value as ThinkingLevel)) {
    fail(`invalid --orchestrator-thinking-level: ${value}`);
  }
  return value as ThinkingLevel;
}

function parseMaxRoundsFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`invalid --max-rounds: ${value} (expected a positive integer)`);
  }
  return parsed;
}

function parseNonNegativeIntegerFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail(`invalid ${name}: ${value} (expected a non-negative integer)`);
  return Number(value);
}

function parsePositiveIntegerFlag(name: string, value: string | undefined): number | undefined {
  const parsed = parseNonNegativeIntegerFlag(name, value);
  if (parsed === 0) fail(`${name} expects a positive integer`);
  return parsed;
}

async function withCliProgress<T>(
  label: string,
  heartbeatMs: number,
  task: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  process.stderr.write(`ad-coder: started ${label}; waiting for provider\n`);
  const timer =
    heartbeatMs === 0
      ? undefined
      : setInterval(() => {
          process.stderr.write(
            `ad-coder: ${label} still running (${Math.floor((Date.now() - started) / 1000)}s)\n`,
          );
        }, heartbeatMs);
  try {
    return await task();
  } finally {
    if (timer !== undefined) clearInterval(timer);
  }
}

function parsePercentFlag(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1 || value.trim() === "") {
    fail(`invalid ${name}: ${value} (expected a number between 0 and 1)`);
  }
  return parsed;
}

function readJsonConfig(value: string, option: string): unknown {
  const resolved = resolveScriptPath(value);
  let text: string;
  try {
    text = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    fail(`cannot read ${option} ${resolved}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`cannot parse ${option} ${resolved}: invalid JSON`);
  }
}

function parseMaxInputBytesFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || value.trim() === "") {
    fail(`invalid --max-input-bytes: ${value} (expected a positive integer)`);
  }
  return parsed;
}

function parseSessionLimits(flags: Record<string, string | undefined>): SessionLimits {
  const turnsText = flags["--max-session-turns"];
  const costText = flags["--max-session-cost-usd"];
  let maxTurns = 0;
  let maxCostUsd = 0;
  if (turnsText !== undefined) {
    if (!/^(0|[1-9]\d*)$/.test(turnsText)) {
      fail(`invalid --max-session-turns: ${turnsText} (expected a non-negative integer)`);
    }
    maxTurns = Number(turnsText);
    if (!Number.isSafeInteger(maxTurns)) {
      fail(`invalid --max-session-turns: ${turnsText} (expected a safe integer)`);
    }
  }
  if (costText !== undefined) {
    if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(costText)) {
      fail(`invalid --max-session-cost-usd: ${costText} (expected a non-negative amount)`);
    }
    maxCostUsd = Number(costText);
    if (!Number.isFinite(maxCostUsd)) {
      fail(`invalid --max-session-cost-usd: ${costText} (expected a finite amount)`);
    }
  }
  return { maxTurns, maxCostUsd };
}

function parseProjectStoreConfig(value: string | undefined): ProjectStoreConfig | undefined {
  if (value === undefined) return undefined;
  const resolved = resolveScriptPath(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    fail(`cannot parse --project-store-config ${resolved}: ${errorMessage(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("--project-store-config must contain a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  const allowedTop = new Set(["retention", "byteLimits", "projectOperations"]);
  if (Object.keys(object).some((key) => !allowedTop.has(key))) {
    fail("--project-store-config contains an unknown setting");
  }
  const groups = [
    [
      "retention",
      new Set([
        "sessions",
        "runs",
        "scratch",
        "attachments",
        "downloads",
        "cache",
        "ledger",
        "tmp",
      ]),
    ],
    ["byteLimits", new Set(["attachment", "state", "jsonlRecord"])],
  ] as const;
  for (const [groupName, allowed] of groups) {
    const group = object[groupName];
    if (group === undefined) continue;
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      fail(`--project-store-config ${groupName} must be an object`);
    }
    for (const [key, setting] of Object.entries(group)) {
      if (
        !allowed.has(key) ||
        typeof setting !== "number" ||
        !Number.isSafeInteger(setting) ||
        setting < 0
      ) {
        fail(`invalid --project-store-config setting: ${groupName}.${key}`);
      }
    }
  }
  const operations = object.projectOperations;
  if (operations !== undefined) {
    if (typeof operations !== "object" || operations === null || Array.isArray(operations))
      fail("--project-store-config projectOperations must be an object");
    const operationObject = operations as Record<string, unknown>;
    const allowed = new Set([
      "backlogBackend",
      "evidenceLimit",
      "aggregationLimit",
      "claimLeaseMs",
      "documentation",
      "ldo",
      "github",
      "publishing",
      "controlPlane",
    ]);
    if (Object.keys(operationObject).some((key) => !allowed.has(key)))
      fail("--project-store-config contains an unknown projectOperations setting");
    if (
      operationObject.backlogBackend !== undefined &&
      operationObject.backlogBackend !== "files" &&
      operationObject.backlogBackend !== "github"
    )
      fail("invalid --project-store-config setting: projectOperations.backlogBackend");
    for (const key of ["evidenceLimit", "aggregationLimit", "claimLeaseMs"] as const) {
      const setting = operationObject[key];
      if (setting !== undefined && (!Number.isSafeInteger(setting) || (setting as number) < 0))
        fail(`invalid --project-store-config setting: projectOperations.${key}`);
    }
    const documentation = operationObject.documentation;
    if (documentation !== undefined)
      validateStringObject(
        documentation,
        ["root", "contracts", "notes"],
        "projectOperations.documentation",
      );
    const ldo = operationObject.ldo;
    if (ldo !== undefined) {
      if (typeof ldo !== "object" || ldo === null || Array.isArray(ldo))
        fail("invalid --project-store-config setting: projectOperations.ldo");
      const ldoObject = ldo as Record<string, unknown>;
      const allowedLdo = new Set([
        "root",
        "plans",
        "runs",
        "artifactCountLimit",
        "perFileByteLimit",
        "aggregateByteLimit",
      ]);
      if (Object.keys(ldoObject).some((key) => !allowedLdo.has(key)))
        fail("--project-store-config contains an unknown projectOperations.ldo setting");
      for (const key of ["root", "plans", "runs"] as const)
        if (
          ldoObject[key] !== undefined &&
          (typeof ldoObject[key] !== "string" || ldoObject[key] === "")
        )
          fail(`invalid --project-store-config setting: projectOperations.ldo.${key}`);
      for (const key of ["artifactCountLimit", "perFileByteLimit", "aggregateByteLimit"] as const) {
        const setting = ldoObject[key];
        if (setting !== undefined && (!Number.isSafeInteger(setting) || (setting as number) < 0))
          fail(`invalid --project-store-config setting: projectOperations.ldo.${key}`);
      }
    }
    const github = operationObject.github;
    if (github !== undefined) {
      if (typeof github !== "object" || github === null || Array.isArray(github))
        fail("invalid --project-store-config setting: projectOperations.github");
      const githubObject = github as Record<string, unknown>;
      const githubAllowed = new Set(["repository", "stateLabels", "managedLabel"]);
      if (Object.keys(githubObject).some((key) => !githubAllowed.has(key)))
        fail("--project-store-config contains an unknown projectOperations.github setting");
      for (const key of ["repository", "managedLabel"] as const)
        if (
          githubObject[key] !== undefined &&
          (typeof githubObject[key] !== "string" || githubObject[key] === "")
        )
          fail(`invalid --project-store-config setting: projectOperations.github.${key}`);
      if (githubObject.stateLabels !== undefined)
        validateStringObject(
          githubObject.stateLabels,
          ["queued", "claimed", "in_progress", "review", "blocked", "done"],
          "projectOperations.github.stateLabels",
        );
    }
    const controlPlane = operationObject.controlPlane;
    if (controlPlane !== undefined) {
      if (typeof controlPlane !== "object" || controlPlane === null || Array.isArray(controlPlane))
        fail("invalid --project-store-config setting: projectOperations.controlPlane");
      const controlObject = controlPlane as Record<string, unknown>;
      const controlAllowed = new Set([
        "autoDecomposition",
        "maxDecompositionDepth",
        "maxChildPipelines",
        "maxQueuedRootRuns",
        "maxActiveRootRuns",
        "maxProjectTurns",
        "maxProjectCostUsd",
        "retryIntervalMs",
        "maxAutomaticRetryAttempts",
      ]);
      if (Object.keys(controlObject).some((key) => !controlAllowed.has(key)))
        fail("--project-store-config contains an unknown projectOperations.controlPlane setting");
      if (
        controlObject.autoDecomposition !== undefined &&
        typeof controlObject.autoDecomposition !== "boolean"
      )
        fail(
          "invalid --project-store-config setting: projectOperations.controlPlane.autoDecomposition",
        );
      for (const key of [
        "maxDecompositionDepth",
        "maxChildPipelines",
        "maxQueuedRootRuns",
        "maxActiveRootRuns",
        "maxProjectTurns",
        "retryIntervalMs",
        "maxAutomaticRetryAttempts",
      ] as const) {
        const setting = controlObject[key];
        if (setting !== undefined && (!Number.isSafeInteger(setting) || (setting as number) < 0))
          fail(`invalid --project-store-config setting: projectOperations.controlPlane.${key}`);
      }
      if (
        controlObject.retryIntervalMs !== undefined &&
        (controlObject.retryIntervalMs as number) > MAX_RETRY_DELAY_MS
      )
        fail(
          "invalid --project-store-config setting: projectOperations.controlPlane.retryIntervalMs",
        );
      if (
        controlObject.maxAutomaticRetryAttempts !== undefined &&
        (controlObject.maxAutomaticRetryAttempts as number) > MAX_AUTOMATIC_RETRY_ATTEMPTS
      )
        fail(
          "invalid --project-store-config setting: projectOperations.controlPlane.maxAutomaticRetryAttempts",
        );
      const projectCost = controlObject.maxProjectCostUsd;
      if (
        projectCost !== undefined &&
        (typeof projectCost !== "number" || !Number.isFinite(projectCost) || projectCost < 0)
      )
        fail(
          "invalid --project-store-config setting: projectOperations.controlPlane.maxProjectCostUsd",
        );
    }
    const publishing = operationObject.publishing;
    if (publishing !== undefined) {
      if (typeof publishing !== "object" || publishing === null || Array.isArray(publishing))
        fail("invalid --project-store-config setting: projectOperations.publishing");
      const publishingObject = publishing as Record<string, unknown>;
      const publishingAllowed = new Set([
        "remote",
        "baseCandidates",
        "protectedBases",
        "featurePrefix",
        "mode",
        "gate",
        "localTestCommand",
        "multiDeveloper",
        "outputByteLimit",
      ]);
      if (Object.keys(publishingObject).some((key) => !publishingAllowed.has(key)))
        fail("--project-store-config contains an unknown projectOperations.publishing setting");
      for (const key of ["remote", "featurePrefix"] as const)
        if (
          publishingObject[key] !== undefined &&
          (typeof publishingObject[key] !== "string" || publishingObject[key] === "")
        )
          fail(`invalid --project-store-config setting: projectOperations.publishing.${key}`);
      for (const key of ["baseCandidates", "protectedBases", "localTestCommand"] as const) {
        const setting = publishingObject[key];
        if (
          setting !== undefined &&
          (!Array.isArray(setting) ||
            setting.length === 0 ||
            setting.some((entry) => typeof entry !== "string" || entry === ""))
        )
          fail(`invalid --project-store-config setting: projectOperations.publishing.${key}`);
      }
      if (
        publishingObject.mode !== undefined &&
        !["auto", "github", "local"].includes(publishingObject.mode as string)
      )
        fail("invalid --project-store-config setting: projectOperations.publishing.mode");
      if (
        publishingObject.gate !== undefined &&
        !["local", "ci", "local-and-ci", "manual"].includes(publishingObject.gate as string)
      )
        fail("invalid --project-store-config setting: projectOperations.publishing.gate");
      if (
        publishingObject.multiDeveloper !== undefined &&
        typeof publishingObject.multiDeveloper !== "boolean"
      )
        fail("invalid --project-store-config setting: projectOperations.publishing.multiDeveloper");
      if (
        publishingObject.outputByteLimit !== undefined &&
        (!Number.isSafeInteger(publishingObject.outputByteLimit) ||
          (publishingObject.outputByteLimit as number) < 0)
      )
        fail(
          "invalid --project-store-config setting: projectOperations.publishing.outputByteLimit",
        );
    }
  }
  return object as ProjectStoreConfig;
}

function validateStringObject(value: unknown, allowedKeys: readonly string[], name: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`invalid --project-store-config setting: ${name}`);
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !allowedKeys.includes(key)) ||
    Object.values(object).some((entry) => typeof entry !== "string" || entry === "")
  )
    fail(`invalid --project-store-config setting: ${name}`);
}

function readJsonInput(input: string | undefined): unknown {
  if (input === undefined) fail("--input is required for this operations action");
  try {
    return JSON.parse(
      input === "-"
        ? fs.readFileSync(0, "utf8")
        : fs.readFileSync(resolveScriptPath(input), "utf8"),
    );
  } catch (error) {
    fail(`cannot parse operations input: ${errorMessage(error)}`);
  }
}

function readProfileJsonInput(input: string | undefined): unknown {
  if (input === undefined) fail("--input is required for profile import");
  let contents: string;
  try {
    if (input === "-") contents = fs.readFileSync(0, "utf8");
    else {
      const file = path.resolve(input);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new UserProfileError(
          "invalid_path",
          "input",
          "profile import must be a regular file",
        );
      contents = fs.readFileSync(file, "utf8");
    }
  } catch (error) {
    if (error instanceof UserProfileError) throw error;
    throw new UserProfileError("io_error", "input", "could not read profile import", {
      cause: error,
    });
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new UserProfileError("invalid_profile", "input", "profile import JSON is invalid", {
      cause: error,
    });
  }
}

async function profileCommand(positionals: string[], flags: Record<string, string | undefined>) {
  const action = positionals[1];
  if (
    action !== "show" &&
    action !== "export" &&
    action !== "snapshot" &&
    action !== "import-preview" &&
    action !== "import-apply"
  )
    fail("profile requires show, export, snapshot, import-preview, or import-apply");
  if (positionals[2] !== undefined) fail("profile accepts exactly one action");
  const profilePath = flags["--profile-path"];
  const store =
    profilePath === undefined
      ? createDefaultUserProfileStore()
      : new FileUserProfileStore({ userHome: os.homedir(), path: path.resolve(profilePath) });
  const current = await store.read();
  if (action === "show") {
    process.stdout.write(`${JSON.stringify({ path: store.path, profile: current })}\n`);
    return;
  }
  if (action === "export") {
    process.stdout.write(exportUserProfile(current));
    return;
  }
  if (action === "snapshot") {
    const targetDir = flags["--target-dir"];
    const inventory = flags["--inventory"];
    if (targetDir === undefined || inventory === undefined)
      fail("profile snapshot requires --target-dir and --inventory");
    const snapshot = createProjectCalibrationSnapshot(current, inventory);
    const file = writeProjectCalibrationSnapshot(resolveTargetDir(targetDir), snapshot);
    process.stdout.write(`${JSON.stringify({ file, snapshot })}\n`);
    return;
  }
  const mode = flags["--mode"];
  if (mode !== "merge" && mode !== "replace") fail("--mode must be merge or replace");
  let raw: unknown;
  try {
    raw = readProfileJsonInput(flags["--input"]);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new UserProfileError("invalid_profile", "input", "profile import JSON is invalid");
    throw error;
  }
  const incoming = parseUserProfileJson(JSON.stringify(raw));
  const result =
    action === "import-preview"
      ? await store.previewImport(incoming, mode)
      : await store.import(incoming, mode);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function githubExecutor(): GitHubCommandExecutor {
  return {
    execute(request) {
      try {
        const result = Bun.spawnSync(request.argv, {
          ...(request.stdin !== undefined && { stdin: Buffer.from(request.stdin) }),
          stdout: "pipe",
          stderr: "pipe",
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        };
      } catch {
        // A missing/unstartable gh executable is an unavailable capability, not a CLI crash.
        return { exitCode: 127, stdout: "", stderr: "" };
      }
    },
  };
}

function publishingExecutor(): PublishingCommandExecutor {
  return {
    execute(request) {
      try {
        const result = Bun.spawnSync(request.argv, {
          cwd: request.cwd,
          ...(request.stdin !== undefined && { stdin: Buffer.from(request.stdin) }),
          ...(request.env !== undefined && { env: { ...process.env, ...request.env } }),
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = result.stdout.toString();
        const stderr = result.stderr.toString();
        const retain = (value: string) =>
          request.outputByteLimit > 0 ? value.slice(0, request.outputByteLimit) : value;
        return {
          exitCode: result.exitCode,
          stdout: retain(stdout),
          stderr: retain(stderr),
        };
      } catch {
        return { exitCode: 127, stdout: "", stderr: "" };
      }
    },
  };
}

function strictOperationInput(
  value: unknown,
  allowed: readonly string[],
  name: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${name} input must be an object`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key)))
    fail(`${name} input contains an unknown setting`);
  return object;
}

function operationClaim(flags: Record<string, string | undefined>): ClaimInput {
  const owner = flags["--owner"];
  const runId = flags["--run-id"];
  const branch = flags["--branch"];
  if (owner === undefined || runId === undefined || branch === undefined)
    fail("--owner, --run-id, and --branch are required for this operations action");
  return { owner, runId, branch };
}

/** Thin JSON front for the headless project-operations APIs. */
async function operationsCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
): Promise<void> {
  const action = positionals[1];
  if (action === undefined) fail("missing <action>");
  if (positionals[2] !== undefined) fail("the operations command accepts one positional action");
  const targetArg = flags["--target-dir"];
  if (targetArg === undefined) fail("--target-dir is required for the operations command");
  const targetDir = resolveTargetDir(targetArg);
  const projectConfig = parseProjectStoreConfig(flags["--project-store-config"]);
  if (action === "ldo-detect") {
    process.stdout.write(
      `${JSON.stringify(detectLdoProject(targetDir, projectConfig?.projectOperations))}\n`,
    );
    return;
  }
  if (action === "ldo-preview") {
    process.stdout.write(
      `${JSON.stringify(previewLdoImport(targetDir, projectConfig?.projectOperations))}\n`,
    );
    return;
  }
  if (action === "publish-preflight") {
    const result = preflightRepositoryPublishing(
      publishingExecutor(),
      targetDir,
      projectConfig?.projectOperations?.publishing,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const store = new ProjectStore(targetDir, projectConfig);
  const config = store.projectOperations;
  const input = () => readJsonInput(flags["--input"]);
  const control = (publishInput?: FinishPublishingInput) => {
    const limits = new SessionLimitController(parseSessionLimits(flags));
    return createOrchestratorControlPlane({
      store,
      ...(config.controlPlane !== undefined && { config: config.controlPlane }),
      sessionLimits: limits,
      resolveAutoDecision: async (decision, record) => {
        const projectEvidence = decision.evidence.filter((reference) => {
          const candidate = path.resolve(targetDir, reference);
          return candidate.startsWith(`${targetDir}${path.sep}`) && fs.existsSync(candidate);
        });
        if (projectEvidence.length === 0)
          return {
            action: "defer" as const,
            rationale: "Auto mode found no existing project document supporting this decision.",
            evidence: decision.evidence,
          };
        return {
          action: "accept" as const,
          rationale: `Auto mode delegated this in-scope decision for run ${record.id}; the cited project documents support it.`,
          evidence: projectEvidence,
        };
      },
      execute: async (record) => {
        const pipeline = resolvePipelineConfig({
          task: record.task,
          ...buildConfigOptions(targetArg, flags),
        });
        pipeline.sessionLimitController = limits;
        pipeline.coordinator = { ...pipeline.coordinator, runId: record.id };
        const result = await runPipeline(pipeline);
        const changed = Bun.spawnSync(["git", "diff", "--name-only", "HEAD"], {
          cwd: targetDir,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (changed.exitCode !== 0)
          throw new ProjectOperationsError("not_repository", "contentBinding");
        const reviewedPaths = changed.stdout
          .toString()
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean);
        return {
          result,
          reviewedPaths,
          operations: {
            filesChanged: reviewedPaths,
            checks: [],
            checkpointPath: path.join(store.layout.runs, `coordinator-${record.id}.json`),
            backlog: { destination: "skipped", count: 0 },
          },
        };
      },
      ...(publishInput !== undefined && {
        publishApproved: async (_record, binding) => {
          const published = finishRepositoryPublishing(
            publishingExecutor(),
            targetDir,
            { ...publishInput, approvedTreeOid: binding.publishTreeOid },
            config.publishing,
          );
          return {
            phase: published.phase,
            featureOid: published.featureOid,
            baseOid: published.baseOid,
            ...(published.prUrl !== undefined &&
              /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(
                published.prUrl,
              ) && { prUrl: published.prUrl }),
            gateStatuses: [
              ...(published.localGate?.ran
                ? [published.localGate.passed ? "local:passed" : "local:failed"]
                : []),
              ...(published.ciGate?.ran
                ? [published.ciGate.passed ? "ci:passed" : "ci:failed"]
                : []),
            ],
            recoveryCategories: ["feature_branch_preserved", "retry_with_fresh_preflight"],
          };
        },
      }),
    });
  };
  let result: unknown;
  if (action === "control-triage") {
    result = { route: triageControlPlaneTask(input() as never) };
  } else if (action === "control-start") {
    const supplied = strictOperationInput(input(), ["requestKey", "task", "mode", "scope"], action);
    result = control().start(supplied as unknown as StartRunInput);
  } else if (action === "control-status") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    result = control().status(id);
  } else if (action === "control-list") result = control().list();
  else if (action === "control-resume" || action === "control-run-until") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    const supplied =
      flags["--input"] === undefined ? {} : strictOperationInput(input(), ["runUntil"], action);
    result = await control().resume(id, supplied);
  } else if (action === "control-cancel") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    result = control().cancel(id);
  } else if (action === "control-decisions-list") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    result = control().listDecisions(id);
  } else if (action === "control-events") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    const afterRaw = flags["--after"];
    const after = afterRaw === undefined ? 0 : Number(afterRaw);
    result = control().events(id, after);
  } else if (action === "control-decision-request") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    result = await control().requestDecision(id, input() as DecisionRequest);
  } else if (action === "control-decision-resolve") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    const supplied = strictOperationInput(input(), ["decisionId", "action", "rationale"], action);
    result = control().resolveDecisionFromOperator(
      id,
      supplied.decisionId as string,
      supplied.action as "accept" | "reject" | "defer",
      supplied.rationale as string,
    );
  } else if (action === "control-report") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    result = control().report(id);
  } else if (action === "control-publish") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    const supplied = input() as unknown as FinishPublishingInput;
    result = await control(supplied).publish(id);
  } else if (action === "publish-start") {
    const supplied = strictOperationInput(input(), ["preflight", "featureBranch"], action);
    result = startRepositoryPublishing(
      publishingExecutor(),
      targetDir,
      supplied as unknown as StartPublishingInput,
      config.publishing,
    );
  } else if (action === "publish-finish") {
    const supplied = strictOperationInput(
      input(),
      [
        "started",
        "paths",
        "commitMessage",
        "title",
        "description",
        "authorizeInitiallyDirtyPaths",
        "approvedTreeOid",
      ],
      action,
    );
    result = finishRepositoryPublishing(
      publishingExecutor(),
      targetDir,
      supplied as unknown as FinishPublishingInput,
      config.publishing,
    );
  } else if (action === "ldo-import") {
    const supplied = flags["--input"] === undefined ? {} : input();
    if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied))
      fail("ldo-import input must be an object");
    if (Object.keys(supplied).some((key) => key !== "trustDigests"))
      fail("ldo-import input contains an unknown setting");
    result = importLdoArtifacts(store, supplied as { trustDigests?: string[] });
  } else if (action === "ldo-inspect") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    result = inspectImportedLdoWork(store, id);
  } else if (action === "ldo-resume") {
    const id = flags["--id"];
    if (id === undefined) fail("--id is required for this operations action");
    const inspection = inspectImportedLdoWork(store, id);
    const pipelineConfig = resolvePipelineConfig({
      task: inspection.task,
      ...buildConfigOptions(targetArg, flags),
    });
    result = await resumeImportedLdoWork(store, id, pipelineConfig);
  } else if (action === "followup-validate") {
    result = validateFollowUp(input(), { evidenceLimit: config.evidenceLimit ?? 0 });
  } else if (action === "followup-aggregate") {
    const candidates = input();
    if (!Array.isArray(candidates)) fail("aggregate input must be a JSON array");
    result = aggregateFollowUps(candidates, {
      evidenceLimit: config.evidenceLimit ?? 0,
      aggregationLimit: config.aggregationLimit ?? 0,
    });
  } else if (action === "documentation-route") {
    result = routeDocumentationFollowUp(targetDir, input(), config);
  } else if (action === "github-probe") {
    const repository = config.github?.repository;
    if (repository === undefined) fail("GitHub repository is not configured");
    result = probeGitHubBacklogCapability(githubExecutor(), repository);
  } else if (action === "migration-probe") {
    result = probeBacklogMigration(store, githubExecutor(), config);
  } else {
    const backlog = createBacklogStore(store, config, githubExecutor());
    const id = flags["--id"];
    if (action === "backlog-create") result = backlog.create(input(), id);
    else if (action === "backlog-list") result = backlog.list();
    else {
      if (id === undefined) fail("--id is required for this operations action");
      if (action === "backlog-get") result = backlog.get(id);
      else if (action === "backlog-claim") result = backlog.claim(id, operationClaim(flags));
      else if (action === "backlog-renew") result = backlog.renew(id, operationClaim(flags));
      else if (action === "backlog-release") result = backlog.release(id, operationClaim(flags));
      else if (action === "backlog-transition") {
        const state = flags["--state"];
        if (state === undefined) fail("--state is required for backlog-transition");
        result = backlog.transition(id, state as never, operationClaim(flags));
      } else fail(`unknown operations action: ${action}`);
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const CONTROL_ACTIONS = [
  "start",
  "status",
  "list",
  "resume",
  "cancel",
  "decisions-list",
  "decision-request",
  "decision-resolve",
  "run-until",
  "report",
  "publish",
  "triage",
] as const;

async function controlCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
): Promise<void> {
  const action = positionals[1];
  if (action === undefined || !(CONTROL_ACTIONS as readonly string[]).includes(action))
    fail(`control requires one action: ${CONTROL_ACTIONS.join(", ")}`);
  if (positionals[2] !== undefined) fail("the control command accepts one positional action");
  await operationsCommand(["operations", `control-${action}`], flags);
}

function backgroundLimits(flags: Record<string, string | undefined>): Partial<BackgroundRunLimits> {
  const number = (name: string, key: keyof BackgroundRunLimits) => {
    const value = parseNonNegativeIntegerFlag(name, flags[name]);
    return value === undefined ? {} : { [key]: value };
  };
  const policy = flags["--same-target-policy"];
  if (policy !== undefined && !["allow", "reject", "serialize"].includes(policy))
    fail("--same-target-policy must be allow, reject, or serialize");
  return {
    ...number("--background-max-active", "maxActiveRuns"),
    ...number("--background-max-process-active", "maxProcessActiveRuns"),
    ...number("--background-max-task-bytes", "maxTaskBytes"),
    ...number("--background-max-events", "maxEventsPerRun"),
    ...number("--background-max-page-size", "maxPageSize"),
    ...number("--background-max-page-bytes", "maxPageBytes"),
    ...number("--background-max-run-ms", "maxRunMs"),
    ...number("--background-close-drain-ms", "closeDrainMs"),
    ...number("--lease-ms", "leaseMs"),
    ...(policy === undefined
      ? {}
      : { sameTargetPolicy: policy as BackgroundRunLimits["sameTargetPolicy"] }),
  };
}

/** The CLI owns process creation; orchestration only receives this provider. */
function createBackgroundHostLauncher(targetDir: string, ownerId: string): BackgroundHostLauncher {
  return async ({ runId, task, limits }) => {
    const entrypoint = process.argv[1];
    if (entrypoint === undefined) fail("background worker entrypoint is unavailable");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          entrypoint,
          "background",
          "worker",
          "--target-dir",
          targetDir,
          "--id",
          runId,
          "--owner-id",
          ownerId,
        ],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            AD_CODER_BACKGROUND_TASK: task,
            AD_CODER_BACKGROUND_LIMITS: JSON.stringify(limits),
          },
        },
      );
      child.once("error", () => reject(new Error("background worker failed to start")));
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  };
}

/** JSON-only management front for session-owned background pipeline records. */
async function backgroundCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
): Promise<void> {
  const action = positionals[1];
  const worker = action === "worker";
  if (!["start", "events", "status", "result", "cancel", "worker"].includes(action ?? ""))
    fail("background requires one action: start, events, status, result, or cancel");
  const targetArg = flags["--target-dir"];
  if (targetArg === undefined) fail("--target-dir is required for the background command");
  const targetDir = resolveTargetDir(targetArg);
  const ownerId = flags["--owner-id"] ?? `${process.getuid?.() ?? "user"}:${targetDir}`;
  const configuredLimits = backgroundLimits(flags);
  const workerLimits = (() => {
    const encoded = process.env.AD_CODER_BACKGROUND_LIMITS;
    if (!worker || encoded === undefined) return configuredLimits;
    try {
      return JSON.parse(encoded) as Partial<BackgroundRunLimits>;
    } catch {
      fail("background worker limits are invalid");
    }
  })();
  const launcher =
    action === "start" ? createBackgroundHostLauncher(targetDir, ownerId) : undefined;
  const manager = new BackgroundRunManager(
    async (task, runId, control) => {
      const config = resolvePipelineConfig({ task, ...buildConfigOptions(targetArg, flags) });
      config.coordinator = { ...config.coordinator, runId };
      const result = await runPipeline(config);
      const perStep = result.stageMetrics.map((metric, index) => {
        const phase = metric.stage.split(":", 1)[0] as WorkflowPhase;
        if (
          !(["plan", "research", "security", "code", "review", "done"] as const).includes(
            phase as never,
          )
        )
          throw new Error("pipeline returned an unknown stage metric");
        return {
          phase,
          step: index + 1,
          cost: metric.costUsd ?? 0,
        };
      });
      for (const step of perStep) control.onStage(step);
      return {
        runId,
        result,
        perStep,
        totalCost: perStep.reduce((sum, step) => sum + step.cost, 0),
      };
    },
    workerLimits,
    targetDir,
    ownerId,
    launcher,
  );
  const id = flags["--id"];
  let output: unknown;
  if (action === "start") {
    if (positionals.length !== 3 || positionals[2] === undefined)
      fail("background start requires exactly one task");
    output = await manager.startDetached(positionals[2]);
  } else if (worker) {
    if (id === undefined) fail("--id is required for this background action");
    const task = process.env.AD_CODER_BACKGROUND_TASK;
    if (task === undefined) fail("background worker task is missing");
    manager.claim(id, task);
    await manager.wait(id);
    await manager.close(true);
    return;
  } else {
    if (id === undefined) fail("--id is required for this background action");
    if (action === "status") output = manager.status(id);
    else if (action === "result") output = manager.result(id);
    else if (action === "cancel") output = manager.cancel(id);
    else {
      const cursor = flags["--after"] === undefined ? 0 : Number(flags["--after"]);
      const limit = flags["--limit"] === undefined ? undefined : Number(flags["--limit"]);
      output = manager.events(id, cursor, limit);
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  // A management invocation must not turn a read/cancel into a worker lifetime.
  if (action !== "start") await manager.close();
  else await manager.close(true);
}

function buildConfigOptions(
  targetDirArg: string,
  flags: Record<string, string | undefined>,
): Omit<ResolvePipelineConfigOptions, "task"> {
  const provider = parseProviderFlag(flags["--provider"]);
  const maxRounds = parseMaxRoundsFlag(flags["--max-rounds"]);
  const defaultComplexity = parseComplexityFlag(flags["--default-complexity"]);
  const orchestratorThinkingLevel = parseThinkingLevelFlag(flags["--orchestrator-thinking-level"]);
  const requestTimeoutMs = parseNonNegativeIntegerFlag(
    "--request-timeout-ms",
    flags["--request-timeout-ms"],
  );
  const stageMaxDurationMs = parseNonNegativeIntegerFlag(
    "--stage-max-duration-ms",
    flags["--stage-max-duration-ms"],
  );
  const stageMaxModelTurns = parseNonNegativeIntegerFlag(
    "--stage-max-model-turns",
    flags["--stage-max-model-turns"],
  );
  const stageMaxToolTurns = parseNonNegativeIntegerFlag(
    "--stage-max-tool-turns",
    flags["--stage-max-tool-turns"],
  );
  const stageMaxInputTokens = parseNonNegativeIntegerFlag(
    "--stage-max-input-tokens",
    flags["--stage-max-input-tokens"],
  );
  const finalResponseReserveModelTurns = parseNonNegativeIntegerFlag(
    "--stage-final-response-reserve-model-turns",
    flags["--stage-final-response-reserve-model-turns"],
  );
  const finalResponseReserveDurationMs = parseNonNegativeIntegerFlag(
    "--stage-final-response-reserve-duration-ms",
    flags["--stage-final-response-reserve-duration-ms"],
  );
  const finalResponseReserveToolTurns = parseNonNegativeIntegerFlag(
    "--stage-final-response-reserve-tool-turns",
    flags["--stage-final-response-reserve-tool-turns"],
  );
  const finalResponseReserveInputTokens = parseNonNegativeIntegerFlag(
    "--stage-final-response-reserve-input-tokens",
    flags["--stage-final-response-reserve-input-tokens"],
  );
  const stageMaxCostUsd =
    flags["--stage-max-cost-usd"] === undefined ? undefined : Number(flags["--stage-max-cost-usd"]);
  const stageLimits = {
    ...(stageMaxDurationMs !== undefined && { maxDurationMs: stageMaxDurationMs }),
    ...(stageMaxModelTurns !== undefined && { maxModelTurns: stageMaxModelTurns }),
    ...(stageMaxToolTurns !== undefined && { maxToolTurns: stageMaxToolTurns }),
    ...(stageMaxInputTokens !== undefined && { maxInputTokens: stageMaxInputTokens }),
    ...(stageMaxCostUsd !== undefined && { maxCostUsd: stageMaxCostUsd }),
    ...(finalResponseReserveModelTurns !== undefined && {
      finalResponseReserveModelTurns,
    }),
    ...(finalResponseReserveDurationMs !== undefined && {
      finalResponseReserveDurationMs,
    }),
    ...(finalResponseReserveToolTurns !== undefined && {
      finalResponseReserveToolTurns,
    }),
    ...(finalResponseReserveInputTokens !== undefined && {
      finalResponseReserveInputTokens,
    }),
  };
  if (stageMaxCostUsd !== undefined && (!Number.isFinite(stageMaxCostUsd) || stageMaxCostUsd < 0))
    fail("--stage-max-cost-usd expects a non-negative finite number");
  const targetDir = resolveTargetDir(targetDirArg);
  const projectStoreConfig = parseProjectStoreConfig(flags["--project-store-config"]);
  const toolActivityEntries = [
    ["replayCapacity", "--tool-activity-replay"],
    ["subscriberPendingCapacity", "--tool-activity-pending"],
    ["projectionBytes", "--tool-activity-projection-bytes"],
    ["maxStringBytes", "--tool-activity-string-bytes"],
    ["maxEventBytes", "--tool-activity-event-bytes"],
    ["groupingRefreshMs", "--tool-activity-grouping-ms"],
    ["humanGroupCount", "--tool-activity-groups"],
    ["renderedLineBytes", "--tool-activity-line-bytes"],
    ["renderQueueCount", "--tool-activity-render-queue"],
    ["renderQueueBytes", "--tool-activity-render-bytes"],
    ["closeDrainMs", "--tool-activity-close-drain-ms"],
  ] as const;
  const toolActivity = Object.fromEntries(
    toolActivityEntries.flatMap(([key, flag]) => {
      const value = parseNonNegativeIntegerFlag(flag, flags[flag]);
      return value === undefined ? [] : [[key, value]];
    }),
  );
  try {
    resolveToolActivityConfig(toolActivity);
  } catch (error) {
    fail(error instanceof RangeError ? error.message : "invalid tool activity configuration");
  }
  const registryConfig =
    flags["--registry-config"] === undefined
      ? undefined
      : parseRegistryConfig(readJsonConfig(flags["--registry-config"], "--registry-config"));
  const inventoryConfig =
    flags["--inventory-config"] === undefined
      ? undefined
      : parseModelInventoryConfig(
          readJsonConfig(flags["--inventory-config"], "--inventory-config"),
        );
  const profile =
    flags["--profile-config"] === undefined
      ? undefined
      : parseProfile(readJsonConfig(flags["--profile-config"], "--profile-config"));
  const maxTokensPercent = parsePercentFlag("--max-tokens-percent", flags["--max-tokens-percent"]);
  const reserveTokensPercent = parsePercentFlag(
    "--reserve-tokens-percent",
    flags["--reserve-tokens-percent"],
  );
  const keepRecentTokensPercent = parsePercentFlag(
    "--keep-recent-tokens-percent",
    flags["--keep-recent-tokens-percent"],
  );
  const budgetPercents: BudgetPercents = {
    ...(maxTokensPercent !== undefined && { maxTokensPercent }),
    ...(reserveTokensPercent !== undefined && { reserveTokensPercent }),
    ...(keepRecentTokensPercent !== undefined && { keepRecentTokensPercent }),
  };
  const compactionMode = flags["--compaction-mode"];
  if (
    compactionMode !== undefined &&
    compactionMode !== "auto" &&
    compactionMode !== "disabled-then-halt"
  ) {
    fail(`invalid --compaction-mode: ${compactionMode}`);
  }
  const researchPurpose = flags["--research-purpose"];
  if (
    researchPurpose !== undefined &&
    researchPurpose !== "model-inventory-bootstrap" &&
    researchPurpose !== "model-inventory-refresh"
  ) {
    fail(`invalid --research-purpose: ${researchPurpose}`);
  }
  const researchBriefValues = [
    flags["--research-brief-id"],
    flags["--research-brief-version"],
    flags["--research-brief-path"],
  ];
  if (
    researchBriefValues.some((value) => value !== undefined) &&
    researchBriefValues.some((value) => value === undefined)
  ) {
    fail(
      "--research-brief-id, --research-brief-version, and --research-brief-path must be supplied together",
    );
  }
  if (researchBriefValues[0] !== undefined && researchPurpose === undefined) {
    fail("--research-brief-id requires --research-purpose");
  }
  const pipelineContextMode = flags["--pipeline-context"];
  if (
    pipelineContextMode !== undefined &&
    pipelineContextMode !== "incremental" &&
    pipelineContextMode !== "full" &&
    pipelineContextMode !== "off"
  ) {
    fail(`invalid --pipeline-context: ${pipelineContextMode}`);
  }
  const pipelineContextMaxDiffBytes = parseNonNegativeIntegerFlag(
    "--pipeline-context-max-diff-bytes",
    flags["--pipeline-context-max-diff-bytes"],
  );
  const pipelineContextMaxPaths = parsePositiveIntegerFlag(
    "--pipeline-context-max-paths",
    flags["--pipeline-context-max-paths"],
  );
  const pipelineContextMaxPathBytes = parsePositiveIntegerFlag(
    "--pipeline-context-max-path-bytes",
    flags["--pipeline-context-max-path-bytes"],
  );
  const pipelineContextMaxAggregateBytes = parsePositiveIntegerFlag(
    "--pipeline-context-max-aggregate-bytes",
    flags["--pipeline-context-max-aggregate-bytes"],
  );
  const crossProvider = flags["--allow-cross-provider-summarization"];
  if (crossProvider !== undefined && crossProvider !== "true" && crossProvider !== "false") {
    fail("--allow-cross-provider-summarization expects true or false");
  }
  const enabledPlugins =
    flags["--plugins"] === undefined
      ? undefined
      : flags["--plugins"] === "none"
        ? []
        : flags["--plugins"].split(",").map((name) => name.trim());
  if (enabledPlugins?.some((name) => name !== "explore" && name !== "web" && name !== "vision"))
    fail("--plugins expects comma-separated explore,web,vision or none");
  let roleBudgetPercents: Partial<Record<ConfigurableRole, BudgetPercents>> | undefined;
  if (flags["--role-budget-percents"] !== undefined) {
    const raw = readJsonConfig(flags["--role-budget-percents"], "--role-budget-percents");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      fail("--role-budget-percents must contain a JSON object");
    roleBudgetPercents = raw as Partial<Record<ConfigurableRole, BudgetPercents>>;
  }
  const credentialEnv = credentialEnvForTarget(targetDir);
  const credentialPath = flags["--credential-path"];
  if (credentialPath !== undefined) assertCredentialPathOutsideProject(credentialPath, targetDir);
  return {
    targetDir,
    env: credentialEnv,
    ...(credentialPath !== undefined && {
      credentials: new FileCredentialStore({ path: credentialPath }),
    }),
    ...(provider !== undefined && { provider }),
    ...(flags["--strong-model"] !== undefined && { strongModel: flags["--strong-model"] }),
    ...(flags["--mid-model"] !== undefined && { midModel: flags["--mid-model"] }),
    ...(flags["--cheap-model"] !== undefined && { cheapModel: flags["--cheap-model"] }),
    ...(registryConfig !== undefined && { registryConfig }),
    ...(inventoryConfig !== undefined && { inventoryConfig }),
    ...(flags["--inventory-profile"] !== undefined && {
      inventoryProfile: flags["--inventory-profile"],
    }),
    ...(profile !== undefined && { profile }),
    ...(flags["--planner-model"] !== undefined && { plannerModel: flags["--planner-model"] }),
    ...(flags["--researcher-model"] !== undefined && {
      researcherModel: flags["--researcher-model"],
    }),
    ...(flags["--security-model"] !== undefined && { securityModel: flags["--security-model"] }),
    ...(flags["--coder-model"] !== undefined && { coderModel: flags["--coder-model"] }),
    ...(flags["--reviewer-model"] !== undefined && { reviewerModel: flags["--reviewer-model"] }),
    ...(flags["--auditor-model"] !== undefined && { auditorModel: flags["--auditor-model"] }),
    ...(flags["--orchestrator-model"] !== undefined && {
      orchestratorModel: flags["--orchestrator-model"],
    }),
    ...(flags["--vision-model"] !== undefined && { visionModel: flags["--vision-model"] }),
    ...(orchestratorThinkingLevel !== undefined && { orchestratorThinkingLevel }),
    ...(requestTimeoutMs !== undefined && { requestTimeoutMs }),
    ...(Object.values(stageLimits).some((value) => value !== undefined) && { stageLimits }),
    ...(flags["--summarizer-model"] !== undefined && {
      summarizerModel: flags["--summarizer-model"],
    }),
    ...(compactionMode !== undefined && { compactionMode }),
    ...(researchPurpose !== undefined && { researchPurpose }),
    ...(researchBriefValues[0] !== undefined && {
      researchBrief: {
        id: researchBriefValues[0],
        version: researchBriefValues[1] as string,
        path: researchBriefValues[2] as string,
      },
    }),
    ...(pipelineContextMode !== undefined && { pipelineContextMode }),
    ...(pipelineContextMaxDiffBytes !== undefined && { pipelineContextMaxDiffBytes }),
    ...(pipelineContextMaxPaths !== undefined && { pipelineContextMaxPaths }),
    ...(pipelineContextMaxPathBytes !== undefined && { pipelineContextMaxPathBytes }),
    ...(pipelineContextMaxAggregateBytes !== undefined && { pipelineContextMaxAggregateBytes }),
    ...(crossProvider !== undefined && {
      allowCrossProviderSummarization: crossProvider === "true",
    }),
    ...(enabledPlugins !== undefined && {
      enabledPlugins: enabledPlugins as ("explore" | "web" | "vision")[],
    }),
    ...(Object.keys(budgetPercents).length > 0 && { budgetPercents }),
    ...(roleBudgetPercents !== undefined && { roleBudgetPercents }),
    ...(maxRounds !== undefined && { maxRounds }),
    ...(defaultComplexity !== undefined && { defaultComplexity }),
    ...(projectStoreConfig !== undefined && { projectStoreConfig }),
    ...(Object.keys(toolActivity).length > 0 && { toolActivity }),
  };
}

/** Run a single role standalone against a target directory, resolved from the environment. */
async function roleCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
): Promise<void> {
  const name = positionals[1];
  if (name === undefined) fail("missing <role>");
  if (!(ROLE_NAMES as readonly string[]).includes(name)) {
    fail(`unknown role: ${name} (expected one of ${ROLE_NAMES.join(", ")})`);
  }
  const task = positionals[2];
  if (task === undefined) fail("missing <task>");
  const targetDirArg = flags["--target-dir"];
  if (targetDirArg === undefined) fail("--target-dir is required for the role command");

  const configOptions = buildConfigOptions(targetDirArg, flags);
  const config = resolvePipelineConfig({
    ...configOptions,
    task,
  });

  const spec = roleSpecFor(config, name as RoleName);
  const standaloneRole = defineRole(
    {
      ...spec.role,
      systemPrompt: `${spec.role.systemPrompt}\n\nThis is a standalone role invocation. Return the complete result as assistant text; structured pipeline submission tools are unavailable.`,
      activeToolNames: (spec.role.activeToolNames ?? []).filter(
        (tool) => !tool.startsWith("submit_"),
      ),
    },
    spec.model,
  );
  const renderer = new ToolActivityRenderer(process.stderr, "human", config.toolActivity);
  const resumeRunId = flags["--resume-run"];
  const standaloneRunId = resumeRunId ?? crypto.randomUUID();
  const expectedLedgerPath = path.join(
    configOptions.targetDir,
    ".ad-coder",
    "ledger",
    `${standaloneRunId}.jsonl`,
  );
  const expectedCheckpointPath = path.join(
    configOptions.targetDir,
    ".ad-coder",
    "runs",
    `standalone-${standaloneRunId}.json`,
  );
  const standaloneResult = await (async () => {
    try {
      return await runRoleStandalone({
        role: standaloneRole,
        model: spec.model,
        models: config.models,
        targetDir: configOptions.targetDir,
        task,
        runId: standaloneRunId,
        ...(resumeRunId !== undefined && { resumeExisting: true }),
        ...((config.pluginToolsForModel?.(spec.model) ?? config.pluginTools) !== undefined && {
          tools: config.pluginToolsForModel?.(spec.model) ?? config.pluginTools,
        }),
        activityConsumer: renderer.consume,
        ...(config.compaction !== undefined && { compaction: config.compaction }),
        ...(config.projectStoreConfig !== undefined && {
          projectStoreConfig: config.projectStoreConfig,
        }),
        ...(config.toolActivity !== undefined && { toolActivity: config.toolActivity }),
        ...(config.stageLimits !== undefined && { stageLimits: config.stageLimits }),
      });
    } catch (error) {
      process.stderr.write(`ad-coder: partial usage ledger=${expectedLedgerPath}\n`);
      process.stderr.write(
        `ad-coder: standalone checkpoint=${expectedCheckpointPath} runId=${standaloneRunId}\n`,
      );
      process.stderr.write(
        `ad-coder: resume with role ${name} <same-task> --resume-run ${standaloneRunId} and adjusted limits\n`,
      );
      throw error;
    } finally {
      renderer.close();
    }
  })();
  const { text, cost, ledgerPath, observations } = standaloneResult;

  // The extracted assistant text IS this subcommand's result value, so it is
  // the one thing that reaches stdout (never the raw OperationResultRecord).
  process.stdout.write(`${text}\n`);
  process.stdout.write(`cost: $${cost.toFixed(8)}\n`);
  process.stderr.write(
    `ad-coder: usage input=${observations.input} output=${observations.output} reasoning=${observations.reasoning ?? 0} durationMs=${observations.durationMs ?? 0} tools-read=${observations.readFilesTotal} ledger=${ledgerPath ?? "custom"}\n`,
  );
  // A silent no-op turn (empty text AND zero cost) is otherwise two blank-looking
  // lines; surface it as a clear stderr signal (provider auth / empty response).
  const warning = silentNoopWarning(text, cost);
  if (warning !== undefined) {
    process.stderr.write(warning);
  }
}

/**
 * Drive the stepped workflow engine one phase at a time against a target
 * directory, resolved from the environment. A THIN front: it validates args,
 * resolves the config, sets a readable ledger sink the drive loop sums cost
 * from, creates the session, and hands the real stdin/stdout/stderr streams to
 * `driveWorkflow` (the loop itself lives in the library, per the thin-front
 * contract). `--auto` swaps the human read for the auto-driver.
 */
async function driveCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
  auto: boolean,
  retryResearch: boolean,
): Promise<void> {
  const task = positionals[1];
  if (task === undefined) fail("missing <task>");
  if (retryResearch && flags["--resume-run"] === undefined)
    fail("--retry-research requires --resume-run");
  const targetDirArg = flags["--target-dir"];
  if (targetDirArg === undefined) fail("--target-dir is required for the drive command");

  const config = resolvePipelineConfig({
    ...buildConfigOptions(targetDirArg, flags),
    task,
  });

  // resolvePipelineConfig assigns its own internal LedgerSink (typed as the
  // non-readable interface); replace it with a readable instance the drive loop
  // sums per-step and total cost from, and drive against that same instance.
  const ledgerSink = new MemoryLedgerSink();
  config.ledgerSink = ledgerSink;
  const renderer = new ToolActivityRenderer(process.stderr, "human", config.toolActivity);
  config.activityConsumer = renderer.consume;
  const session = createWorkflowSession(config);
  try {
    const resumeRun = flags["--resume-run"];
    const coordinator = new RunCoordinator(session, session.projectStore, {
      ...(resumeRun === undefined ? {} : { runId: resumeRun, resumeExisting: true }),
      task,
    });
    if (retryResearch) coordinator.resumeResearch({ source: "operator", action: "retry" });
    if (resumeRun !== undefined && coordinator.checkpoint.pause?.code === "stage_limit")
      coordinator.resumeStage({ source: "operator", action: "retry" });
    await driveWorkflow({
      session,
      ledgerSink,
      auto,
      input: process.stdin,
      output: process.stdout,
      error: process.stderr,
      coordinator,
    });
  } finally {
    renderer.close();
  }
}

async function consoleCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
  json: boolean,
): Promise<void> {
  if (positionals[1] !== undefined) fail("the console command accepts no positional arguments");
  const targetDirArg = flags["--target-dir"] ?? process.cwd();
  const maxInputBytes = parseMaxInputBytesFlag(flags["--max-input-bytes"]);
  const heartbeatMs =
    parseNonNegativeIntegerFlag("--heartbeat-ms", flags["--heartbeat-ms"]) ?? DEFAULT_HEARTBEAT_MS;
  const sessionLimits = parseSessionLimits(flags);
  const enabledWorkflows =
    flags["--workflows"] === undefined
      ? []
      : flags["--workflows"]
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
  const configOptions = buildConfigOptions(targetDirArg, flags);
  const session = await startOrchestrator({
    ...configOptions,
    sessionLimits,
    workflowModules: [BUILT_IN_PIPELINE_WORKFLOW],
    enabledWorkflows,
  });
  const result = await runConsole({
    session,
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    mode: json ? "json" : "formatted",
    ...(maxInputBytes !== undefined && { maxInputBytes }),
    heartbeatMs,
    ...(configOptions.toolActivity !== undefined && {
      toolActivity: configOptions.toolActivity,
    }),
  });
  if (result.reason !== "eof" && result.reason !== "exit") process.exitCode = 1;
}

/** Load and run a workflow module against an optional target directory. */
async function runCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
): Promise<void> {
  const scriptArg = positionals[1];
  if (scriptArg === undefined) fail("missing <script.ts>");

  const scriptPath = resolveScriptPath(scriptArg);
  const targetDir = flags["--target-dir"];
  const runRole = targetDir === undefined ? undefined : buildRunner(targetDir);

  const imported: unknown = await import(pathToFileURL(scriptPath).href);
  const workflow = (imported as { default?: unknown }).default;
  if (!isWorkflowModule(workflow)) {
    fail(`${scriptPath} must default-export { name: string, run(ctx) }`);
  }

  const runId = crypto.randomUUID();
  const ledger = new Ledger({ runId, role: workflow.name, step: "run" });
  // runRole is spread in only when set: exactOptionalPropertyTypes forbids
  // handing an explicit `undefined` to the optional field.
  const ctx: WorkflowContext = { runId, ledger, ...(runRole !== undefined && { runRole }) };
  try {
    const result = await workflow.run(ctx);
    // Only the workflow's own return value reaches stdout -- never a provider
    // error object or a settled message, which carry request detail.
    process.stdout.write(`${JSON.stringify(result ?? null)}\n`);
  } finally {
    if (ledger.droppedRecords > 0) {
      process.stderr.write(`ad-coder: ${ledger.droppedRecords} ledger record(s) dropped\n`);
    }
    ledger.close();
  }
}

const PIPELINE_OPTIONS: CommandDefinition["options"] = [
  {
    name: "--stage-final-response-reserve-input-tokens",
    value: "<n>",
    description:
      "Input tokens protected from further tool calls for stage closeout; defaults to 100000, 0 disables.",
  },
  {
    name: "--credential-path",
    value: "<absolute-path>",
    description: "Override the private user-local OAuth credential file.",
  },
  {
    name: "--target-dir",
    value: "<dir>",
    description: "Directory containing the project to operate on.",
    required: true,
  },
  {
    name: "--provider",
    value: "<provider>",
    description: "Provider: deepseek, openrouter, or openai-codex.",
  },
  { name: "--strong-model", value: "<name>", description: "Override the strong model." },
  { name: "--mid-model", value: "<name>", description: "Override the mid-tier model." },
  { name: "--cheap-model", value: "<name>", description: "Override the cheap model." },
  {
    name: "--registry-config",
    value: "<file.json>",
    description: "Load an explicitly selected trusted provider/model registry as JSON.",
  },
  {
    name: "--inventory-config",
    value: "<file.json>",
    description: "Load named atomic registry/profile inventories as JSON.",
  },
  {
    name: "--inventory-profile",
    value: "<name>",
    description: "Select one profile from --inventory-config.",
  },
  {
    name: "--research-purpose",
    value: "<model-inventory-bootstrap|model-inventory-refresh>",
    description: "Attach the versioned model-inventory brief to the Researcher stage.",
  },
  {
    name: "--research-brief-id",
    value: "<id>",
    description: "Trusted replacement brief ID; requires all --research-brief-* flags.",
  },
  {
    name: "--research-brief-version",
    value: "<version>",
    description: "Trusted replacement brief version; requires all --research-brief-* flags.",
  },
  {
    name: "--research-brief-path",
    value: "<path>",
    description: "Trusted replacement brief path; requires all --research-brief-* flags.",
  },
  {
    name: "--profile-config",
    value: "<file.json>",
    description: "Load complexity routing as data-only JSON.",
  },
  { name: "--planner-model", value: "<name>", description: "Override the planner model." },
  { name: "--researcher-model", value: "<name>", description: "Override the researcher model." },
  { name: "--security-model", value: "<name>", description: "Override the security model." },
  { name: "--coder-model", value: "<name>", description: "Override the coder model." },
  { name: "--reviewer-model", value: "<name>", description: "Override the reviewer model." },
  { name: "--auditor-model", value: "<name>", description: "Override the auditor model." },
  {
    name: "--orchestrator-model",
    value: "<name>",
    description: "Override the conversational orchestrator model.",
  },
  {
    name: "--vision-model",
    value: "<name>",
    description: "Route image inspection through this image-capable model.",
  },
  {
    name: "--plugins",
    value: "<names|none>",
    description: "Enable built-in plugin groups: explore,web,vision; defaults to all.",
  },
  {
    name: "--request-timeout-ms",
    value: "<n>",
    description: "Provider request timeout; defaults to 120000, 0 disables.",
  },
  {
    name: "--stage-max-duration-ms",
    value: "<n>",
    description: "Cumulative whole-stage time across resumes; defaults to 600000, 0 disables.",
  },
  {
    name: "--stage-max-model-turns",
    value: "<n>",
    description: "Cumulative model calls across stage resumes; defaults to 32, 0 disables.",
  },
  {
    name: "--stage-max-tool-turns",
    value: "<n>",
    description: "Cumulative tool calls across stage resumes; defaults to 128, 0 disables.",
  },
  {
    name: "--stage-max-input-tokens",
    value: "<n>",
    description:
      "Cumulative provider-reported input across resumes; defaults to 500000, 0 disables.",
  },
  {
    name: "--stage-max-cost-usd",
    value: "<n>",
    description:
      "Cumulative provider-reported stage cost across resumes; defaults to 2, 0 disables.",
  },
  {
    name: "--stage-final-response-reserve-tool-turns",
    value: "<n>",
    description: "Tool turns protected for stage closeout; defaults to 8, 0 disables.",
  },
  {
    name: "--stage-final-response-reserve-duration-ms",
    value: "<n>",
    description:
      "Milliseconds protected from further tool calls for stage closeout; defaults to 30000, 0 disables.",
  },
  {
    name: "--stage-final-response-reserve-model-turns",
    value: "<n>",
    description:
      "Model turns protected from further tool calls for stage closeout; defaults to 4, 0 disables.",
  },
  {
    name: "--heartbeat-ms",
    value: "<n>",
    description: "CLI progress interval; defaults to 10000, 0 disables.",
  },
  {
    name: "--tool-activity-replay",
    value: "<n>",
    description: "Retained activity replay records; 0 disables replay.",
  },
  {
    name: "--tool-activity-pending",
    value: "<n>",
    description: "Maximum pending records per activity subscriber.",
  },
  {
    name: "--tool-activity-projection-bytes",
    value: "<n>",
    description: "Maximum bytes in a safe activity projection.",
  },
  {
    name: "--tool-activity-string-bytes",
    value: "<n>",
    description: "Maximum bytes per external activity identifier.",
  },
  {
    name: "--tool-activity-event-bytes",
    value: "<n>",
    description: "Mandatory maximum bytes per structured activity event.",
  },
  {
    name: "--tool-activity-grouping-ms",
    value: "<n>",
    description: "Human activity grouping refresh; 0 flushes immediately.",
  },
  {
    name: "--tool-activity-groups",
    value: "<n>",
    description: "Maximum semantic groups in one human refresh.",
  },
  {
    name: "--tool-activity-line-bytes",
    value: "<n>",
    description: "Mandatory maximum bytes per rendered progress line.",
  },
  {
    name: "--tool-activity-render-queue",
    value: "<n>",
    description: "Maximum queued progress lines under stderr backpressure.",
  },
  {
    name: "--tool-activity-render-bytes",
    value: "<n>",
    description: "Maximum queued progress bytes under stderr backpressure.",
  },
  {
    name: "--tool-activity-close-drain-ms",
    value: "<n>",
    description: "Finite activity consumer close drain budget; 0 skips draining.",
  },
  {
    name: "--orchestrator-thinking-level",
    value: "<level>",
    description: "Set orchestrator reasoning: off, minimal, low, medium, high, xhigh, or max.",
  },
  {
    name: "--summarizer-model",
    value: "<name>",
    description: "Select the compaction summarizer model.",
  },
  {
    name: "--compaction-mode",
    value: "<mode>",
    description: "Set auto or disabled-then-halt context handling.",
  },
  {
    name: "--pipeline-context",
    value: "<incremental|full|off>",
    description: "Set focused retry handoffs, always-full review, or manual context control.",
  },
  {
    name: "--pipeline-context-max-diff-bytes",
    value: "<n>",
    description: "Escalate focused re-review above this diff size; 0 disables this trigger.",
  },
  {
    name: "--pipeline-context-max-paths",
    value: "<n>",
    description: "Set the mandatory positive changed-path count ceiling.",
  },
  {
    name: "--pipeline-context-max-path-bytes",
    value: "<n>",
    description: "Set the mandatory positive per-path byte ceiling.",
  },
  {
    name: "--pipeline-context-max-aggregate-bytes",
    value: "<n>",
    description: "Set the mandatory positive aggregate changed-path byte ceiling.",
  },
  {
    name: "--allow-cross-provider-summarization",
    value: "<boolean>",
    description: "Explicitly opt in to cross-provider summarization.",
  },
  {
    name: "--max-tokens-percent",
    value: "<fraction>",
    description: "Set the default role context ceiling fraction.",
  },
  {
    name: "--reserve-tokens-percent",
    value: "<fraction>",
    description: "Set the default reply reserve fraction.",
  },
  {
    name: "--keep-recent-tokens-percent",
    value: "<fraction>",
    description: "Set the default retained-tail fraction.",
  },
  {
    name: "--role-budget-percents",
    value: "<file.json>",
    description: "Load per-role context budget fractions as JSON.",
  },
  {
    name: "--max-rounds",
    value: "<n>",
    description: "Set the maximum number of pipeline rounds.",
  },
  {
    name: "--default-complexity",
    value: "<complexity>",
    description: "Set trivial, medium, or complex as the default.",
  },
  {
    name: "--project-store-config",
    value: "<file.json>",
    description: "Load ProjectStore retention and byte limits; numeric 0 disables a limit.",
  },
];

const COMMANDS: readonly CommandDefinition[] = [
  {
    name: "about",
    description: "Show package version, source revision, and linked-development state.",
    positionals: [],
    options: [{ name: "--json", description: "Emit stable JSON." }],
    run: async ({ positionals, booleans }) => {
      if (positionals[1] !== undefined) fail("the about command accepts no positional arguments");
      const info = resolveBuildInfo();
      process.stdout.write(
        booleans["--json"] === true
          ? `${JSON.stringify(info)}\n`
          : `ad-coder ${info.version}\nrevision: ${info.revision ?? "unknown"}\nlinked development: ${info.linkedDevelopment ? "yes" : "no"}\n`,
      );
      await Promise.resolve();
    },
  },
  {
    name: "auth",
    description: "Manage persistent OpenAI Codex authentication.",
    positionals: [{ name: "<status|login|logout>", description: "Authentication action." }],
    options: [
      {
        name: "--credential-path",
        value: "<absolute-path>",
        description: "Override the user-local credential file.",
      },
      {
        name: "--target-dir",
        value: "<dir>",
        description: "Project boundary credentials must remain outside.",
      },
      {
        name: "--method",
        value: "<browser|device_code>",
        description: "Select the OAuth login flow.",
      },
      { name: "--json", description: "Emit a stable non-secret JSON result." },
    ],
    run: async ({ positionals, flags, booleans }) => {
      const action = positionals[1];
      if (action === undefined || positionals[2] !== undefined)
        fail("auth requires exactly one action");
      const method = flags["--method"];
      if (method !== undefined && method !== "browser" && method !== "device_code")
        fail("--method must be browser or device_code");
      await runAuthCommand({
        action,
        ...(flags["--credential-path"] !== undefined && {
          credentialPath: flags["--credential-path"],
        }),
        targetDir: resolveTargetDir(flags["--target-dir"] ?? process.cwd()),
        json: booleans["--json"] === true,
        ...(method !== undefined && { method }),
      });
    },
  },
  {
    name: "config",
    description: "Show effective secret-free configuration and precedence sources.",
    positionals: [{ name: "<show>", description: "Show resolved configuration." }],
    options: [
      ...PIPELINE_OPTIONS.map((option) =>
        option.name === "--target-dir" ? { ...option, required: false } : option,
      ),
      { name: "--json", description: "Emit stable JSON." },
    ],
    run: async ({ positionals, flags, booleans }) => {
      if (positionals[1] !== "show" || positionals[2] !== undefined)
        fail("config requires exactly: config show");
      const target = flags["--target-dir"] ?? process.cwd();
      const config = resolvePipelineConfig({
        ...buildConfigOptions(target, flags),
        task: "config show",
      });
      const effective = {
        ...(config.effectiveConfig ?? {}),
        ...Object.fromEntries(
          Object.entries({ ...DEFAULT_TOOL_ACTIVITY_CONFIG, ...config.toolActivity }).map(
            ([name, value]) => [
              `toolActivity.${name}`,
              {
                value,
                source:
                  config.toolActivity?.[name as keyof typeof config.toolActivity] !== undefined
                    ? "cli"
                    : "built-in-default",
              },
            ],
          ),
        ),
        heartbeatMs: {
          value:
            parseNonNegativeIntegerFlag("--heartbeat-ms", flags["--heartbeat-ms"]) ??
            DEFAULT_HEARTBEAT_MS,
          source: flags["--heartbeat-ms"] !== undefined ? "cli" : "built-in-default",
        },
      };
      if (booleans["--json"] === true) {
        process.stdout.write(`${JSON.stringify(effective)}\n`);
      } else {
        for (const [name, entry] of Object.entries(effective))
          process.stdout.write(`${name}=${entry.value} (${entry.source})\n`);
      }
      await Promise.resolve();
    },
  },
  {
    name: "profile",
    description: "Show, export, snapshot, preview, or import the portable user profile.",
    positionals: [
      {
        name: "<show|export|snapshot|import-preview|import-apply>",
        description: "Profile action.",
      },
    ],
    options: [
      { name: "--input", value: "<file|->", description: "Read an import document." },
      { name: "--target-dir", value: "<dir>", description: "Project receiving a snapshot." },
      { name: "--inventory", value: "<name>", description: "Inventory to snapshot." },
      { name: "--mode", value: "<merge|replace>", description: "Select import semantics." },
      {
        name: "--profile-path",
        value: "<absolute-path>",
        description: "Override the private user-profile store path.",
      },
      { name: "--json", description: "Accepted for machine-mode parity; output is always JSON." },
    ],
    run: ({ positionals, flags }) => profileCommand(positionals, flags),
  },
  {
    name: "background",
    description: "Start and inspect isolated background pipeline runs as JSON.",
    positionals: [
      { name: "<start|events|status|result|cancel>", description: "Background run action." },
      { name: "<task>", description: "Task for start (only)." },
    ],
    options: [
      ...PIPELINE_OPTIONS,
      { name: "--id", value: "<id>", description: "Background run identifier." },
      { name: "--after", value: "<sequence>", description: "Event cursor (exclusive)." },
      { name: "--limit", value: "<n>", description: "Maximum events to return." },
      {
        name: "--owner-id",
        value: "<id>",
        description: "Stable private owner scope for reconnect.",
      },
      {
        name: "--same-target-policy",
        value: "<allow|reject|serialize>",
        description: "Admission policy for concurrent target runs.",
      },
      {
        name: "--background-max-active",
        value: "<n>",
        description: "Maximum active runs in this owner scope.",
      },
      {
        name: "--background-max-process-active",
        value: "<n>",
        description: "Maximum active runs in this process.",
      },
      {
        name: "--background-max-task-bytes",
        value: "<n>",
        description: "Maximum UTF-8 task size.",
      },
      {
        name: "--background-max-events",
        value: "<n>",
        description: "Maximum retained events per run.",
      },
      { name: "--background-max-page-size", value: "<n>", description: "Maximum events per page." },
      {
        name: "--background-max-page-bytes",
        value: "<n>",
        description: "Maximum serialized page size.",
      },
      { name: "--background-max-run-ms", value: "<n>", description: "Run deadline; 0 disables." },
      { name: "--lease-ms", value: "<n>", description: "Worker lease heartbeat ceiling." },
      {
        name: "--background-close-drain-ms",
        value: "<n>",
        description: "Shutdown drain deadline.",
      },
      { name: "--json", description: "Emit one JSON result (default)." },
    ],
    run: ({ positionals, flags }) => backgroundCommand(positionals, flags),
  },
  {
    name: "control",
    description: "Control durable daemon-free pipeline runs and emit JSON.",
    positionals: [
      {
        name: `<${CONTROL_ACTIONS.join("|")}>`,
        description: "Durable control-plane action.",
      },
    ],
    options: [
      ...PIPELINE_OPTIONS,
      { name: "--input", value: "<file|->", description: "Read JSON input from a file or stdin." },
      { name: "--id", value: "<id>", description: "Durable run identifier." },
      { name: "--after", value: "<sequence>", description: "Event cursor (exclusive)." },
      { name: "--json", description: "Emit one JSON result (default)." },
    ],
    run: ({ positionals, flags }) => controlCommand(positionals, flags),
  },
  {
    name: "operations",
    description: "Run a project-operations action and emit JSON.",
    positionals: [
      {
        name: "<action>",
        description:
          "Action including control start/status/list/resume/cancel/decisions/run-until/report/publish, publish-preflight, ldo-resume, and backlog operations.",
      },
    ],
    options: [
      ...PIPELINE_OPTIONS,
      { name: "--input", value: "<file|->", description: "Read JSON input from a file or stdin." },
      { name: "--id", value: "<id>", description: "Backlog or imported-work identifier." },
      { name: "--after", value: "<sequence>", description: "Event cursor (exclusive)." },
      { name: "--state", value: "<state>", description: "Backlog lifecycle destination." },
      { name: "--owner", value: "<owner>", description: "Claim owner." },
      { name: "--run-id", value: "<run-id>", description: "Claiming run identifier." },
      { name: "--branch", value: "<branch>", description: "Claiming branch." },
      { name: "--json", description: "Emit one JSON result (default; accepted for automation)." },
    ],
    run: ({ positionals, flags }) => operationsCommand(positionals, flags),
  },
  {
    name: "run",
    description: "Run a workflow module.",
    positionals: [{ name: "<script.ts>", description: "Workflow module to load and run." }],
    options: [
      {
        name: "--target-dir",
        value: "<dir>",
        description: "Expose a role runner for this project.",
      },
    ],
    run: ({ positionals, flags }) => runCommand(positionals, flags),
  },
  {
    name: "role",
    description: "Run one shipped role once.",
    positionals: [
      {
        name: "<planner|researcher|coder|reviewer|auditor|security>",
        description: "Role to run.",
      },
      { name: "<task>", description: "Task for the role." },
    ],
    options: [
      {
        name: "--resume-run",
        value: "<id>",
        description: "Resume this standalone role from its durable checkpoint.",
      },
      ...PIPELINE_OPTIONS,
    ],
    run: ({ positionals, flags }) =>
      withCliProgress(
        `role ${positionals[1] ?? "unknown"}`,
        parseNonNegativeIntegerFlag("--heartbeat-ms", flags["--heartbeat-ms"]) ??
          DEFAULT_HEARTBEAT_MS,
        () => roleCommand(positionals, flags),
      ),
  },
  {
    name: "drive",
    description: "Interactively drive the built-in pipeline.",
    positionals: [{ name: "<task>", description: "Task for the pipeline." }],
    options: [
      { name: "--auto", description: "Automatically choose pipeline transitions." },
      {
        name: "--resume-run",
        value: "<id>",
        description: "Resume a paused pipeline from its durable checkpoint.",
      },
      {
        name: "--retry-research",
        description: "Authorize retrying rejected research; requires --resume-run.",
      },
      ...PIPELINE_OPTIONS,
    ],
    run: ({ positionals, flags, booleans }) =>
      withCliProgress(
        "pipeline drive",
        parseNonNegativeIntegerFlag("--heartbeat-ms", flags["--heartbeat-ms"]) ??
          DEFAULT_HEARTBEAT_MS,
        () =>
          driveCommand(
            positionals,
            flags,
            booleans["--auto"] === true,
            booleans["--retry-research"] === true,
          ),
      ),
  },
  {
    name: "console",
    description: "Chat with the persistent orchestrator session.",
    positionals: [],
    options: [
      ...PIPELINE_OPTIONS.map((option) =>
        option.name === "--target-dir"
          ? {
              ...option,
              required: false,
              description:
                "Project directory; defaults to invocation cwd; ~/ is user-home relative.",
            }
          : option,
      ),
      { name: "--json", description: "Write one JSON record per completed turn." },
      {
        name: "--workflows",
        value: "<names>",
        description: `Enable comma-separated workflow modules; available: ${BUILT_IN_PIPELINE_WORKFLOW_NAME}.`,
      },
      {
        name: "--max-input-bytes",
        value: "<n>",
        description: "Set the maximum bytes accepted in one input line.",
      },
      {
        name: "--max-session-turns",
        value: "<n>",
        description: "Stop before a model call after this many admitted calls; 0 disables.",
      },
      {
        name: "--max-session-cost-usd",
        value: "<amount>",
        description: "Stop model calls at this observed USD threshold; 0 disables.",
      },
    ],
    run: ({ positionals, flags, booleans }) =>
      consoleCommand(positionals, flags, booleans["--json"] === true),
  },
];

function renderRootHelp(): string {
  return [
    "usage: ad-coder <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(7)} ${command.description}`),
  ].join("\n");
}

function renderCommandHelp(command: CommandDefinition): string {
  const argumentsUsage = command.positionals.map(({ name }) => name).join(" ");
  const optionsUsage =
    command.options.filter(({ required }) => !required).length === 0 ? "" : "[options]";
  const requiredOptions = command.options
    .filter(({ required }) => required)
    .map(({ name, value }) => `${name} ${value ?? ""}`.trim())
    .join(" ");
  const usage = ["usage: ad-coder", command.name, argumentsUsage, requiredOptions, optionsUsage]
    .filter(Boolean)
    .join(" ");
  const positionals =
    command.positionals.length === 0
      ? []
      : [
          "",
          "Arguments:",
          ...command.positionals.map(
            ({ name, description }) => `  ${name.padEnd(35)} ${description}`,
          ),
        ];
  const options = [
    "",
    "Options:",
    `${"  --help, -h".padEnd(37)}Show this help.`,
    ...command.options.map(
      ({ name, value, description, required }) =>
        `  ${`${name}${value === undefined ? "" : ` ${value}`}${required ? " (required)" : ""}`.padEnd(35)} ${description}`,
    ),
  ];
  return [usage, ...positionals, ...options].join("\n");
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(`${renderRootHelp()}\n`);
    return;
  }
  const commandName = argv[0];
  operationsJsonFront =
    commandName === "operations" ||
    commandName === "control" ||
    commandName === "background" ||
    commandName === "profile";
  const command = COMMANDS.find(({ name }) => name === commandName);
  if (command === undefined)
    fail(commandName === undefined ? "missing command" : `unknown command: ${commandName}`);
  if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(`${renderCommandHelp(command)}\n`);
    return;
  }
  await command.run(parseArgs(argv, command));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Only run when invoked as the entry point, so importing this module for tests
// (e.g. to exercise runRoleStandalone) does not fire the CLI dispatch.
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (operationsJsonFront) {
      const payload =
        error instanceof UserProfileError
          ? { code: error.code, detail: error.detail }
          : error instanceof ProjectOperationsError
            ? { code: error.code, detail: error.detail }
            : error instanceof ProjectStoreError
              ? { code: error.code, detail: error.path }
              : error instanceof BackgroundRunError
                ? { code: error.code, detail: error.detail }
                : { code: "internal_error" };
      process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
    } else {
      process.stderr.write(`ad-coder: ${errorMessage(error)}\n`);
    }
    process.exit(1);
  } finally {
    closeOpenAICodexWebSocketSessions();
  }
}
