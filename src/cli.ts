#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { declaredEnvProviderIds } from "./auth/declared-provider";
import { createCredentialEnvironment } from "./auth/environment-boundary";
import { resolveBuildInfo } from "./build-info";
import { runAuthCommand } from "./cli/auth";
import { runConsole } from "./cli/console";
import { driveWorkflow, silentNoopWarning } from "./cli/drive";
import { announcePauseOnce, pauseAnnouncementKey } from "./cli/pause-notice";
import type {
  BudgetPercents,
  ConfigurableRole,
  ResolvableProvider,
  ResolvePipelineConfigOptions,
} from "./cli/resolve-config";
import {
  DEFAULT_STAGE_LIMITS,
  resolvePipelineConfig,
  resolveProviderAdmissionController,
} from "./cli/resolve-config";
import { resolveResumeRun, resumeOrchestratorConfig, resumeSeedNote } from "./cli/resume";
import { DEFAULT_KILL_AFTER_MS, runsStopCommand } from "./cli/runs-stop";
import { ToolActivityRenderer } from "./cli/tool-activity";
import { loadModelsConfigSeam, loadSettingsConfigSeam } from "./config/seam";
import { defaultModelsPath, defaultSettingsPath, loadSettingsConfig } from "./config/store";
import { modelsProfileSource } from "./config/to-registry";
import type { ProviderAdmissionSettings, SettingsConfig } from "./config/types";
import type { CompactionPolicy } from "./context/compactor";
import { SessionNotAcquiredError } from "./conversation/conversation";
import { CostAnomalyDetector, FileCostAnomalyStore } from "./economics/cost-anomaly";
import {
  type CalibrationCostSample,
  forecastCost,
  latestCreditBalance,
} from "./economics/forecast";
import { readLedgerFiles, renderLedgerReport } from "./ledger/analytics";
import {
  FileLedgerSink,
  LEDGER_BASE_DIR,
  Ledger,
  type LedgerSink,
  MemoryLedgerSink,
} from "./ledger/ledger";
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
import {
  consumeRunStopRequest,
  type RunProcessIdentity,
  readRunStopRequest,
  selfProcessIdentity,
} from "./orchestration/run-stop";
import { createWorkflowSession } from "./orchestration/session";
import {
  type StageCloseoutFact,
  StageLimitError,
  type StageLimitReason,
  type StageLimitSnapshot,
  type StageLimits,
} from "./orchestration/stage-limits";
import { isSubmissionToolName } from "./orchestration/submission-tools";
import type { Complexity, PipelineConfig, RoleSpec, WorkflowPhase } from "./orchestration/types";
import { PipelinePauseError } from "./orchestration/types";
import {
  buildSubmitVerdictTool,
  REVIEW_SUBMISSION_ATTEMPTS,
  reviewRetryTask,
  SUBMIT_VERDICT_TOOL_NAME,
  type VerdictCapture,
} from "./orchestration/verdict";
import { parseProfile } from "./profiles/validate";
import {
  type CalibrationSourceRef,
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
import { clearsOnExplicitAct, RunCoordinator } from "./project-operations/run-coordinator";
import { ProjectStore } from "./project-store/project-store";
import type { ProjectStoreConfig } from "./project-store/types";
import { ProjectStoreError } from "./project-store/types";
import {
  AdmissionCancelledError,
  FileProviderAdmissionStore,
  type ProviderAdmissionController,
  QueueSaturatedError,
} from "./provider-admission";
import { parseRegistryConfig } from "./registry/validate";
import type { Role } from "./role";
import { defineRole } from "./role";
import { assertRunId, RunInterruptedError, resolveTargetDir } from "./runner/errors";
import { createRoleRunner } from "./runner/role-runner";
import type { Tool } from "./runner/tool";
import type { SessionLimits } from "./session-limits";
import { SessionLimitController } from "./session-limits";
import { SessionManager } from "./session-manager/manager";
import { SessionManagerServer } from "./session-manager/server";
import { buildLoadSkillTool, LOAD_SKILL_TOOL_NAME } from "./skills/load-tool";
import {
  dependenciesMet,
  pluginNamesFromToolNames,
  resolveSkills,
  SkillResolutionError,
  skillInventory,
} from "./skills/resolver";
import { stampBodyCheckErrors, stampCheckErrors, stampDeliveryText } from "./stamp/cli";
import { recordReviewStampFromResult, resolveStampRequirement } from "./stamp/record-review-stamp";
import { findingsReportLines } from "./stamp/verdict-findings";
import { formatUpdateResult, UpdateError, updateAdCoder } from "./update/updater";
import {
  createDefaultUserProfileStore,
  exportUserProfile,
  FileUserProfileStore,
  parseUserProfileJson,
  readUserProfileCapabilitiesSync,
  UserProfileError,
} from "./user-profile";
import type { WorkflowContext } from "./workflow";
import { isWorkflowModule } from "./workflow";
import {
  BUILT_IN_PIPELINE_WORKFLOW,
  BUILT_IN_PIPELINE_WORKFLOW_NAME,
} from "./workflows/builtin-pipeline";

// The orchestrator is included because it is a configured role like any other --
// its own prompt, its own profile row, its own ceilings -- and excluding it made
// `ad-coder role orchestrator` fail with "unknown role" while every profile
// listed it (issue #306). A one-shot orchestrator task, a scripted invocation,
// or simply asking it a question had no route but an interactive console.
const ROLE_NAMES = [
  "orchestrator",
  "planner",
  "researcher",
  "coder",
  "reviewer",
  "auditor",
  "security",
] as const;
type RoleName = (typeof ROLE_NAMES)[number];
const PROVIDERS = ["deepseek", "openrouter", "openai-codex"] as const;
const COMPLEXITIES = ["trivial", "medium", "complex"] as const;
let consoleJsonFront = false;
/**
 * True when the invoked command speaks JSON rather than to a person.
 *
 * ONE flag rather than one per command: the three OR-chains this replaced had
 * to be updated together, and `cost --json` was added to none of them -- so a
 * usage error answered a machine caller with 14 lines of human help text. A
 * single flag makes the next command's omission impossible to split.
 */
let machineJsonFront = false;
const DEFAULT_HEARTBEAT_MS = 10_000;

/**
 * The stamp gates' failure path (issue #425): a gate failure is a FACT -- the
 * newest review verdict or a digest mismatch -- with an action that clears it.
 * It is never a usage mistake, so neither front shows the help: a human gets
 * the reason then the action as words on stderr, a machine front gets the
 * stable structured shape with a typed code that is not `usage`.
 */
function failGate(reasons: string, action: string): never {
  if (machineJsonFront) {
    process.stderr.write(
      `${JSON.stringify({ error: { code: "gate_failed", text: reasons, retryable: false, nextAction: action } })}\n`,
    );
    process.exit(2);
  }
  process.stderr.write(`ad-coder: ${reasons}\n${action}\n`);
  process.exit(2);
}

function fail(message: string): never {
  // Any machine front gets the structured shape; only a human front gets the
  // help text, which would otherwise corrupt a caller parsing stderr.
  if (machineJsonFront) {
    process.stderr.write(`${JSON.stringify({ error: { code: "usage", detail: message } })}\n`);
    process.exit(2);
  }
  process.stderr.write(`ad-coder: ${message}\n${renderRootHelp()}\n`);
  process.exit(2);
}

function failInvalidConfig(message: string): never {
  if (machineJsonFront) {
    process.stderr.write(
      `${JSON.stringify({ error: { code: "invalid_config", detail: message } })}\n`,
    );
    process.exit(2);
  }
  process.stderr.write(`ad-coder: ${message}\n`);
  process.exit(2);
}

// Human budget for one `config show` row -- the same 120-column line the docs
// readability gate uses: ids join the row only while the whole row still fits,
// so an unbounded catalogue can never flood a terminal.
const CONFIG_SHOW_MAX_LINE_LENGTH = 120;

/** One resolved skill as `resolvePipelineConfig` writes it into the row. */
type ResolvedSkillEntry = { id?: unknown };

const skillId = (skill: unknown): string => String((skill as ResolvedSkillEntry).id);

/**
 * Renders one `config show` row for the human front: `name=value (source)`.
 * Scalar values print exactly as the resolver resolved them. A set-valued
 * capability renders its state and count -- ids follow the workflows row's
 * comma-list rule, but only while the whole row fits the line budget -- so a
 * set-valued value can never degrade into the `[object Object]` placeholder
 * of issue #416. The shapes mirror what `resolvePipelineConfig` resolved; the
 * renderer only formats what the resolver already decided (docs/contracts/
 * cli.md). An object value with no branch here fails the command loudly,
 * naming the KEY only, so a value can never leak into a diagnostic.
 */
export function renderConfigShowRow(name: string, value: unknown, source: string): string {
  const row = (rendered: string): string => `${name}=${rendered} (${source})`;
  if (typeof value !== "object" || value === null) return row(String(value));
  if (name === "skills") {
    const { enabled, skills } = value as { enabled?: boolean; skills?: unknown };
    // The explicit off says OFF; a switch whose reach set was never supplied
    // says ON and claims no count it does not know; a known empty set is the
    // empty pin -- still ON, with its count.
    if (enabled === false) return row("disabled");
    if (skills === null || skills === undefined) return row("enabled");
    const entries = Array.isArray(skills) ? skills.map(skillId) : [];
    const count = `${entries.length} skills enabled`;
    if (entries.length === 0) return row(count);
    const ids = entries.join(",");
    const withIds = row(`${count}: ${ids}`);
    return withIds.length <= CONFIG_SHOW_MAX_LINE_LENGTH ? withIds : row(count);
  }
  fail(
    `config show: the ${name} row carries a set-valued value with no human renderer; ` +
      `add a ${name} branch to renderConfigShowRow`,
  );
}

function shellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
  options: readonly {
    name: string;
    value?: string;
    description: string;
    required?: boolean;
    /** The value may be omitted: the flag alone is then a boolean form. */
    optional?: boolean;
  }[];
  run: (args: ParsedArgs) => Promise<void>;
  /**
   * Free help lines rendered after the options, supplied by the command's own
   * registry entry (e.g. a command's exit-code ladder) -- derived help stays
   * the only help, and the lines travel with the declaration that owns them.
   */
  notes?: readonly string[];
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
        // A boolean flag lands in both records: run handlers read nuance-free
        // booleans, while shared option plumbing (`buildConfigOptions`) reads
        // the single flags map. No boolean flag is consumed elsewhere as a
        // value flag, so the alias cannot change existing source semantics.
        booleans[option.name] = true;
        flags[option.name] = "true";
        continue outer;
      }
      if (arg === option.name && option.value !== undefined) {
        if (option.optional === true) {
          // An OPTIONAL value attaches only when the next token cannot be
          // another option (absent, or a dash token); anything else would make
          // the bare form ambiguous. The bare form lands in both records
          // exactly like a boolean flag, so a handler tells the two apart by
          // the booleans record alone -- a value never sets it. A value that
          // itself begins with `-` must ride the `--flag=value` form.
          const value = argv[i + 1];
          if (value !== undefined && !value.startsWith("-")) {
            flags[option.name] = value;
            i++;
          } else {
            booleans[option.name] = true;
            flags[option.name] = "true";
          }
          continue outer;
        }
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
function credentialEnvForTarget(
  absTargetDir: string,
  emitHumanWarning = true,
): (name: string) => string | undefined {
  return createCredentialEnvironment(absTargetDir, {
    warn: (message) => {
      if (emitHumanWarning) process.stderr.write(message);
    },
  });
}

/**
 * Build the RoleRunner a `--target-dir` run exposes as `ctx.runRole`.
 *
 * Credentials come from `builtinModels()` -- the CLI's OWN process
 * environment -- never from `<targetDir>/.env`.
 */
function buildRunner(
  targetDirArg: string,
  admissionSettings?: ProviderAdmissionSettings,
): WorkflowContext["runRole"] {
  const absTargetDir = resolveTargetDir(targetDirArg);
  const env = credentialEnvForTarget(absTargetDir);
  const models = builtinModels({
    authContext: {
      env: async (name) => env(name),
      fileExists: async (file) =>
        fs.existsSync(file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file),
    },
  });
  // A workflow module's `ctx.runRole` is a real provider call, so it passes the
  // same operator block every other entry point does. Built here rather than
  // taken from a resolved pipeline config because `run` resolves none.
  // DURABILITY (issue #365): durable runs persist under `.ad-coder/runs/` in
  // this target dir, so the controller binds its snapshot file to the same
  // durable run store root — queue occupancy, cooldown, and the uncertain
  // in-flight permit are restored beside the runs, per
  // docs/contracts/provider-admission.md. The store is lazy: constructing it
  // touches no filesystem until admission actually saves.
  const providerAdmissionController = resolveProviderAdmissionController(
    admissionSettings,
    new FileProviderAdmissionStore(absTargetDir),
  );
  return createRoleRunner({
    targetDir: absTargetDir,
    models,
    costAnomalyDetector: new CostAnomalyDetector({}, new FileCostAnomalyStore(absTargetDir)),
    ...(providerAdmissionController !== undefined && { providerAdmissionController }),
  });
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
/**
 * The pipeline role prompt, amended for a run with no submission tools.
 *
 * A role prompt is written for the PIPELINE, where a structured `submit_*` tool
 * is the canonical handoff -- the Planner's ends by forbidding the plan in
 * assistant text at all, because `submit_plan` owns it. Standalone strips those
 * tools, so the base rule would leave the role with no legal way to answer: it
 * must not speak the result and cannot submit it. The earlier wording only
 * added "return the result as assistant text", which does not resolve a direct
 * contradiction -- the model obeys whichever of the two it weighs higher. The
 * override now names the rule it displaces.
 */
/**
 * Ask once more when a review ends without its verdict -- the same retry the
 * pipeline round runs, for the same failure (issue #278), on the standalone path
 * that can now submit one at all (issue #283).
 *
 * Extracted from `roleCommand` so the accumulation is reachable by a test
 * without a provider: what it decides -- which text survives, what the run cost
 * -- is behaviour, and behaviour buried in a CLI handler is behaviour nothing
 * pins.
 */
export async function runReviewWithSubmissionRetry<
  T extends { text: string; cost: number },
>(params: {
  run: (runId: string, task: string) => Promise<T>;
  firstRunId: string;
  task: string;
  /** False for a role whose verdict tool is not registered: one attempt, no retry. */
  retries: boolean;
  submitted: () => boolean;
  newRunId?: () => string;
}): Promise<T> {
  const first = await params.run(params.firstRunId, params.task);
  if (!params.retries || params.submitted()) return first;
  const newRunId = params.newRunId ?? (() => crypto.randomUUID());
  let spent = first.cost;
  // What the next attempt is handed as "your review": every attempt's prose so
  // far, because the retry opens a session with no history of its own and would
  // otherwise submit a verdict over a review it never saw (issue #525).
  let carried = first.text;
  for (let attempt = 1; attempt < REVIEW_SUBMISSION_ATTEMPTS; attempt += 1) {
    // A FRESH run id per attempt: a turn is keyed by run id in the session
    // store, so re-asking under the first one is rejected as an existing
    // session rather than reaching the model.
    const retry = await params.run(newRunId(), reviewRetryTask(params.task, carried));
    spent += retry.cost;
    // Both texts, not just the retry's: the first attempt holds the review
    // itself, and the retry is asked to submit rather than to restate it --
    // keeping only the second would drop the reasoning the operator reads.
    const text = retry.text === "" ? first.text : `${first.text}\n\n${retry.text}`;
    if (params.submitted()) return { ...retry, text, cost: spent };
    carried = carried === "" ? retry.text : `${carried}\n\n${retry.text}`;
  }
  // Every attempt ended in prose. The caller reports the missing verdict; the
  // cost of asking twice is still the cost of this run.
  return { ...first, cost: spent };
}

export function standaloneSystemPrompt(rolePrompt: string, keptTool?: string): string {
  // A role whose submission tool IS registered here keeps the pipeline's rule
  // intact: a reviewer is a reviewer wherever it runs (issue #283), and its
  // verdict is the structured object, not prose about one. Only the roles whose
  // tool is genuinely absent get the override.
  if (keptTool !== undefined)
    return `${rolePrompt}\n\nThis is a standalone role invocation. ${keptTool} IS available and remains the way to submit your result, exactly as the instructions above describe; any OTHER structured submission tool named above is not registered here. Assistant text accompanying the submission is read by the operator, so explain your reasoning there as well.`;
  return `${rolePrompt}\n\nThis is a standalone role invocation. The structured submission tools this prompt refers to are NOT available here, and any instruction above to submit through one -- or to withhold the result from assistant text because a submission tool owns it -- does not apply to this run. Return the complete result as assistant text instead, carrying the same shape and detail the submission would have. When the task asks for a specific output format, that format governs.`;
}

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
  /**
   * Refuses the run when the operator has blocked this (provider, model).
   *
   * A standalone role reaches the provider through its own role runner, not
   * through the pipeline, so it needs the block handed to it explicitly --
   * otherwise `ad-coder role` keeps running a scope `cost status` reports as
   * blocked.
   */
  costAnomalyDetector?: CostAnomalyDetector;
  /**
   * Shared provider-capacity admission boundary (issue #365). A standalone
   * role reaches the provider through its own role runner, so the boundary is
   * handed to it explicitly, exactly like the operator block above.
   */
  providerAdmissionController?: ProviderAdmissionController;
  /** Cancels a live role run and persists a resumable pause. */
  abortSignal?: AbortSignal;
  /**
   * The signal the caller caught, read when the run's pause is written (issue
   * #479): the checkpoint says WHICH signal ended the run. A closure because
   * the value exists only after the caller's own signal handler fires, which
   * can be long after this call started.
   */
  interruptSignal?: () => "SIGINT" | "SIGTERM" | undefined;
}): Promise<{
  text: string;
  cost: number;
  ledgerPath: string | undefined;
  observations: import("./runner/runner").RoleObservations;
  /** Relay of the recorded stage closeout; absent for normal completions (issue #327). */
  stageCloseout?: StageCloseoutFact;
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
    /**
     * The process that owns (last owned) this run, recorded by the run's own
     * process at start and re-recorded by the process that resumes (issue
     * #479). Absent in checkpoints written before #479; `runs stop` refuses
     * those -- without a pid there is nothing addressable to signal.
     */
    process?: RunProcessIdentity;
    result?: {
      text: string;
      cost: number;
      ledgerPath?: string;
      observations: import("./runner/runner").RoleObservations;
      stageCloseout?: StageCloseoutFact;
    };
    pause?:
      | {
          code: "stage_limit";
          reason: StageLimitReason;
          limit: number;
          observed: number;
        }
      | {
          code: "interrupted";
          /**
           * Which signal ended the run (issue #479): an external stop is not
           * the same fact as a run that fell over, and the record is the
           * only place that distinction survives a dead process.
           */
          signal?: "SIGINT" | "SIGTERM";
          /**
           * Present only when a `runs stop` request asked for this stop; the
           * witness file it is read from is consumed by this write.
           */
          stopRequest?: { requestedAt: number; requesterPid: number };
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
    if (prior.pause?.code === "stage_limit") {
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
      {
        ...resumed,
        cumulativeUsage,
        status: "running",
        // The resuming process takes over the run: the recorded pid must be
        // its own, or `runs stop` would aim at the dead predecessor's pid
        // (issue #479). Resuming past a stop request answers it; the witness
        // is consumed so it cannot brand a later unrelated interruption.
        process: selfProcessIdentity(),
      },
      checkpoint.version,
    );
    consumeRunStopRequest(store, runId);
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
        process: selfProcessIdentity(),
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
      ...(params.costAnomalyDetector !== undefined && {
        costAnomalyDetector: params.costAnomalyDetector,
      }),
      ...(params.providerAdmissionController !== undefined && {
        providerAdmissionController: params.providerAdmissionController,
      }),
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
      ...(params.abortSignal !== undefined && { abortSignal: params.abortSignal }),
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
    if (error instanceof RunInterruptedError || params.abortSignal?.aborted === true) {
      // Issue #479: the pause names the signal that ended the run and, when a
      // `runs stop` request asked for it, that too -- "I was killed" must be
      // readable from the record long after the process is gone. The witness
      // file is read then consumed here: it stays the ONLY witness for a
      // victim that died before reaching this write.
      const signal = params.interruptSignal?.();
      const stopRequest = readRunStopRequest(store, runId);
      store.writeVersionedJson(
        checkpointPath,
        {
          ...checkpoint.value,
          status: "paused",
          pause: {
            code: "interrupted",
            ...(signal !== undefined && { signal }),
            ...(stopRequest !== undefined && {
              stopRequest: {
                requestedAt: stopRequest.requestedAt,
                requesterPid: stopRequest.requesterPid,
              },
            }),
          },
        },
        checkpoint.version,
      );
      if (stopRequest !== undefined) consumeRunStopRequest(store, runId);
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
    ...(result.stageCloseout !== undefined && { stageCloseout: result.stageCloseout }),
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
    ...(result.stageCloseout !== undefined && { stageCloseout: result.stageCloseout }),
  };
}

/** The resolved RoleSpec for a validated shipped role name. */
/** Reject an unknown role name, so no caller announces a start it cannot honour. */
function assertKnownRole(name: string | undefined): RoleName {
  if (name === undefined) fail("missing <role>");
  if (!(ROLE_NAMES as readonly string[]).includes(name))
    fail(`unknown role: ${name} (expected one of ${ROLE_NAMES.join(", ")})`);
  return name as RoleName;
}

function roleSpecFor(config: PipelineConfig, name: RoleName): RoleSpec {
  const spec =
    name === "orchestrator"
      ? config.roles.orchestrator
      : name === "planner"
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
    failInvalidConfig(`cannot parse --project-store-config ${resolved}: ${errorMessage(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("--project-store-config must contain a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  const allowedTop = new Set(["retention", "byteLimits", "lockRetry", "projectOperations"]);
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
  const lockRetry = object.lockRetry;
  if (lockRetry !== undefined) {
    if (typeof lockRetry !== "object" || lockRetry === null || Array.isArray(lockRetry))
      failInvalidConfig("--project-store-config lockRetry must be an object");
    const lockObject = lockRetry as Record<string, unknown>;
    if (Object.keys(lockObject).some((key) => key !== "delaysMs"))
      failInvalidConfig("--project-store-config contains an unknown lockRetry setting");
    const delays = lockObject.delaysMs;
    if (
      delays !== undefined &&
      (!Array.isArray(delays) ||
        delays.length === 0 ||
        delays.some(
          (delay) => typeof delay !== "number" || !Number.isSafeInteger(delay) || delay <= 0,
        ))
    )
      failInvalidConfig("invalid --project-store-config setting: lockRetry.delaysMs");
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

/**
 * The operator side of a cost-anomaly block: see what is blocked, accept a price.
 *
 * Reads the same durable store the runtime writes, so a block raised by an
 * unattended run is visible and liftable from a later, separate invocation --
 * which is the only way the refusal's own advice can be followed at all.
 */
function costCommand(positionals: string[], flags: Record<string, string | undefined>): void {
  const action = positionals[1];
  if (action !== "status" && action !== "release") fail("the cost command takes status or release");

  // Same default as `console`: cost state is per-project, and an operator
  // standing in the project is already naming it. Requiring the flag here while
  // the console defaulted it made the refusal's own advice unfollowable
  // (`docs/contracts/cli.md`).
  const targetDir = resolveTargetDir(flags["--target-dir"] ?? process.cwd());
  const detector = new CostAnomalyDetector({}, new FileCostAnomalyStore(targetDir));

  if (action === "status") {
    if (positionals[2] !== undefined) fail("cost status accepts no scope argument");
    process.stdout.write(`${JSON.stringify({ blocked: detector.blocked() })}\n`);
    return;
  }

  const scope = positionals[2];
  // Spelled exactly as the refusal names it, so the operator can paste the
  // command back verbatim instead of translating it.
  if (scope === undefined) fail("cost release needs a <provider>/<model> scope");
  const separator = scope.indexOf("/");
  if (separator <= 0 || separator === scope.length - 1)
    fail("a cost scope is spelled <provider>/<model>");
  const provider = scope.slice(0, separator);
  const model = scope.slice(separator + 1);

  const released = detector.release(provider, model);
  // A scope that was not blocked is reported, not silently treated as success:
  // a typo in the scope would otherwise read as "released" while the real
  // block stayed up.
  if (released === undefined) fail(`no block is recorded for ${scope}`);
  process.stdout.write(`${JSON.stringify({ released: { provider, model, block: released } })}\n`);
}

/**
 * Read real work back out of the ledger the runs already wrote.
 *
 * A bad action or a file that cannot be opened raises with the path named, so
 * an operator's typo is an input error rather than a silently empty report. A
 * file that exists but was interrupted mid-write is NOT an error: it is parsed
 * per line, and the skipped-line count is part of the report.
 */
export function ledgerCommand(positionals: string[], json: boolean): void {
  const action = positionals[1];
  if (action !== "report") fail("the ledger command takes report");
  const fileArgs = positionals.slice(2);
  const paths =
    fileArgs.length > 0
      ? fileArgs.map((fileArg) => path.resolve(fileArg))
      : listDefaultLedgerFiles();
  let report: ReturnType<typeof readLedgerFiles>;
  try {
    report = readLedgerFiles(paths);
  } catch (error) {
    // A path that cannot be opened is invalid input, not an internal failure.
    fail(`cannot read ledger file: ${errorMessage(error)}`);
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  process.stdout.write(renderLedgerReport(report));
}

function listDefaultLedgerFiles(): string[] {
  const base = path.resolve(LEDGER_BASE_DIR);
  if (!fs.existsSync(base)) fail(`no ledger files exist under ${LEDGER_BASE_DIR}/`);
  const names = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(base, entry.name));
  if (names.length === 0) fail(`no *.jsonl ledger files exist under ${LEDGER_BASE_DIR}/`);
  return names;
}

/**
 * The delivery paperwork surfaces (issues #240 and #239).
 *
 * `stamp delivery` renders the compact signature block straight from the
 * ledger the run wrote -- a projection, never a model's summary of its own
 * cost. `stamp body-check` is the PR-body gate: it fails loudly when the pull-
 * request body does not carry the freshly rendered delivery block verbatim
 * (issue #335). `stamp check` is the review-stamp gate: it fails loudly when the
 * newest stamp is missing, malformed, or names a tree digest no longer
 * matching the current tree (src/stamp/review-stamp.ts). Both are read-only;
 * the stamp WRITER is the run-finish hook, not a CLI hand-write path.
 *
 * A missing ledger or a red stamp check is operator-relevant failure with the
 * reason named, not an empty success.
 */
function stampCommand(positionals: string[], flags: Record<string, string | undefined>): void {
  const action = positionals[1];
  if (action !== "delivery" && action !== "check" && action !== "body-check")
    fail("the stamp command takes delivery, check, or body-check");
  const targetDir = resolveTargetDir(flags["--target-dir"] ?? process.cwd());
  if (action === "delivery") {
    const fileArgs = positionals.slice(2);
    process.stdout.write(`${stampDeliveryText(targetDir, fileArgs)}\n`);
    return;
  }
  if (action === "body-check") {
    const bodyPath = positionals[2];
    if (bodyPath === undefined)
      fail("stamp body-check requires a pull-request body file path as the first argument");
    const fileArgs = positionals.slice(3);
    const failures = stampBodyCheckErrors(bodyPath, targetDir, fileArgs);
    if (failures.length > 0)
      failGate(
        failures.map(({ reason }) => reason).join("\n"),
        failures.map(({ action }) => action).join("\n"),
      );
    process.stdout.write("stamp body-check: the delivery block is present and fresh\n");
    return;
  }
  if (positionals[2] !== undefined) fail("stamp check accepts no path arguments");
  // The settings layer may force the gate off; absent settings defer to the
  // marker (today's behaviour). Loaded through the seam so a malformed file
  // refuses and an absent file defaults, never a silent switch.
  const requireStamp = resolveStampRequirement(loadSettingsConfigSeam(defaultSettingsPath()));
  const errors = stampCheckErrors(targetDir, requireStamp);
  if (errors.length > 0)
    failGate(
      errors.map(({ reason }) => reason).join("\n"),
      [...new Set(errors.map(({ action }) => action))].join("\n"),
    );
  process.stdout.write("stamp check: the newest review stamp is fresh\n");
}

/**
 * The calibration source for a `models.yaml` profile (#506): which provider/
 * model pairs that profile can serve, derived by the SAME walk the registry
 * resolves with, so a snapshot scopes its economics to what the profile really
 * reaches. `models.yaml` is read through the resolver's own seam -- a
 * present-but-unusable file is a typed refusal that names the field, and an
 * absent one is refused HERE, because a snapshot names a profile it must have
 * been able to read.
 */
function modelsProfileSourceRef(
  name: string,
  modelsConfigPath: string | undefined,
): CalibrationSourceRef {
  const models = loadModelsConfigSeam(modelsConfigPath ?? defaultModelsPath());
  if (models === undefined)
    fail(`profile snapshot --models-profile needs models.yaml: no models.yaml at the models path`);
  return { kind: "models-profile", ...modelsProfileSource(models, name) };
}

/**
 * The provider a `models.yaml` route would authenticate against, for the
 * console's login hint: the first provider the SELECTED profile reaches, walked
 * the same way the resolver dispatches.
 *
 * A hint must never be the reason a console fails to start. `models.yaml` is
 * the only stored route left (issue #513), and if it is malformed or names a
 * profile that does not exist, the RESOLVE raises the typed error naming the
 * field -- which is where an operator can act on it. So the hint answers
 * `undefined` for anything it cannot read and says nothing.
 */
function storedRouteProvider(
  modelsConfigPath: string | undefined,
  modelsProfile: string | undefined,
): string | undefined {
  try {
    const models = loadModelsConfigSeam(modelsConfigPath ?? defaultModelsPath());
    if (models === undefined) return undefined;
    return modelsProfileSource(models, modelsProfile).providers[0]?.id;
  } catch {
    return undefined;
  }
}

async function profileCommand(positionals: string[], flags: Record<string, string | undefined>) {
  const action = positionals[1];
  if (
    action !== "show" &&
    action !== "export" &&
    action !== "snapshot" &&
    action !== "record" &&
    action !== "estimate" &&
    action !== "import-preview" &&
    action !== "import-apply"
  )
    fail(
      "profile requires show, export, snapshot, record, estimate, import-preview, or import-apply",
    );
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
    const modelsProfile = flags["--models-profile"];
    if (targetDir === undefined) fail("profile snapshot requires --target-dir");
    // A JSON inventory is no longer a routing source (issue #513), so the only
    // source a snapshot can name is a models.yaml profile. The flag is refused
    // by name rather than ignored: a caller still passing it is naming a
    // namespace nothing resolves against any more.
    if (inventory !== undefined)
      fail(
        "profile snapshot no longer takes --inventory: a JSON inventory is not a routing source; name a models.yaml profile with --models-profile <name> (issue #513)",
      );
    if (modelsProfile === undefined) fail("profile snapshot requires --models-profile <name>");
    const source: CalibrationSourceRef = modelsProfileSourceRef(
      modelsProfile,
      flags["--models-config"],
    );
    const snapshot = createProjectCalibrationSnapshot(current, source);
    const file = writeProjectCalibrationSnapshot(resolveTargetDir(targetDir), snapshot);
    process.stdout.write(`${JSON.stringify({ file, snapshot })}\n`);
    return;
  }
  if (action === "record") {
    const raw = readProfileJsonInput(flags["--input"]);
    const profile = await store.appendEconomicRecord(raw);
    process.stdout.write(
      `${JSON.stringify({ path: store.path, record: profile.economicRecords.at(-1) })}\n`,
    );
    return;
  }
  if (action === "estimate") {
    const evidence = flags["--evidence"];
    const complexity = flags["--complexity"] as Complexity | undefined;
    const provider = flags["--provider"];
    const creditsPerUsd = flags["--credits-per-usd"];
    if (evidence === undefined || complexity === undefined || provider === undefined)
      fail("profile estimate requires --evidence, --complexity, and --provider");
    if (!(COMPLEXITIES as readonly string[]).includes(complexity)) fail("invalid --complexity");
    const parsedRate = creditsPerUsd === undefined ? undefined : Number(creditsPerUsd);
    if (parsedRate !== undefined && (!Number.isFinite(parsedRate) || parsedRate <= 0))
      fail("--credits-per-usd must be a positive number");
    const rows = fs
      .readFileSync(resolveScriptPath(evidence), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as CalibrationCostSample);
    const balance = latestCreditBalance(current, provider)?.value;
    process.stdout.write(
      `${JSON.stringify(forecastCost(rows, complexity, { ...(balance !== undefined && { creditBalance: balance }), ...(parsedRate !== undefined && { creditsPerUsd: parsedRate }) }))}\n`,
    );
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
    ...number("--background-max-wake-entries", "maxWakeEntriesPerRun"),
    ...number("--background-max-wakes-per-turn", "maxWakesPerTurn"),
    ...(policy === undefined
      ? {}
      : { sameTargetPolicy: policy as BackgroundRunLimits["sameTargetPolicy"] }),
  };
}

/**
 * A stable owner scope for one user + one target directory, so a console and a
 * later `ad-coder background status` in the same project see the same runs.
 * The directory is hashed rather than embedded: the manager's owner id is a
 * bounded opaque token (`^[A-Za-z0-9._:-]{1,128}$`), and a raw path both breaks
 * that shape on the first slash and puts a filesystem path into durable state.
 */
function defaultBackgroundOwnerId(targetDir: string): string {
  const digest = createHash("sha256").update(targetDir).digest("base64url").slice(0, 32);
  return `local.${process.getuid?.() ?? "user"}.${digest}`;
}

/** Every workflow module a plain ad-coder ships; the pool a selection resolves against. */
const BUILT_IN_WORKFLOW_NAMES: readonly string[] = [BUILT_IN_PIPELINE_WORKFLOW_NAME];

/**
 * `--workflows` is the launch parameter for the set-valued workflow capability.
 * Unset keeps the built-in default (every shipped module ON); a comma list is
 * an exact selection; a `^name` token excludes from the default; `false` turns
 * the capability off explicitly. An unknown or malformed name fails HERE, with
 * the available list, instead of falling through to a resolver error.
 */
function resolveWorkflowsFlag(flag: string | undefined): {
  names: readonly string[];
  source: "cli" | "built-in-default";
} {
  if (flag === undefined) return { names: BUILT_IN_WORKFLOW_NAMES, source: "built-in-default" };
  if (flag === "false" || flag === "off") return { names: [], source: "cli" };
  const excludedShape = BUILT_IN_WORKFLOW_NAMES.map((name) => `^${name}`).join(",");
  const tokens = flag
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  for (const name of tokens) {
    const bare = name.startsWith("^") ? name.slice(1) : name;
    if (!BUILT_IN_WORKFLOW_NAMES.includes(bare))
      fail(
        `--workflows expects comma-separated ${BUILT_IN_WORKFLOW_NAMES.join(",")}, false, or ` +
          `${excludedShape} to exclude`,
      );
  }
  const selected = tokens.filter((token) => !token.startsWith("^"));
  const excluded = tokens.filter((token) => token.startsWith("^")).map((token) => token.slice(1));
  return {
    names: [
      ...new Set(
        selected.length > 0
          ? selected
          : BUILT_IN_WORKFLOW_NAMES.filter((name) => !excluded.includes(name)),
      ),
    ],
    source: "cli",
  };
}

/** The CLI owns process creation; orchestration only receives this provider. */
function createBackgroundHostLauncher(
  targetDir: string,
  ownerId: string,
  /** Pinned ids travel to the isolated worker verbatim; the catalogue needs nothing. */
  selectedSkills: readonly string[] = [],
  skillsDisabled: boolean = false,
  /** Capability switches launched explicitly travel verbatim to the worker. */
  inheritedFlags: readonly string[] = [],
): BackgroundHostLauncher {
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
          ...(selectedSkills.length > 0
            ? ["--skills", selectedSkills.join(",")]
            : skillsDisabled
              ? ["--no-skills"]
              : // A set-valued switch the operator typed (workflows, plugins)
                // repeats verbatim; anything else the worker re-resolves from
                // its own profile read (docs/contracts/config.md, 2026-09-17).
                [...inheritedFlags]),
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

/**
 * The set-valued capability switches an operator typed at launch. The worker
 * re-resolves everything else from its own environment; repeating these words
 * verbatim is what keeps `--workflows false` and `--plugins none` from
 * resolving back to enabled-by-default inside the detached process.
 *
 * The same mechanism carries the operator's explicit routing/credential
 * selection to the worker (issue #453): without this a detached worker
 * re-reads the default credential store and a stored-config seam from its
 * own home directory, so the routing/credential it picked is not the one
 * the operator typed on the console. Only flags the operator actually typed
 * travel; an absent flag stays absent and the worker keeps its own default.
 */
function inheritedCapabilityFlags(flags: Record<string, string | undefined>): readonly string[] {
  const inherited: string[] = [];
  if (flags["--workflows"] !== undefined) inherited.push("--workflows", flags["--workflows"]);
  if (flags["--plugins"] !== undefined) inherited.push("--plugins", flags["--plugins"]);
  // Routing/credential selection -- typed verbatim (issue #453).
  if (flags["--models-config"] !== undefined) {
    inherited.push("--models-config", flags["--models-config"] as string);
  }
  if (flags["--settings-config"] !== undefined) {
    inherited.push("--settings-config", flags["--settings-config"] as string);
  }
  if (flags["--models-profile"] !== undefined) {
    inherited.push("--models-profile", flags["--models-profile"] as string);
  }
  if (flags["--registry-config"] !== undefined) {
    inherited.push("--registry-config", flags["--registry-config"] as string);
  }
  if (flags["--profile-config"] !== undefined) {
    inherited.push("--profile-config", flags["--profile-config"] as string);
  }
  if (flags["--credential-path"] !== undefined) {
    inherited.push("--credential-path", flags["--credential-path"] as string);
  }
  if (flags["--provider"] !== undefined) {
    inherited.push("--provider", flags["--provider"] as string);
  }
  return inherited;
}

/**
 * The one launcher seam every background front builds through: the console
 * session and the `background start` front. It re-resolves the operator's own
 * flag surface and carries the resolved pin, the off, and every explicitly
 * launched set-valued switch into the worker command, so a capability the
 * operator switched off stays off inside the detached process it cannot see
 * (docs/contracts/config.md, 2026-09-17; issue #245). Exported so the boundary
 * is testable as shipped behavior rather than only through a spawn.
 */
export function backgroundHostLauncherFor(
  targetDirArg: string,
  ownerId: string,
  flags: Record<string, string | undefined>,
  configOptions?: Omit<ResolvePipelineConfigOptions, "task">,
): BackgroundHostLauncher {
  const options = configOptions ?? buildConfigOptions(targetDirArg, flags);
  return createBackgroundHostLauncher(
    resolveTargetDir(targetDirArg),
    ownerId,
    options.selectedSkills ?? [],
    options.skillsDisabled === true,
    inheritedCapabilityFlags(flags),
  );
}

/** JSON-only management front for session-owned background pipeline records. */ async function backgroundCommand(
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
  const ownerId = flags["--owner-id"] ?? defaultBackgroundOwnerId(targetDir);
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
    action === "start" ? backgroundHostLauncherFor(targetArg, ownerId, flags) : undefined;
  const manager = new BackgroundRunManager(
    async (task, runId, control) => {
      // The detached worker is the only entry that opts into refusing an
      // unresolvable route (issue #453): the worker's environment may not be
      // the console's, so a route the operator never picked must not be
      // substituted behind the typed launch parameters the worker already
      // inherited verbatim. The console and the `background start` front keep
      // their present env-preset/codex fallback.
      const config = resolvePipelineConfig({
        task,
        ...buildConfigOptions(targetArg, flags),
        requireResolvableRoute: true,
      });
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

/**
 * The operator's `settings.yaml` when the file exists; an ABSENT file is the
 * defaults case, not an error (the store refuses to read a missing file). A
 * present file is validated strictly, so a malformed setting fails the command
 * loudly -- a violation is always blocking (docs/contracts/config.md).
 */
function loadOptionalSettingsConfig(): SettingsConfig | undefined {
  const file = defaultSettingsPath();
  if (!fs.existsSync(file)) return undefined;
  return loadSettingsConfig(file);
}

function buildConfigOptions(
  targetDirArg: string,
  flags: Record<string, string | undefined>,
): Omit<ResolvePipelineConfigOptions, "task"> {
  const provider = parseProviderFlag(flags["--provider"]);
  const maxRounds = parseMaxRoundsFlag(flags["--max-rounds"]);
  const defaultComplexity = parseComplexityFlag(flags["--default-complexity"]);
  const plannerHandoffAttemptsRaw = flags["--planner-handoff-attempts"];
  const plannerHandoffAttempts =
    plannerHandoffAttemptsRaw === undefined
      ? undefined
      : plannerHandoffAttemptsRaw === "1" || plannerHandoffAttemptsRaw === "2"
        ? (Number(plannerHandoffAttemptsRaw) as 1 | 2)
        : fail("invalid --planner-handoff-attempts: expected 1 or 2");
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
  const hasIndependentModelConfig = [
    provider,
    registryConfig,
    flags["--profile-config"],
    flags["--strong-model"],
    flags["--mid-model"],
    flags["--cheap-model"],
    ...ROLE_NAMES.map((role) => flags[`--${role}-model`]),
    flags["--orchestrator-model"],
  ].some((value) => value !== undefined);
  // The stored YAML config (issue #280). `settings.yaml` (behaviour) applies to
  // every run; `models.yaml` (routing) applies only when no independent model
  // override is given. The paths are injected (defaulting to the XDG config
  // location) so tests point them at temp files; `--models-config` /
  // `--settings-config` let an operator override them.
  const modelsConfigPath =
    flags["--models-config"] ?? (!hasIndependentModelConfig ? defaultModelsPath() : undefined);
  const settingsConfigPath = flags["--settings-config"] ?? defaultSettingsPath();
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
  const credentialEnv = credentialEnvForTarget(targetDir, !consoleJsonFront);
  const credentialPath = flags["--credential-path"];
  if (credentialPath !== undefined) assertCredentialPathOutsideProject(credentialPath, targetDir);
  // Same surface every command: no `--skills` means the catalogue a role
  // loads from; a value pins exactly those ids (empty trims back to catalogue).
  const skillsFlag = flags["--skills"];
  if (flags["--no-skills"] !== undefined && skillsFlag !== undefined)
    fail("--no-skills cannot be combined with --skills");
  const selectedSkills =
    skillsFlag === undefined
      ? undefined
      : skillsFlag
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);
  // Layer order (docs/contracts/config.md): explicit flag beats the persistent
  // setting, which beats the built-in default. A pin is also explicit, so a
  // `--skills` value disables the setting in both directions; only when NEITHER
  // flag resolves does the profile's capability switch apply.
  let skillsDisabled = flags["--no-skills"] !== undefined;
  if (!skillsDisabled && skillsFlag === undefined) {
    // The user profile is a user-level boundary, outside the target's dotenv
    // boundary: read the process environment directly, exactly as the profile
    // store's own default-location choice does.
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    const capabilities = readUserProfileCapabilitiesSync({
      userHome: os.homedir(),
      ...(xdgConfigHome === undefined ? {} : { xdgConfigHome }),
    });
    skillsDisabled = capabilities.skills === false;
  }
  const workflows = resolveWorkflowsFlag(flags["--workflows"]);
  // The composition a run's role kits are handed: the workflows this launch
  // resolved and the plugin groups its flag registers. Both selection modes
  // filter by it, because pin mode drops a skill whose `requires` is unmet
  // (src/skills/role-kit.ts) -- a row that skipped the filter would advertise a
  // capability no run reaches (docs/contracts/skills.md, 2026-09-17).
  const skillComposition = {
    availableWorkflows: workflows.names,
    // The flag's own resolution decides plugin availability here, so the
    // skill row reports what this launch actually registers: `--plugins
    // none` proves nothing, an unset flag is the built-in default set.
    availablePlugins: enabledPlugins ?? ["explore", "web", "vision"],
  };
  const skillSet = skillsDisabled
    ? []
    : selectedSkills !== undefined
      ? // A pin still resolves loudly -- unknown, malformed, duplicate, and
        // oversized ids fail through resolveSkills exactly as before -- and
        // only the reported set is filtered, so the row names what a run pastes.
        resolveSkills(selectedSkills, { projectDir: targetDir }).filter((skill) =>
          dependenciesMet(skill.requires, skillComposition),
        )
      : skillInventory({ projectDir: targetDir, ...skillComposition });
  // Source names the layer that decided the set, so profile-off cannot hide
  // behind a flag default and a flag cannot pose as the built-in default.
  const skillsSource: "cli" | "profile" | "built-in-default" =
    flags["--no-skills"] !== undefined || skillsFlag !== undefined
      ? "cli"
      : skillsDisabled
        ? "profile"
        : "built-in-default";
  // The persistent-setting layer for provider admission (docs/contracts/
  // config.md): the operator's `provider-admission` section, when one was
  // written, resolves ahead of the built-in default. The section travels with
  // its source so `config show` can name the layer that set it.
  const settings = loadOptionalSettingsConfig();
  const providerAdmissionSettings =
    settings !== undefined && Object.keys(settings.providerAdmission).length > 0
      ? settings.providerAdmission
      : undefined;
  return {
    targetDir,
    // Set-valued capability with the one shared resolution: unset = built-in
    // default (every shipped module), `false` = off, a comma list selects,
    // `^name` excludes from the default. Source travels so enabled-by-default
    // is never silent (docs/contracts/config.md, 2026-09-16).
    selectedWorkflows: workflows.names,
    workflowsSource: workflows.source,
    skillInventory: skillSet.map(({ id, version, source, sha256 }) => ({
      id,
      version,
      source,
      sha256,
    })),
    skillsSource,
    // A machine front parses stderr as JSON: the resolver's operator-facing
    // banner must never mix into it (docs/contracts/cli.md).
    warn: (message: string) => {
      if (!machineJsonFront) process.stderr.write(message);
    },
    env: credentialEnv,
    ...(credentialPath !== undefined && {
      credentials: new FileCredentialStore({ path: credentialPath }),
    }),
    ...(provider !== undefined && { provider }),
    ...(selectedSkills !== undefined && { selectedSkills }),
    ...(skillsDisabled && { skillsDisabled: true }),
    ...(flags["--strong-model"] !== undefined && { strongModel: flags["--strong-model"] }),
    ...(flags["--mid-model"] !== undefined && { midModel: flags["--mid-model"] }),
    ...(flags["--cheap-model"] !== undefined && { cheapModel: flags["--cheap-model"] }),
    ...(registryConfig !== undefined && { registryConfig }),
    ...(modelsConfigPath !== undefined && { modelsConfigPath }),
    ...(settingsConfigPath !== undefined && { settingsConfigPath }),
    ...(flags["--models-profile"] !== undefined && {
      modelsProfile: flags["--models-profile"],
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
    ...(providerAdmissionSettings !== undefined && {
      providerAdmissionSettings,
      providerAdmissionSettingsSource: "settings" as const,
    }),
    ...(maxRounds !== undefined && { maxRounds }),
    ...(defaultComplexity !== undefined && { defaultComplexity }),
    ...(plannerHandoffAttempts !== undefined && { plannerHandoffAttempts }),
    ...(projectStoreConfig !== undefined && { projectStoreConfig }),
    ...(Object.keys(toolActivity).length > 0 && { toolActivity }),
  };
}

/** Full stderr notice line naming the closeout reason (issue #327, pure for tests). */
export function formatStageCloseoutNotice(closeout: StageCloseoutFact): string {
  return `ad-coder: stage closeout (${closeout.reason}): ${closeout.detail}\n`;
}

/** Run a single role standalone against a target directory, resolved from the environment. */
async function roleCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
): Promise<void> {
  const name = assertKnownRole(positionals[1]);
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
  const resumeRunId = flags["--resume-run"];
  // Resolved before the tools, because `submit_verdict` threads this run id onto
  // any rejection it reports.
  const standaloneRunId = resumeRunId ?? crypto.randomUUID();
  // Identical skill behaviour in every command: the role's prompt (pinned or
  // catalogue) comes from the resolver; the loader ships exactly when the
  // prompt lists skills, alongside the same plugin tools the runner receives.
  const rolePluginTools = config.pluginToolsForModel?.(spec.model) ?? config.pluginTools;
  const roleSkillTools = spec.role.activeToolNames?.includes(LOAD_SKILL_TOOL_NAME)
    ? [
        buildLoadSkillTool({
          role: name,
          projectDir: configOptions.targetDir,
          availableWorkflows: configOptions.selectedWorkflows ?? ["pipeline"],
          availablePlugins: pluginNamesFromToolNames([
            ...(spec.role.activeToolNames ?? []),
            ...(rolePluginTools ?? []).map((tool) => tool.name),
          ]),
        }),
      ]
    : [];
  // A standalone reviewer keeps `submit_verdict`. The tool is not pipeline
  // machinery -- it is how a review states its result as an object rather than
  // as prose about one, and the review stamp is derived from that object and
  // never from text (src/stamp/record-review-stamp.ts). Stripping it made the
  // single-role path unable to produce the paperwork its own gate demands, and
  // pushed the reviewer toward the prose ending #278 had to retry around.
  const verdictCapture: VerdictCapture = {};
  const keepsVerdictTool =
    name === "reviewer" && (spec.role.activeToolNames ?? []).includes(SUBMIT_VERDICT_TOOL_NAME);
  const standaloneSubmissionTools = keepsVerdictTool
    ? [buildSubmitVerdictTool(verdictCapture, standaloneRunId)]
    : [];
  const standaloneTools =
    rolePluginTools === undefined &&
    roleSkillTools.length === 0 &&
    standaloneSubmissionTools.length === 0
      ? undefined
      : [...standaloneSubmissionTools, ...roleSkillTools, ...(rolePluginTools ?? [])];
  const standaloneRole = defineRole(
    {
      ...spec.role,
      systemPrompt: keepsVerdictTool
        ? standaloneSystemPrompt(spec.role.systemPrompt, SUBMIT_VERDICT_TOOL_NAME)
        : standaloneSystemPrompt(spec.role.systemPrompt),
      activeToolNames: (spec.role.activeToolNames ?? []).filter((tool) =>
        keepsVerdictTool && tool === SUBMIT_VERDICT_TOOL_NAME ? true : !isSubmissionToolName(tool),
      ),
    },
    spec.model,
  );
  const standaloneStageLimits =
    config.roleStageLimits?.[name as keyof NonNullable<typeof config.roleStageLimits>] ??
    config.stageLimits;
  const renderer = new ToolActivityRenderer(process.stderr, "human", config.toolActivity);
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
  const abortController = new AbortController();
  let receivedSignal: "SIGINT" | "SIGTERM" | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    receivedSignal ??= signal;
    abortController.abort();
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const runOnce = async (
    attemptRunId: string,
    attemptTask: string,
    attemptRole: typeof standaloneRole,
  ) =>
    await runRoleStandalone({
      role: attemptRole,
      model: spec.model,
      models: config.models,
      targetDir: configOptions.targetDir,
      task: attemptTask,
      runId: attemptRunId,
      ...(resumeRunId !== undefined && attemptRunId === standaloneRunId
        ? { resumeExisting: true }
        : {}),
      ...(standaloneTools !== undefined && { tools: standaloneTools }),
      activityConsumer: renderer.consume,
      ...(config.compaction !== undefined && { compaction: config.compaction }),
      ...(config.projectStoreConfig !== undefined && {
        projectStoreConfig: config.projectStoreConfig,
      }),
      ...(config.toolActivity !== undefined && { toolActivity: config.toolActivity }),
      ...(standaloneStageLimits !== undefined && { stageLimits: standaloneStageLimits }),
      ...(config.costAnomalyDetector !== undefined && {
        costAnomalyDetector: config.costAnomalyDetector,
      }),
      ...(config.providerAdmissionController !== undefined && {
        providerAdmissionController: config.providerAdmissionController,
      }),
      abortSignal: abortController.signal,
      // The pause names the signal that ended the run (issue #479); only the
      // handlers above know which one fired.
      interruptSignal: () => receivedSignal,
    });
  const standaloneResult = await (async () => {
    try {
      return await runReviewWithSubmissionRetry({
        run: (attemptRunId, attemptTask) => runOnce(attemptRunId, attemptTask, standaloneRole),
        firstRunId: standaloneRunId,
        task,
        retries: keepsVerdictTool,
        submitted: () => verdictCapture.verdict !== undefined || verdictCapture.error !== undefined,
      });
    } catch (error) {
      process.stderr.write(`ad-coder: partial usage ledger=${expectedLedgerPath}\n`);
      process.stderr.write(
        `ad-coder: standalone checkpoint=${expectedCheckpointPath} runId=${standaloneRunId}\n`,
      );
      process.stderr.write(
        `ad-coder: resume with role ${name} <same-task> --resume-run ${standaloneRunId} and adjusted limits\n`,
      );
      if (error instanceof RunInterruptedError && receivedSignal !== undefined) {
        process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
        return undefined;
      }
      throw error;
    } finally {
      renderer.close();
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  })();
  if (standaloneResult === undefined) return;
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
  // The machine-readable closeout relay stays on the result; stderr only says WHY.
  if (standaloneResult.stageCloseout !== undefined) {
    process.stderr.write(formatStageCloseoutNotice(standaloneResult.stageCloseout));
  }
  if (keepsVerdictTool) {
    // The verdict object, not the prose, decides. A rejected submission reports
    // why it was rejected -- the reviewer said something and it did not parse,
    // which is a different failure from saying nothing.
    if (verdictCapture.error !== undefined) {
      process.stderr.write(`ad-coder: verdict rejected: ${verdictCapture.error.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (verdictCapture.verdict === undefined) {
      // An honest exhaustion is not a crash (issue #327): when the reserve the
      // closeout notice above names forced the run to settle without a verdict,
      // exit 0 -- the reason is on record. Without a closeout, no verdict is
      // still today's failure.
      if (standaloneResult.stageCloseout !== undefined) {
        // The closeout notice (printed above, right after the usage line) names
        // the reason, so an honest exhaustion is not a crash here (issue #327).
        return;
      }
      process.stderr.write(
        `ad-coder: the reviewer ended without calling ${SUBMIT_VERDICT_TOOL_NAME}; no stamp written\n`,
      );
      process.exitCode = 1;
      return;
    }
    const verdict = verdictCapture.verdict;
    process.stderr.write(`ad-coder: verdict ${verdict.status} issues=${verdict.issues.length}\n`);
    // Same writer the pipeline settles through, fed the same structured fields
    // (issue #283): a review is a review wherever it ran, and no path transcribes
    // a verdict out of prose. The settled verdict is handed over too so the
    // findings artifact (issue #466) is written from this front as it is from
    // the pipeline fronts -- without it a `changes_requested` settle here could
    // only stamp a count, never persist the findings themselves.
    const outcome = recordReviewStampFromResult(
      configOptions.targetDir,
      {
        approved: verdict.status === "approved",
        runIds: [standaloneRunId],
        stageMetrics: [{ stage: "review:1", provider: spec.model.provider, model: spec.model.id }],
        reviewRan: true,
        verdicts: [{ status: verdict.status, issues: verdict.issues, summary: verdict.summary }],
      },
      new Date(),
      config.requireStamp,
    );
    // The bounded findings report BESIDE the count line (issue #466): the count
    // line above is what a consumer greps and it stays; these lines are what
    // make a `changes_requested` round actionable from the settle output alone,
    // and the ref names the artifact carrying the durable findings.
    if (outcome.findingsRef !== "-") {
      for (const line of findingsReportLines(outcome.findingsRef, verdict.issues))
        process.stderr.write(`ad-coder: ${line}\n`);
    }
    process.stderr.write(
      outcome.recorded
        ? `ad-coder: review stamp appended to ${outcome.filePath}\n`
        : `ad-coder: no review stamp: ${outcome.skippedBecause}\n`,
    );
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

  // The run id is chosen HERE rather than inside the coordinator so the ledger
  // file, the checkpoint and the resume token all name the same run: resuming
  // then appends to the very file the interrupted attempt wrote.
  const resumeRun = flags["--resume-run"];
  const driveRunId = resumeRun ?? crypto.randomUUID();
  // resolvePipelineConfig assigns its own internal LedgerSink (typed as the
  // non-readable interface); replace it with a readable instance the drive loop
  // sums per-step and total cost from, and drive against that same instance.
  // It MIRRORS to the same durable file `ad-coder role` writes: a readable sink
  // is what this front needs to report cost, not a reason for the whole run to
  // leave no audit trail behind.
  const driveLedgerPath = path.join(
    resolveTargetDir(targetDirArg),
    ".ad-coder",
    "ledger",
    `${driveRunId}.jsonl`,
  );
  const ledgerSink = new MemoryLedgerSink(new FileLedgerSink(driveLedgerPath));
  config.ledgerSink = ledgerSink;
  const renderer = new ToolActivityRenderer(process.stderr, "human", config.toolActivity);
  config.activityConsumer = renderer.consume;
  const session = createWorkflowSession(config);
  process.stderr.write(`ad-coder: runId=${driveRunId} ledger=${driveLedgerPath}\n`);
  try {
    const coordinator = new RunCoordinator(session, session.projectStore, {
      runId: driveRunId,
      ...(resumeRun === undefined ? {} : { resumeExisting: true }),
      task,
    });
    if (retryResearch) coordinator.resumeResearch({ source: "operator", action: "retry" });
    // Same agreement as the orchestrator's `resume_pipeline`: an explicit
    // resume act clears every pause `resumeStage` accepts from an operator,
    // not only the stage ceiling.
    if (resumeRun !== undefined && clearsOnExplicitAct(coordinator.checkpoint.pause?.code))
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
    // The mirrored sink holds a descriptor for the whole drive; release it
    // whether the loop finished, threw, or was interrupted.
    ledgerSink.close();
    renderer.close();
  }
}

async function consoleCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
  booleans: Record<string, boolean>,
  json: boolean,
): Promise<void> {
  if (positionals[1] !== undefined) fail("the console command accepts no positional arguments");
  const targetDirArg = flags["--target-dir"] ?? process.cwd();
  const maxInputBytes = parseMaxInputBytesFlag(flags["--max-input-bytes"]);
  const heartbeatMs =
    parseNonNegativeIntegerFlag("--heartbeat-ms", flags["--heartbeat-ms"]) ?? DEFAULT_HEARTBEAT_MS;
  // Parsed once: the console's own page default and the manager it builds must
  // read the same limits, not two independent parses of the same flags.
  const configuredLimits = backgroundLimits(flags);
  const controlPageSize =
    parsePositiveIntegerFlag("--console-page-size", flags["--console-page-size"]) ??
    configuredLimits.maxPageSize;
  const escapeSequenceTimeoutMs = parsePositiveIntegerFlag(
    "--escape-sequence-timeout-ms",
    flags["--escape-sequence-timeout-ms"],
  );
  const sessionLimits = parseSessionLimits(flags);
  // No `--skills` means the CATALOGUE: each role is told which skills exist and
  // loads what the task needs. Passing `--skills` pins an exact set and pastes
  // it, for when the operator knows better than the model will.
  //
  // Briefly in between, this defaulted to "every id", which pinned everything
  // and pasted 2106 words into the orchestrator's prompt regardless of task.
  // Every user-facing command resolves skills through `buildConfigOptions`:
  // no `--skills` means the CATALOGUE (each role sees ids and one-line
  // descriptions and loads what the task needs with `load_skill`), passing it
  // pins an exact set and pastes it. Briefly in between, the console defaulted
  // to "every id", which pinned everything and pasted 2106 words into the
  // orchestrator's prompt regardless of task.
  const configOptions = buildConfigOptions(targetDirArg, flags);
  const selectedSkills = configOptions.selectedSkills ?? [];
  const authenticationProvider =
    configOptions.provider ??
    storedRouteProvider(configOptions.modelsConfigPath, configOptions.modelsProfile);
  const authenticationCommand =
    authenticationProvider === "openrouter" || authenticationProvider === "openai-codex"
      ? `ad-coder auth login --provider ${authenticationProvider} --target-dir ${shellArgument(path.resolve(targetDirArg))}`
      : undefined;
  // Without a launcher the console can admit a background run but never start
  // one: `start_pipeline` and `/start` both fail `launch_failed`. The owner id
  // is derived from the target directory rather than generated, so runs a
  // console starts stay addressable from the next console and from
  // `ad-coder background status` in the same project.
  const backgroundTargetDir = resolveTargetDir(targetDirArg);
  const backgroundOwnerId = flags["--owner-id"] ?? defaultBackgroundOwnerId(backgroundTargetDir);
  // --resume resolves BEFORE startOrchestrator so an unknown or malformed run
  // id fails typed and creates nothing: no session, no ledger file. The bare
  // form discovers the most recent orchestrator session (the verified
  // discriminator is in src/cli/resume.ts); both forms read the previous run's
  // ledger rows back so the restarted front's cost view is cumulative. The
  // per-row read bound is the same one the durable sink writes with.
  const resumeBare = booleans["--resume"] === true;
  const resumeValue = flags["--resume"];
  const resumed = resumeBare
    ? resolveResumeRun(
        backgroundTargetDir,
        { bare: true },
        configOptions.projectStoreConfig?.byteLimits?.jsonlRecord ?? 0,
      )
    : resumeValue === undefined
      ? undefined
      : resolveResumeRun(
          backgroundTargetDir,
          { bare: false, runId: resumeValue },
          configOptions.projectStoreConfig?.byteLimits?.jsonlRecord ?? 0,
        );
  // A row the seed could not replay must be heard before the first turn: the
  // restarted cost view starts without it.
  if (resumed !== undefined) {
    const note = resumeSeedNote(resumed);
    if (note !== undefined) process.stderr.write(note);
  }
  const session = await startOrchestrator({
    ...configOptions,
    // The whole resume contribution: the run id whose durable session
    // reopens, and the rows the restarted cost view replays. No flag spreads
    // nothing, so the default flow is untouched.
    ...resumeOrchestratorConfig(resumed),
    sessionLimits,
    workflowModules: [BUILT_IN_PIPELINE_WORKFLOW],
    enabledWorkflows: configOptions.selectedWorkflows ?? [],
    selectedSkills,
    backgroundOwnerId,
    backgroundHostLauncher: backgroundHostLauncherFor(
      targetDirArg,
      backgroundOwnerId,
      flags,
      configOptions,
    ),
    ...(Object.keys(configuredLimits).length === 0 ? {} : { backgroundRuns: configuredLimits }),
  });
  // Same line `role` and `drive` print: whichever front an operator reaches
  // for, stderr names the run and the file its evidence is in.
  process.stderr.write(
    `ad-coder: runId=${session.runId} ledger=${session.ledgerPath ?? "custom"}\n`,
  );
  const costAnomaly = (session as { costAnomalyDetector?: CostAnomalyDetector })
    .costAnomalyDetector;
  const result = await runConsole({
    session,
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    mode: json ? "json" : "formatted",
    ...(maxInputBytes !== undefined && { maxInputBytes }),
    heartbeatMs,
    ...(controlPageSize !== undefined && { controlPageSize }),
    ...(escapeSequenceTimeoutMs !== undefined && { escapeSequenceTimeoutMs }),
    ...(configOptions.toolActivity !== undefined && {
      toolActivity: configOptions.toolActivity,
    }),
    ...(authenticationCommand !== undefined && { authenticationCommand }),
    // The session's OWN detector, not a second one over the same file: a
    // `/cost release` has to lift the block that refuses this session's turns,
    // and a front-built copy would only release its own in-memory duplicate.
    ...(costAnomaly === undefined ? {} : { costAnomaly }),
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
  // Same admission policy every other entry point resolves: the workflow's
  // ctx.runRole is a provider call, so the operator's settings.yaml applies.
  const runRole =
    targetDir === undefined
      ? undefined
      : buildRunner(targetDir, loadOptionalSettingsConfig()?.providerAdmission);

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
    name: "--skills",
    value: "<names>",
    description:
      "Select comma-separated built-in or project-local skills; omit to ship the catalogue every role loads from.",
  },
  {
    name: "--workflows",
    value: "<names|false|^name>",
    description:
      // Set-valued switch, declared ONCE here for every pipeline front. Unset
      // keeps the built-in default (each shipped module ON); `false` turns the
      // capability off; a comma list selects exactly those; `^name` excludes.
      `Select comma-separated workflow modules (${BUILT_IN_WORKFLOW_NAMES.join(",")}); ` +
      "^name excludes from the built-in default; false disables them entirely; unset keeps all shipped modules enabled.",
  },
  /**
   * `--no-skills` is the explicit off, declared once for every pipeline-capable
   * command: no catalogue, no loader, no prompt appendix. It refuses to share a
   * command line with a selection -- exactly one of pin, off, or default.
   */
  {
    name: "--no-skills",
    description:
      "Disable skills entirely: no catalogue, no load_skill tool. Cannot be combined with --skills.",
  },
  {
    name: "--stage-final-response-reserve-input-tokens",
    value: "<n>",
    description: `Input tokens protected from further tool calls for stage closeout; defaults to ${DEFAULT_STAGE_LIMITS.finalResponseReserveInputTokens}, 0 disables.`,
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
    name: "--models-profile",
    value: "<name>",
    description:
      "Select one named profile from models.yaml (default: the document's own `default:`).",
  },
  {
    name: "--models-config",
    value: "<file.yaml>",
    description:
      "Overrides the models.yaml routing config path (defaults to ~/.config/ad-coder/models.yaml).",
  },
  {
    name: "--settings-config",
    value: "<file.yaml>",
    description:
      "Overrides the settings.yaml behaviour config path (defaults to ~/.config/ad-coder/settings.yaml).",
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
  // The numbers below are interpolated from DEFAULT_STAGE_LIMITS rather than typed, and each says
  // what passing the flag actually does to a role's own ceiling. Both halves are #405: the help
  // text stated defaults the code did not use -- the five stage ceilings (600000/32/128/500000/2
  // against 1800000/96/384/1500000/6) and, from the same raise, all four closeout reserves
  // (4/30000/8/100000 against 12/90000/24/300000) -- and it never mentioned that most roles carry a
  // LOWER ceiling of their own, so the only place a user could read these numbers printed wrong
  // ones. Interpolating is what keeps the next raise from leaving the text behind again.
  {
    name: "--stage-max-duration-ms",
    value: "<n>",
    description:
      `Cumulative whole-stage time across resumes; defaults to ${DEFAULT_STAGE_LIMITS.maxDurationMs} ` +
      "for roles without their own ceiling, 0 disables. A role's own ceiling is lower unless this " +
      "flag is passed, and passing it replaces EVERY role's, not just the one you are thinking of.",
  },
  {
    name: "--stage-max-model-turns",
    value: "<n>",
    description:
      `Cumulative model calls across stage resumes; defaults to ${DEFAULT_STAGE_LIMITS.maxModelTurns}, ` +
      "0 disables. Passing it replaces every role's own ceiling.",
  },
  {
    name: "--stage-max-tool-turns",
    value: "<n>",
    description:
      `Cumulative tool calls across stage resumes; defaults to ${DEFAULT_STAGE_LIMITS.maxToolTurns}, ` +
      "0 disables. Passing it replaces every role's own ceiling.",
  },
  {
    name: "--stage-max-input-tokens",
    value: "<n>",
    description:
      `Cumulative provider-reported input across resumes; defaults to ${DEFAULT_STAGE_LIMITS.maxInputTokens}, ` +
      "0 disables. Passing it replaces every role's own ceiling.",
  },
  {
    name: "--stage-max-cost-usd",
    value: "<n>",
    description:
      `Cumulative provider-reported stage cost across resumes; defaults to ${DEFAULT_STAGE_LIMITS.maxCostUsd}, ` +
      "0 disables. Passing it replaces every role's own ceiling, and every role's own cost ceiling " +
      "is BELOW this default, so the flag raises cost for all of them at once — one role cannot be " +
      "raised alone.",
  },
  {
    name: "--stage-final-response-reserve-tool-turns",
    value: "<n>",
    description: `Tool turns protected for stage closeout; defaults to ${DEFAULT_STAGE_LIMITS.finalResponseReserveToolTurns}, 0 disables.`,
  },
  {
    name: "--stage-final-response-reserve-duration-ms",
    value: "<n>",
    description: `Milliseconds protected from further tool calls for stage closeout; defaults to ${DEFAULT_STAGE_LIMITS.finalResponseReserveDurationMs}, 0 disables.`,
  },
  {
    name: "--stage-final-response-reserve-model-turns",
    value: "<n>",
    description: `Model turns protected from further tool calls for stage closeout; defaults to ${DEFAULT_STAGE_LIMITS.finalResponseReserveModelTurns}, 0 disables.`,
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
    name: "--planner-handoff-attempts",
    value: "<1|2>",
    description:
      "Allow one initial Planner handoff attempt or one bounded corrective retry (default: 2).",
  },
  {
    name: "--project-store-config",
    value: "<file.json>",
    description: "Load ProjectStore retention and byte limits; numeric 0 disables a limit.",
  },
];

/**
 * Owner scope and admission limits for background pipeline runs. Shared by
 * `background` and `console`: both construct a `BackgroundRunManager`, so a
 * flag one accepts and the other silently ignores would be exactly the drift
 * the single command registry exists to prevent (`docs/contracts/cli.md`).
 */
const BACKGROUND_RUN_OPTIONS: CommandDefinition["options"] = [
  {
    name: "--owner-id",
    value: "<id>",
    description: "Stable private owner scope for reconnect; defaults to this user and target.",
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
  {
    name: "--background-max-wake-entries",
    value: "<n>",
    description: "Maximum coalesced wake windows retained per run.",
  },
  {
    name: "--background-max-wakes-per-turn",
    value: "<n>",
    description: "Maximum unhandled wake windows one orchestrator turn drains.",
  },
];

/**
 * The `session-manager` front (issue #365 layer 2): THIN by contract
 * (docs/contracts/session-manager.md front-capability parity). It resolves the
 * operator's allowed roots and creation volume, then either starts the
 * owner-private Unix-socket server (the transport's trust boundary lives in
 * src/session-manager/server.ts, never here) or prints the managed-session
 * list as machine JSON. No session logic lives in this front.
 */
async function runSessionManagerCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
  json: boolean,
): Promise<void> {
  const action = positionals[1];
  if ((action !== "serve" && action !== "list") || positionals[2] !== undefined)
    fail("session-manager requires exactly one action: serve or list");
  const settings = loadOptionalSettingsConfig()?.sessionManager;
  const configuredRoots = settings?.allowedRoots ?? [];
  let roots: string[] = configuredRoots;
  if (flags["--allowed-roots"] !== undefined) {
    roots = flags["--allowed-roots"].split(",").map((entry) => entry.trim());
    if (roots.some((entry) => entry.length === 0 || !entry.startsWith("/")))
      fail("--allowed-roots must be a comma list of absolute directory paths");
  }
  const maxProjects = parseNonNegativeIntegerFlag("--max-projects", flags["--max-projects"]);
  const options = {
    roots,
    ...(flags["--state-dir"] !== undefined && { stateDir: path.resolve(flags["--state-dir"]) }),
    ...(maxProjects !== undefined && { maxProjects }),
  };
  if (action === "list") {
    const manager = new SessionManager(options);
    const rows = await manager.listSessions();
    if (json || process.stdout.isTTY !== true) process.stdout.write(`${JSON.stringify(rows)}\n`);
    else
      for (const row of rows)
        process.stdout.write(
          `${row.projectKey.padEnd(24)} ${row.sessionId.padEnd(28)} ${row.leaseState.padEnd(10)} ${row.name}\n`,
        );
    return;
  }
  const manager = new SessionManager(options);
  const server = new SessionManagerServer({
    socketDir:
      flags["--socket-dir"] !== undefined
        ? path.resolve(flags["--socket-dir"])
        : path.join(manager.stateDir, "socket"),
    ...(flags["--socket-name"] !== undefined && { socketName: flags["--socket-name"] }),
    manager,
  });
  const socketPath = await server.listen();
  process.stdout.write(
    `${JSON.stringify(json ? server.info() : { ...server.info(), serving: true })}\n`,
  );
  if (!json)
    for (const line of [
      `session-manager serving on ${socketPath}`,
      "owner-private socket; same-uid fronts only; stop with SIGINT/SIGTERM",
    ])
      process.stderr.write(`${line}\n`);
  process.once("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
  await new Promise<void>(() => {});
}

/**
 * The `session-manager` front (issue #365 layer 2): THIN by contract
 * (docs/contracts/session-manager.md front-capability parity). It resolves the
 * operator's allowed roots and creation volume, then either starts the
 * owner-private Unix-socket server (the transport's trust boundary lives in
 * src/session-manager/server.ts, never here) or prints the managed-session
 * list as machine JSON. No session logic lives in this front.
 */
async function runSessionManagerCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
  json: boolean,
): Promise<void> {
  const action = positionals[1];
  if ((action !== "serve" && action !== "list") || positionals[2] !== undefined)
    fail("session-manager requires exactly one action: serve or list");
  const settings = loadOptionalSettingsConfig()?.sessionManager;
  const configuredRoots = settings?.allowedRoots ?? [];
  let roots: string[] = configuredRoots;
  if (flags["--allowed-roots"] !== undefined) {
    roots = flags["--allowed-roots"].split(",").map((entry) => entry.trim());
    if (roots.some((entry) => entry.length === 0 || !entry.startsWith("/")))
      fail("--allowed-roots must be a comma list of absolute directory paths");
  }
  const maxProjects = parseNonNegativeIntegerFlag("--max-projects", flags["--max-projects"]);
  const options = {
    roots,
    ...(flags["--state-dir"] !== undefined && { stateDir: path.resolve(flags["--state-dir"]) }),
    ...(maxProjects !== undefined && { maxProjects }),
  };
  if (action === "list") {
    const manager = new SessionManager(options);
    const rows = await manager.listSessions();
    if (json || process.stdout.isTTY !== true) process.stdout.write(`${JSON.stringify(rows)}\n`);
    else
      for (const row of rows)
        process.stdout.write(
          `${row.projectKey.padEnd(24)} ${row.sessionId.padEnd(28)} ${row.leaseState.padEnd(10)} ${row.name}\n`,
        );
    return;
  }
  const manager = new SessionManager(options);
  const server = new SessionManagerServer({
    socketDir:
      flags["--socket-dir"] !== undefined
        ? path.resolve(flags["--socket-dir"])
        : path.join(manager.stateDir, "socket"),
    ...(flags["--socket-name"] !== undefined && { socketName: flags["--socket-name"] }),
    manager,
  });
  const socketPath = await server.listen();
  process.stdout.write(
    `${JSON.stringify(json ? server.info() : { ...server.info(), serving: true })}\n`,
  );
  if (!json)
    for (const line of [
      `session-manager serving on ${socketPath}`,
      "owner-private socket; same-uid fronts only; stop with SIGINT/SIGTERM",
    ])
      process.stderr.write(`${line}\n`);
  process.once("SIGINT", () => {
    server.close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
  await new Promise<void>(() => {});
}

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
          : `${info.name} ${info.version}\nrevision: ${info.revision ?? "unknown"}\nlinked development: ${info.linkedDevelopment ? "yes" : "no"}\n`,
      );
      await Promise.resolve();
    },
  },
  {
    name: "update",
    description: "Update the global install (npm or GitHub) or a linked Git checkout.",
    positionals: [],
    options: [{ name: "--json", description: "Emit a stable JSON result." }],
    run: async ({ positionals, booleans }) => {
      if (positionals[1] !== undefined) fail("the update command accepts no positional arguments");
      const result = await updateAdCoder({
        checkoutDir: path.resolve(import.meta.dir, ".."),
        run: async (argv, cwd) => {
          const child = spawnSync(argv[0] as string, argv.slice(1), {
            cwd,
            encoding: "utf8",
            maxBuffer: 64 * 1024,
          });
          return {
            exitCode: child.status ?? 1,
            stdout: child.stdout ?? "",
            stderr: child.stderr ?? child.error?.message ?? "",
          };
        },
        onStep: (step) => {
          if (booleans["--json"] !== true) process.stderr.write(`ad-coder: update ${step}\n`);
        },
      });
      process.stdout.write(
        booleans["--json"] === true
          ? `${JSON.stringify(result)}\n`
          : `${formatUpdateResult(result)}\n`,
      );
    },
  },
  {
    name: "auth",
    description: "Manage persistent provider authentication.",
    positionals: [{ name: "<status|login|logout>", description: "Authentication action." }],
    options: [
      {
        name: "--provider",
        value: "<provider-id>",
        description:
          "Select the authentication provider (openai-codex, openrouter, or a declared env-var provider); defaults to openai-codex.",
      },
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
      const provider = flags["--provider"];
      // A non-built-in `--provider` id must name a DECLARED env-var provider from
      // the same source routing uses (models.yaml). The error names the IDs only,
      // never a credential value, and never the operator's config path.
      if (provider !== undefined && provider !== "openai-codex" && provider !== "openrouter") {
        const declared = declaredEnvProviderIds();
        if (!declared.includes(provider)) {
          fail(
            `--provider must be openai-codex, openrouter${declared.length > 0 ? `, or a declared env-var provider (${declared.join(", ")})` : ""}`,
          );
        }
      }
      if (provider !== undefined && provider !== "openai-codex" && method !== undefined)
        fail("--method is only valid for openai-codex");
      await runAuthCommand({
        action,
        ...(flags["--credential-path"] !== undefined && {
          credentialPath: flags["--credential-path"],
        }),
        targetDir: resolveTargetDir(flags["--target-dir"] ?? process.cwd()),
        json: booleans["--json"] === true,
        ...(provider !== undefined && { provider }),
        ...(method !== undefined && { method }),
        modelsConfigPath: defaultModelsPath(),
      });
    },
  },
  {
    name: "config",
    description: "Show effective secret-free configuration.",
    positionals: [
      {
        name: "<show>",
        description:
          "show: resolved configuration. (`migrate` was removed with the JSON inventory route, issue #513.)",
      },
    ],
    options: [
      ...PIPELINE_OPTIONS.map((option) =>
        option.name === "--target-dir" ? { ...option, required: false } : option,
      ),
      { name: "--json", description: "Emit stable JSON." },
    ],
    run: async ({ positionals, flags, booleans }) => {
      const action = positionals[1];
      if (action !== "show" || positionals[2] !== undefined)
        fail("config requires exactly one action: show");
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
          process.stdout.write(`${renderConfigShowRow(name, entry.value, entry.source)}\n`);
      }
      await Promise.resolve();
    },
  },
  {
    name: "cost",
    description: "Show scopes blocked by a cost spike, or accept a model's new price.",
    positionals: [
      { name: "<status|release>", description: "Cost-anomaly action." },
      { name: "[provider/model]", description: "Scope to release." },
    ],
    options: [
      {
        name: "--target-dir",
        value: "<dir>",
        description: "Project whose state is read; defaults to the current directory.",
      },
      { name: "--json", description: "Accepted for machine-mode parity; output is always JSON." },
    ],
    run: ({ positionals, flags }) => {
      costCommand(positionals, flags);
      return Promise.resolve();
    },
  },
  {
    name: "ledger",
    description: "Report how runs behaved -- calls, tokens, cost, tools -- from ledger files.",
    positionals: [
      { name: "<report>", description: "Report action." },
      {
        name: "[files...]",
        description: "Ledger .jsonl paths; with none, every .ad-coder/ledger/*.jsonl is read.",
      },
    ],
    options: [{ name: "--json", description: "Emit stable JSON." }],
    run: ({ positionals, booleans }) => {
      ledgerCommand(positionals, booleans["--json"] === true);
      return Promise.resolve();
    },
  },
  {
    name: "stamp",
    description:
      "Delivery paperwork: the ledger-derived signature, and the review-stamp gate check.",
    positionals: [
      {
        name: "<delivery|check|body-check>",
        description:
          "delivery renders the PR block; check is the gate; body-check gates the PR body.",
      },
      {
        name: "[files...]",
        description:
          "Ledger .jsonl paths for delivery; with none, every .ad-coder/ledger/*.jsonl is read. For body-check, the FIRST positional is the pull-request body file, the rest are ledger paths.",
      },
    ],
    options: [
      {
        name: "--json",
        description: "Emit a stable JSON error shape; accepted for machine front.",
      },
      {
        name: "--target-dir",
        value: "<dir>",
        description: "Project read; defaults to the current directory.",
      },
    ],
    run: ({ positionals, flags }) => {
      stampCommand(positionals, flags);
      return Promise.resolve();
    },
  },
  {
    name: "profile",
    description:
      "Show, record economics, estimate cost, export, snapshot, preview, or import the portable user profile.",
    positionals: [
      {
        name: "<show|export|snapshot|record|estimate|import-preview|import-apply>",
        description: "Profile action.",
      },
    ],
    options: [
      {
        name: "--input",
        value: "<file|->",
        description: "Read an import document or one economic record for profile record.",
      },
      { name: "--target-dir", value: "<dir>", description: "Project receiving a snapshot." },
      {
        // Declared, and only so the refusal can be TYPED: the option table is
        // also the parse table, so a flag deleted from here stops reaching the
        // handler and comes back as a bare "unknown option: --inventory" --
        // which names no replacement (issue #513). The description carries the
        // retirement instead of pretending the flag still takes a source.
        name: "--inventory",
        value: "<name>",
        description:
          "Retired (issue #513): a JSON inventory is not a routing source. Use --models-profile.",
      },
      {
        name: "--models-profile",
        value: "<name>",
        description: "Profile in models.yaml to snapshot (the only routing source).",
      },
      {
        name: "--models-config",
        value: "<path>",
        description: "models.yaml to read for --models-profile (default: the standard path).",
      },
      {
        name: "--evidence",
        value: "<jsonl>",
        description: "Calibration evidence for profile estimate.",
      },
      {
        name: "--complexity",
        value: "<trivial|medium|complex>",
        description: "Task complexity for profile estimate.",
      },
      {
        name: "--provider",
        value: "<id>",
        description: "Provider balance scope for profile estimate.",
      },
      {
        name: "--credits-per-usd",
        value: "<n>",
        description: "Optional explicit credit conversion for profile estimate.",
      },
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
      ...BACKGROUND_RUN_OPTIONS,
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
        // Derived, not spelled out: a hand-written list drifts from ROLE_NAMES
        // silently, which is how `orchestrator` came to be absent here while
        // every inventory profile declared it (issue #306).
        name: `<${ROLE_NAMES.join("|")}>`,
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
    run: ({ positionals, flags }) => {
      // Validate the role name BEFORE announcing a start: the progress wrapper
      // prints "started role X; waiting for provider" immediately, so a bad name
      // produced a success line followed by a failure, and anything reading the
      // first line -- a person glancing at output, a log tail, a wrapper script
      // -- saw a run that had begun (issue #306).
      assertKnownRole(positionals[1]);
      return withCliProgress(
        `role ${positionals[1] ?? "unknown"}`,
        parseNonNegativeIntegerFlag("--heartbeat-ms", flags["--heartbeat-ms"]) ??
          DEFAULT_HEARTBEAT_MS,
        () => roleCommand(positionals, flags),
      );
    },
  },
  {
    name: "runs",
    description: "Stop one run by the process identity its own record carries.",
    positionals: [
      { name: "<stop>", description: "Action: stop." },
      {
        name: "<run-id>",
        description: "Run identifier; its record lives under <target>/.ad-coder/runs/.",
      },
    ],
    options: [
      {
        name: "--target-dir",
        value: "<dir>",
        description:
          "Directory whose run record names the run; spelled as the run was started, the token the run's own command line must carry.",
        required: true,
      },
      {
        name: "--json",
        description:
          "Emit a stable JSON result; refusals emit the structured error shape with every check.",
      },
      {
        name: "--kill",
        description: "After the bounded wait, SIGKILL a run still alive past SIGTERM.",
      },
      {
        name: "--kill-after-ms",
        value: "<n>",
        description: `SIGTERM-to-escalation wait in ms (default ${DEFAULT_KILL_AFTER_MS}); requires --kill.`,
      },
      {
        name: "--group",
        description:
          "Signal the run's process group; refused unless the record proves the run leads that group.",
      },
    ],
    notes: [
      "Exit codes:",
      "  0  a signal was delivered to the verified pid (escalated when --kill was set)",
      "  1  the positively identified recorded pid is already dead; nothing was signalled",
      "  2  usage error (unknown action, missing run id, missing --target-dir, invalid flag value)",
      "  3  refusal: no record establishes this run id, or the record's identity does not positively tie its pid",
      "     to this run and target -- no recorded pid, unreadable identity, wrong target directory, wrong run, or a start time that",
      "     suggests pid reuse; every check is printed and NOTHING is signalled",
    ],
    run: ({ positionals, flags, booleans }) => {
      const action = positionals[1];
      if (action === undefined) fail("runs requires an action: stop");
      if (action !== "stop") fail(`unknown runs action: ${action} (only stop exists)`);
      const runId = positionals[2];
      if (runId === undefined) fail("runs stop requires a run id");
      if (positionals[3] !== undefined) fail("runs stop accepts exactly one run id");
      try {
        assertRunId(runId);
      } catch (error) {
        fail(errorMessage(error));
      }
      const targetArg = flags["--target-dir"];
      if (targetArg === undefined) fail("--target-dir is required for runs stop");
      const kill = booleans["--kill"] === true;
      const killAfterMs =
        parseNonNegativeIntegerFlag("--kill-after-ms", flags["--kill-after-ms"]) ??
        DEFAULT_KILL_AFTER_MS;
      if (flags["--kill-after-ms"] !== undefined && !kill)
        fail("--kill-after-ms is only meaningful with --kill");
      return runsStopCommand({
        runId,
        // The RAW spelling the operator passed, not a resolved form: a run's
        // own command line carries the spelling its starter typed, and the
        // identity check compares exact argv tokens (src/cli/runs-stop.ts).
        targetDir: targetArg,
        json: booleans["--json"] === true,
        kill,
        group: booleans["--group"] === true,
        killAfterMs,
      });
    },
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
        name: "--max-input-bytes",
        value: "<n>",
        description: "Set the maximum bytes accepted in one input line.",
      },
      {
        name: "--resume",
        value: "[<run-id>]",
        optional: true,
        description:
          "Continue a previous orchestrator session: name its run id, or omit the id to resume the most recent one.",
      },
      {
        name: "--console-page-size",
        value: "<n>",
        description: "Maximum background records shown by each console-local command.",
      },
      ...BACKGROUND_RUN_OPTIONS,
      {
        name: "--escape-sequence-timeout-ms",
        value: "<n>",
        description: "Wait this long before treating an ambiguous Escape as an interrupt.",
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
      consoleCommand(positionals, flags, booleans, booleans["--json"] === true),
  },
  {
    name: "session-manager",
    description:
      "Serve the headless SessionManager on its owner-private socket, or list managed sessions.",
    positionals: [
      {
        name: "<serve|list>",
        description:
          "serve: listen on the owner-private Unix socket until stopped. list: managed sessions and their lease state.",
      },
    ],
    options: [
      {
        name: "--allowed-roots",
        value: "<comma-list>",
        description:
          "Absolute allowed-root directories; falls back to settings.yaml session-manager.allowed-roots.",
      },
      {
        name: "--state-dir",
        value: "<dir>",
        description: "Owner-private state directory override (default under XDG state).",
      },
      {
        name: "--socket-dir",
        value: "<dir>",
        description: "serve: the socket directory; defaults inside the state directory.",
      },
      {
        name: "--socket-name",
        value: "<name>",
        description: "serve: the socket file name (default manager.sock).",
      },
      {
        name: "--max-projects",
        value: "<n>",
        description: "Safe project-creation volume cap; 0 disables creation.",
      },
      { name: "--json", description: "Emit stable JSON." },
    ],
    run: async ({ positionals, flags, booleans }) => {
      await runSessionManagerCommand(positionals, flags, booleans["--json"] === true);
    },
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
  return [usage, ...positionals, ...options, ...(command.notes ?? [])].join("\n");
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    process.stdout.write(`${renderRootHelp()}\n`);
    return;
  }
  const commandName = argv[0];
  const passedJsonFlag = argv.slice(1).includes("--json");
  consoleJsonFront = commandName === "console" && passedJsonFlag;
  machineJsonFront =
    consoleJsonFront ||
    // Always JSON, with or without the flag.
    commandName === "operations" ||
    commandName === "control" ||
    commandName === "background" ||
    commandName === "profile" ||
    // JSON only when asked for it.
    ((commandName === "update" ||
      commandName === "cost" ||
      commandName === "ledger" ||
      commandName === "stamp" ||
      commandName === "runs") &&
      passedJsonFlag);
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

/**
 * Project a failed CLI invocation into the record a machine front reads.
 * Exported so the shape is testable as public behavior rather than only through
 * a process spawn (`docs/contracts/errors.md`, `docs/contracts/architecture.md`).
 */
export function projectCliError(error: unknown): Record<string, unknown> {
  if (error instanceof UpdateError)
    return {
      code: error.code,
      detail: error.detail,
      text: error.message,
      retryable: error.retryable,
      ...(error.nextAction === undefined ? {} : { nextAction: error.nextAction }),
    };
  if (error instanceof SkillResolutionError)
    return {
      code: `skill_${error.code}`,
      text: error.message,
      retryable: false,
      nextAction: error.nextAction,
    };
  if (error instanceof QueueSaturatedError)
    return {
      code: error.code,
      text: error.message,
      retryable: error.retryable,
      nextAction: error.nextAction,
    };
  if (error instanceof AdmissionCancelledError)
    return {
      code: error.code,
      text: error.message,
      retryable: error.retryable,
      nextAction: error.nextAction,
    };
  if (error instanceof UserProfileError) return { code: error.code, detail: error.detail };
  // A conversation whose durable session could not be seated (issue #428). The
  // class message and action are AUTHORED constants (src/conversation/
  // conversation.ts), and `runId` is a validated file-name-safe token, so all
  // three fields are fixed text that carries no request, prompt, or provider
  // payload across the front boundary.
  if (error instanceof SessionNotAcquiredError)
    return {
      code: error.code,
      detail: error.runId,
      text: error.message,
      retryable: false,
      nextAction: SessionNotAcquiredError.NEXT_ACTION,
    };
  if (error instanceof ProjectOperationsError) return { code: error.code, detail: error.detail };
  if (error instanceof ProjectStoreError) return { code: error.code, detail: error.path };
  if (error instanceof BackgroundRunError) return { code: error.code, detail: error.detail };
  return { code: "internal_error" };
}

/** Render a failed CLI invocation as the human line, including its recovery action. */
export function renderCliError(error: unknown): string {
  const action =
    error instanceof UpdateError
      ? error.nextAction
      : error instanceof QueueSaturatedError || error instanceof AdmissionCancelledError
        ? error.nextAction
        : error instanceof SessionNotAcquiredError
          ? SessionNotAcquiredError.NEXT_ACTION
          : undefined;
  return `ad-coder: ${errorMessage(error)}${action === undefined ? "" : `; ${action}`}\n`;
}

/**
 * The failure line the ENTRY POINT's catch writes to stderr, pauses included
 * exactly once (issue #501).
 *
 * A thrown `PipelinePauseError` must not fall through to the generic `code:
 * action` message: the pause may already have been announced by the renderer
 * that drove the run (the drive loop's result path) or by the console's notice
 * renderer, so this projection asks the same keyed memo (`announcePauseOnce`)
 * FIRST. When the occurrence was already announced it returns `undefined` and
 * the catch writes NOTHING -- a second human pause line reads as a new decision
 * where the operator already made one. When it wins the memo, it writes the
 * pause line in the same shape the other renderers use: phase, code, the limit
 * clause, the action in words, resumable not failed -- plus the runId the
 * error itself carries. `PipelinePauseError` carries neither a checkpoint path
 * nor a resume command, so the line stops at that runId. Any other error falls
 * through to `renderCliError` unchanged. Returns `undefined` only for an
 * already-announced pause, which the caller must render as pure silence.
 */
export function renderCliFailureLine(error: unknown): string | undefined {
  if (error instanceof PipelinePauseError) {
    // ONE announcement per pause occurrence (issue #501): the drive result
    // path and the console's notice renderer ask this same keyed memo, so the
    // first renderer of the occurrence wins and this one stays silent.
    if (
      !announcePauseOnce(pauseAnnouncementKey(error.detail, error.pause.phase, error.pause.code))
    ) {
      return undefined;
    }
    // The limit clause is byte-for-byte the drive result path's shape
    // (src/cli/drive.ts): `, limit <reason> (<n>)`, `, limit <reason>`,
    // `, limit (<n>)`, or nothing.
    const limit =
      error.pause.limitReason !== undefined
        ? `, limit ${error.pause.limitReason}${
            error.pause.limit === undefined ? "" : ` (${error.pause.limit})`
          }`
        : error.pause.limit === undefined
          ? ""
          : `, limit (${error.pause.limit})`;
    return (
      `ad-coder: pipeline paused (${error.pause.phase}): ${error.pause.code}${limit} -- ` +
      `${error.pause.action} -- the run is resumable, not failed; runId=${error.detail}\n`
    );
  }
  return renderCliError(error);
}

// Only run when invoked as the entry point, so importing this module for tests
// (e.g. to exercise runRoleStandalone) does not fire the CLI dispatch.
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    if (machineJsonFront)
      process.stderr.write(`${JSON.stringify({ error: projectCliError(error) })}\n`);
    else {
      // The entry point's projection (issue #501): an already-announced pause
      // writes NOTHING -- the renderer that won the memo printed the full
      // line -- and any other failure writes its one human line.
      const line = renderCliFailureLine(error);
      if (line !== undefined) process.stderr.write(line);
    }
    process.exit(1);
  } finally {
    closeOpenAICodexWebSocketSessions();
  }
}
