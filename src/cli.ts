#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Session, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { assertCredentialPathOutsideProject, FileCredentialStore } from "./auth/credential-store";
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
import type { CompactionPolicy } from "./context/compactor";
import { Ledger, MemoryLedgerSink } from "./ledger/ledger";
import {
  createOrchestratorControlPlane,
  type DecisionRequest,
  type StartRunInput,
  triageControlPlaneTask,
} from "./orchestration/control-plane";
import { startOrchestrator } from "./orchestration/orchestrator";
import { runPipeline } from "./orchestration/pipeline";
import { createWorkflowSession } from "./orchestration/session";
import type { Complexity, PipelineConfig, RoleSpec } from "./orchestration/types";
import { parseProfile } from "./profiles/validate";
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
import { ProjectStore } from "./project-store/project-store";
import type { ProjectStoreConfig } from "./project-store/types";
import { ProjectStoreError } from "./project-store/types";
import { parseRegistryConfig } from "./registry/validate";
import type { Role } from "./role";
import { defineRole } from "./role";
import { resolveTargetDir } from "./runner/errors";
import { createRoleRunner } from "./runner/role-runner";
import type { SessionLimits } from "./session-limits";
import { SessionLimitController } from "./session-limits";
import type { WorkflowContext } from "./workflow";
import { isWorkflowModule } from "./workflow";

const ROLE_NAMES = ["planner", "coder", "reviewer", "security"] as const;
type RoleName = (typeof ROLE_NAMES)[number];
const PROVIDERS = ["deepseek", "openrouter", "openai-codex"] as const;
const COMPLEXITIES = ["trivial", "medium", "complex"] as const;
let operationsJsonFront = false;

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
function warnCwdInsideTarget(absTargetDir: string): void {
  const cwd = process.cwd();
  if (cwd === absTargetDir || cwd.startsWith(absTargetDir + path.sep)) {
    process.stderr.write(
      `ad-coder: warning: the process cwd is inside --target-dir (${absTargetDir}); ` +
        `a .env there was auto-loaded into the environment and may supply the target's credentials\n`,
    );
  }
}

/**
 * Build the RoleRunner a `--target-dir` run exposes as `ctx.runRole`.
 *
 * Credentials come from `builtinModels()` -- the CLI's OWN process
 * environment -- never from `<targetDir>/.env`.
 */
function buildRunner(targetDirArg: string): WorkflowContext["runRole"] {
  const absTargetDir = resolveTargetDir(targetDirArg);
  warnCwdInsideTarget(absTargetDir);
  return createRoleRunner({ targetDir: absTargetDir, models: builtinModels() });
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
  ledgerSink: MemoryLedgerSink;
  compaction?: CompactionPolicy;
  projectStoreConfig?: ProjectStoreConfig;
}): Promise<{ text: string; cost: number }> {
  const runId = crypto.randomUUID();
  const store = new ProjectStore(params.targetDir, params.projectStoreConfig);
  const session = await store.createSession(runId, BACKGROUND_CONTEXT);
  await createRoleRunner({
    targetDir: params.targetDir,
    models: params.models,
    ...(params.compaction !== undefined && { compaction: params.compaction }),
    ...(params.projectStoreConfig !== undefined && {
      projectStoreConfig: params.projectStoreConfig,
    }),
  }).runRole(params.role, params.model, params.task, {
    runId,
    session,
    ledgerSink: params.ledgerSink,
  });
  // runRole closes the session facade it was handed; reopen a fresh readable
  // facade from the durable store to scan the settled transcript.
  const readable = await store.resumeSession(runId, BACKGROUND_CONTEXT);
  let text: string;
  try {
    text = await extractFinalText(readable, BACKGROUND_CONTEXT);
  } finally {
    await readable.close(BACKGROUND_CONTEXT);
  }
  let cost = 0;
  for (const record of params.ledgerSink.records()) {
    cost += record.usage.cost.total;
  }
  return { text, cost };
}

/** The resolved RoleSpec for a validated role name (all four are always present here). */
function roleSpecFor(config: PipelineConfig, name: RoleName): RoleSpec {
  const spec =
    name === "planner"
      ? config.roles.planner
      : name === "security"
        ? config.roles.security
        : name === "coder"
          ? config.roles.coder
          : config.roles.reviewer;
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
      ] as const) {
        const setting = controlObject[key];
        if (setting !== undefined && (!Number.isSafeInteger(setting) || (setting as number) < 0))
          fail(`invalid --project-store-config setting: projectOperations.controlPlane.${key}`);
      }
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
            checkpointPath: path.join(store.layout.runs, `control-${record.id}.json`),
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

function buildConfigOptions(
  targetDirArg: string,
  flags: Record<string, string | undefined>,
): Omit<ResolvePipelineConfigOptions, "task"> {
  const provider = parseProviderFlag(flags["--provider"]);
  const maxRounds = parseMaxRoundsFlag(flags["--max-rounds"]);
  const defaultComplexity = parseComplexityFlag(flags["--default-complexity"]);
  const orchestratorThinkingLevel = parseThinkingLevelFlag(flags["--orchestrator-thinking-level"]);
  const targetDir = resolveTargetDir(targetDirArg);
  const projectStoreConfig = parseProjectStoreConfig(flags["--project-store-config"]);
  const registryConfig =
    flags["--registry-config"] === undefined
      ? undefined
      : parseRegistryConfig(readJsonConfig(flags["--registry-config"], "--registry-config"));
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
  const crossProvider = flags["--allow-cross-provider-summarization"];
  if (crossProvider !== undefined && crossProvider !== "true" && crossProvider !== "false") {
    fail("--allow-cross-provider-summarization expects true or false");
  }
  let roleBudgetPercents: Partial<Record<ConfigurableRole, BudgetPercents>> | undefined;
  if (flags["--role-budget-percents"] !== undefined) {
    const raw = readJsonConfig(flags["--role-budget-percents"], "--role-budget-percents");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      fail("--role-budget-percents must contain a JSON object");
    roleBudgetPercents = raw as Partial<Record<ConfigurableRole, BudgetPercents>>;
  }
  warnCwdInsideTarget(targetDir);
  const credentialPath = flags["--credential-path"];
  if (credentialPath !== undefined) assertCredentialPathOutsideProject(credentialPath, targetDir);
  return {
    targetDir,
    env: (name: string) => process.env[name],
    ...(credentialPath !== undefined && {
      credentials: new FileCredentialStore({ path: credentialPath }),
    }),
    ...(provider !== undefined && { provider }),
    ...(flags["--strong-model"] !== undefined && { strongModel: flags["--strong-model"] }),
    ...(flags["--mid-model"] !== undefined && { midModel: flags["--mid-model"] }),
    ...(flags["--cheap-model"] !== undefined && { cheapModel: flags["--cheap-model"] }),
    ...(registryConfig !== undefined && { registryConfig }),
    ...(profile !== undefined && { profile }),
    ...(flags["--planner-model"] !== undefined && { plannerModel: flags["--planner-model"] }),
    ...(flags["--security-model"] !== undefined && { securityModel: flags["--security-model"] }),
    ...(flags["--coder-model"] !== undefined && { coderModel: flags["--coder-model"] }),
    ...(flags["--reviewer-model"] !== undefined && { reviewerModel: flags["--reviewer-model"] }),
    ...(flags["--orchestrator-model"] !== undefined && {
      orchestratorModel: flags["--orchestrator-model"],
    }),
    ...(orchestratorThinkingLevel !== undefined && { orchestratorThinkingLevel }),
    ...(flags["--summarizer-model"] !== undefined && {
      summarizerModel: flags["--summarizer-model"],
    }),
    ...(compactionMode !== undefined && { compactionMode }),
    ...(crossProvider !== undefined && {
      allowCrossProviderSummarization: crossProvider === "true",
    }),
    ...(Object.keys(budgetPercents).length > 0 && { budgetPercents }),
    ...(roleBudgetPercents !== undefined && { roleBudgetPercents }),
    ...(maxRounds !== undefined && { maxRounds }),
    ...(defaultComplexity !== undefined && { defaultComplexity }),
    ...(projectStoreConfig !== undefined && { projectStoreConfig }),
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
  const ledgerSink = new MemoryLedgerSink();
  const standaloneRole = defineRole(
    {
      ...spec.role,
      systemPrompt: `${spec.role.systemPrompt}\n\nThis is a standalone role invocation. Return the complete result as assistant text; structured pipeline submission tools are unavailable.`,
      activeToolNames: (spec.role.activeToolNames ?? []).filter((tool) =>
        ["bash", "read", "write", "edit"].includes(tool),
      ),
    },
    spec.model,
  );
  const { text, cost } = await runRoleStandalone({
    role: standaloneRole,
    model: spec.model,
    models: config.models,
    targetDir: configOptions.targetDir,
    task,
    ledgerSink,
    ...(config.compaction !== undefined && { compaction: config.compaction }),
    ...(config.projectStoreConfig !== undefined && {
      projectStoreConfig: config.projectStoreConfig,
    }),
  });

  // The extracted assistant text IS this subcommand's result value, so it is
  // the one thing that reaches stdout (never the raw OperationResultRecord).
  process.stdout.write(`${text}\n`);
  process.stdout.write(`cost: $${cost.toFixed(8)}\n`);
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
): Promise<void> {
  const task = positionals[1];
  if (task === undefined) fail("missing <task>");
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
  const session = createWorkflowSession(config);
  await driveWorkflow({
    session,
    ledgerSink,
    auto,
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
  });
}

async function consoleCommand(
  positionals: string[],
  flags: Record<string, string | undefined>,
  json: boolean,
): Promise<void> {
  if (positionals[1] !== undefined) fail("the console command accepts no positional arguments");
  const targetDirArg = flags["--target-dir"];
  if (targetDirArg === undefined) fail("--target-dir is required for the console command");
  const maxInputBytes = parseMaxInputBytesFlag(flags["--max-input-bytes"]);
  const sessionLimits = parseSessionLimits(flags);
  const session = await startOrchestrator({
    ...buildConfigOptions(targetDirArg, flags),
    sessionLimits,
  });
  await runConsole({
    session,
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    mode: json ? "json" : "formatted",
    ...(maxInputBytes !== undefined && { maxInputBytes }),
  });
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
    name: "--profile-config",
    value: "<file.json>",
    description: "Load complexity routing as data-only JSON.",
  },
  { name: "--planner-model", value: "<name>", description: "Override the planner model." },
  { name: "--security-model", value: "<name>", description: "Override the security model." },
  { name: "--coder-model", value: "<name>", description: "Override the coder model." },
  { name: "--reviewer-model", value: "<name>", description: "Override the reviewer model." },
  {
    name: "--orchestrator-model",
    value: "<name>",
    description: "Override the conversational orchestrator model.",
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
    description: "Run one pipeline role once.",
    positionals: [
      { name: "<planner|coder|reviewer|security>", description: "Role to run." },
      { name: "<task>", description: "Task for the role." },
    ],
    options: PIPELINE_OPTIONS,
    run: ({ positionals, flags }) => roleCommand(positionals, flags),
  },
  {
    name: "drive",
    description: "Interactively drive the built-in pipeline.",
    positionals: [{ name: "<task>", description: "Task for the pipeline." }],
    options: [
      { name: "--auto", description: "Automatically choose pipeline transitions." },
      ...PIPELINE_OPTIONS,
    ],
    run: ({ positionals, flags, booleans }) =>
      driveCommand(positionals, flags, booleans["--auto"] === true),
  },
  {
    name: "console",
    description: "Chat with the persistent orchestrator session.",
    positionals: [],
    options: [
      ...PIPELINE_OPTIONS,
      { name: "--json", description: "Write one JSON record per completed turn." },
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
  operationsJsonFront = commandName === "operations" || commandName === "control";
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
        error instanceof ProjectOperationsError
          ? { code: error.code, detail: error.detail }
          : error instanceof ProjectStoreError
            ? { code: error.code, detail: error.path }
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
