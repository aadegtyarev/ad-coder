import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentHarnessOptions,
  Context,
  ExecutionToolContext,
  OperationResultRecord,
  Session,
} from "@earendil-works/pi-agent-core";
import { AgentHarness, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { requireModelAuthentication } from "../auth/operations";
import type { CompactionPolicy, Summarizer } from "../context/compactor";
import {
  attachDurableCompaction,
  COMPACTION_SAFETY_PROMPT,
  compactionLostErrorFrom,
  resolveCompactionPolicy,
} from "../context/compactor";
import { assertContextFitsBudget, assertTurnFitsBudget } from "../context/preflight";
import type { CostAnomalyDetector } from "../economics/cost-anomaly";
import type { LedgerSink } from "../ledger/ledger";
import { FileLedgerSink, Ledger } from "../ledger/ledger";
import {
  attachToolActivity,
  ToolActivityChannel,
  type ToolActivityConfig,
  type ToolActivityConsumer,
} from "../observability/tool-activity";
import {
  projectRemainingStageBudget,
  type StageCloseoutFact,
  type StageLimitController,
  StageLimitError,
} from "../orchestration/stage-limits";
import { ProjectStore } from "../project-store/project-store";
import type { ProjectStoreConfig } from "../project-store/types";
import { admissionFailureFrom, type ProviderAdmissionController } from "../provider-admission";
import type { Role } from "../role";
import { toHarnessOptions } from "../role";
import type { SessionLimitController } from "../session-limits";
import { createBuiltinTools } from "./builtin-tools";
import { dumpRequest } from "./dump-request";
import type { SettledTurnMessage } from "./errors";
import {
  assertRunId,
  assertUniqueToolNames,
  ConfiguredToolsUnavailableError,
  EmptyTurnError,
  GenerationTruncatedError,
  ProviderQuotaError,
  ProviderRejectionError,
  providerErrorCauseFrom,
  providerLimitFrom,
  providerQuotaFrom,
  providerRejectionStatusFrom,
  RunInterruptedError,
  RunnerError,
  resolveTargetDir,
  SuspendedRunError,
  truncatedGenerationFrom,
} from "./errors";
import { wrapModelsForToolCallRecovery } from "./native-tool-calls";
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
  /** Admit the supplied prompt when a requested resumed operation already settled. */
  resumePromptOnSettled?: boolean;
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
  /**
   * Shared per-(provider, model) price-step detector. Wrapping here rather than
   * at a front is what makes a blocked scope unbypassable: every generation
   * path goes through this one `Models` boundary.
   */
  costAnomalyDetector?: CostAnomalyDetector;
  /**
   * Shared provider-capacity admission boundary (issue #365). Wrapping here
   * rather than at a front is what makes a saturated scope unbypassable: every
   * generation path goes through this one `Models` boundary, outermost.
   */
  providerAdmissionController?: ProviderAdmissionController;
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
  /**
   * The stage closeout reserve the role entered before settling, when it did
   * (issue #327); absent from normal completions.
   */
  stageCloseout?: StageCloseoutFact;
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
  /**
   * Issue #469 clamp trace: provider rounds whose `reasoning > output` anomaly
   * was absorbed. Absent when nothing was clamped, so ordinary observations
   * stay byte-identical. Persisted with the run record only; rendering is
   * owned elsewhere.
   */
  clampedReasoning?: { responses: number; maxExcess: number };
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

/**
 * The newest assistant message in the durable session, or `undefined` when the
 * session carries none.
 *
 * Reimplemented (not imported) per the house convention for this scan: reading
 * `result.tipId` directly is fragile because a run whose LAST entry is a
 * tool-result would miss the message, so scan the most recent message entries
 * newest-first for the first assistant message. Both settled-turn boundaries in
 * this file read it -- the failed branch for its text (same semantics as the
 * scan it replaces), the completed gate (#368) for text, stop reason and
 * usage.
 */
async function newestAssistantMessage(
  session: Session,
  context: Context,
): Promise<SettledTurnMessage | undefined> {
  const entries = await session.findEntries({ type: "message", order: "desc", limit: 20 }, context);
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    return entry.message;
  }
  return undefined;
}

/** The answer text of the newest assistant message: its joined text blocks. */
function assistantMessageText(message: SettledTurnMessage | undefined): string {
  if (message === undefined) return "";
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
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
  /** Safe untracked paths, separately projected because ordinary git diff omits them. */
  untrackedFiles: string[];
  /** True when the ordinary diff projection cannot contain all changed content. */
  requiresFullDiff?: boolean;
}

export interface SafeGitDiffProjection {
  text: string;
  bytes: number;
  sha256: string;
  redactedLines: number;
  /** Total byte size of every untracked file measured before any truncation. */
  untrackedMeasuredBytes?: number;
  /** Count of untracked files whose projected content was capped by the ceiling. */
  untrackedTruncatedFiles?: number;
}

const DIFF_SECRET =
  /(?:bearer\s+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]|(?:^|\W)sk-[a-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

/** The whole replacement line redactDiffText writes for a credential-like addition. */
const DIFF_REDACTED_LINE = "+[REDACTED: possible credential]";

/** Count the redaction-marker lines actually present in a (possibly sliced) diff text. */
function countRedactedLines(text: string): number {
  return text.split("\n").filter((line) => line === DIFF_REDACTED_LINE).length;
}

function redactDiffText(decoded: string): { text: string; redactedLines: number } {
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
        return DIFF_REDACTED_LINE;
      }
      return line;
    })
    .join("\n");
  return { text, redactedLines };
}

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
      const { text, redactedLines } = redactDiffText(decoded);
      resolve({
        text,
        bytes: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
        redactedLines,
      });
    });
  });
}

/**
 * Slice UTF-8 text to a byte cap, never splitting inside a multi-byte
 * codepoint: the cap walks back over UTF-8 continuation bytes (10xxxxxx) so
 * the cut lands on a codepoint boundary and re-decodes losslessly.
 */
function utf8SafeSlice(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function projectUntrackedFile(relative: string, contents: string): string {
  return `diff --git a/${relative} b/${relative}\n--- /dev/null\n+++ b/${relative}\n${contents
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n")}\n`;
}

/**
 * Add bounded, redacted evidence for untracked paths omitted by ordinary git
 * diff. Issue #449: the aggregate ceiling bounds content instead of failing
 * the measurement -- content past it is truncated at a UTF-8-safe boundary,
 * every untracked file's true size stays in `untrackedMeasuredBytes`, and each
 * capped file is counted in `untrackedTruncatedFiles`. Only a genuine failure
 * (unsafe path, unreadable file, non-UTF-8 content) still throws the typed
 * measurement error.
 */
export function appendSafeUntrackedDiffProjection(
  targetDir: string,
  base: SafeGitDiffProjection,
  untrackedFiles: readonly string[],
  maxBytes: number,
): SafeGitDiffProjection {
  let text = base.text;
  let redactedLines = base.redactedLines;
  // Issue #449: a ceiling overflow is a bounded projection, not a measurement
  // failure -- cap that file's content at a UTF-8-safe boundary and keep going.
  let budget = maxBytes - Buffer.byteLength(text);
  let untrackedMeasuredBytes = 0;
  let untrackedTruncatedFiles = 0;
  for (const relative of untrackedFiles) {
    if (
      relative === "" ||
      path.isAbsolute(relative) ||
      relative.split("/").includes("..") ||
      !isSafeReportedPath(relative)
    ) {
      throw new RunnerError("diff_metric_failed", targetDir, "git changed path is unsafe");
    }
    const absolute = path.resolve(targetDir, relative);
    const contained = path.relative(targetDir, absolute);
    if (contained.startsWith("..") || path.isAbsolute(contained))
      throw new RunnerError("diff_metric_failed", targetDir, "git changed path is unsafe");
    // The true size is recorded even when the content cannot fit: it is the
    // honest material signal the context decision escalates on.
    let size: number;
    try {
      size = fs.statSync(absolute).size;
    } catch {
      // A file that vanished between the git listing and this read is a
      // measurement failure with a typed code, not an accidental fs throw.
      throw new RunnerError("diff_metric_failed", targetDir, "untracked file is unreadable");
    }
    untrackedMeasuredBytes += size;
    if (budget <= 0) {
      // No budget left: the content caps to zero -- counted, path kept.
      untrackedTruncatedFiles += 1;
      continue;
    }
    let contents: string;
    try {
      contents = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(absolute));
    } catch {
      throw new RunnerError("diff_metric_failed", targetDir, "untracked diff is not UTF-8");
    }
    const candidate = projectUntrackedFile(relative, contents);
    const redacted = redactDiffText(candidate);
    if (Buffer.byteLength(redacted.text) > budget) {
      // Truncate at a UTF-8-safe boundary; the path list and digest stay true,
      // and the redaction count is recounted on the KEPT text so a marker line
      // cut away by the ceiling is never counted as still visible.
      const kept = utf8SafeSlice(redacted.text, budget);
      untrackedTruncatedFiles += 1;
      text += kept;
      redactedLines += countRedactedLines(kept);
      budget = 0;
    } else {
      budget -= Buffer.byteLength(redacted.text);
      text += redacted.text;
      redactedLines += redacted.redactedLines;
    }
  }
  return {
    text,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    redactedLines,
    untrackedMeasuredBytes,
    untrackedTruncatedFiles,
  };
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
      if (code === 129) return resolve({ files: [], total: 0, truncated: 0, untrackedFiles: [] });
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
        untrackedFiles: entries
          .filter((entry) => entry.startsWith("?? "))
          .map((entry) => entry.slice(3))
          .filter((name) => safe.includes(name)),
        ...(entries.some((entry) => entry.startsWith("?? ")) && { requiresFullDiff: true }),
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
  const builtin = [...createBuiltinTools(env)];
  // Concatenate before validating so the collision guard sees the full set
  // (built-in-vs-custom and custom-vs-custom). `?? []` avoids ever registering
  // `undefined` when no custom tools were supplied -- prior behavior byte-for-byte.
  const tools = [...builtin, ...(params.tools ?? [])].map((tool) =>
    params.stageLimitController === undefined
      ? tool
      : {
          ...tool,
          execute: async (...args: Parameters<typeof tool.execute>) => {
            // The name lets the controller keep a workflow submission tool
            // admissible past the closeout reserve (issue #339).
            params.stageLimitController?.admitToolTurn(tool.name);
            return tool.execute(...args);
          },
        },
  );
  assertUniqueToolNames(tools);

  const controller = params.sessionLimitController;
  const sessionModels = controller?.wrap(params.models) ?? params.models;
  const limitedModels = params.stageLimitController?.wrap(sessionModels) ?? sessionModels;
  // OUTERMOST, so a blocked scope refuses before the session or stage
  // controllers reserve anything. Each proxy delegates inward, so the wrapper
  // applied LAST is the one entered FIRST: wrapping the detector inside the
  // session controller instead would let a refused start still consume one of
  // the session's counted turns, charging the operator a turn for a request
  // that was never sent.
  // Also at this boundary: recovery for a provider that serialized a tool call
  // as assistant text instead of a structured tool-call block (issue #292),
  // granted the names this invocation actually registered.
  const recoveredModels = wrapModelsForToolCallRecovery(
    params.costAnomalyDetector?.wrap(limitedModels, params.model.provider, params.model.id) ??
      limitedModels,
    tools.map((tool) => tool.name),
  );
  // ADMISSION OUTERMOST: the wrapper applied last is entered first, and the
  // provider's own client can only be opened through it, so a saturated scope
  // refuses before session/stage/cost-anomaly reserve anything and before
  // tool-call recovery can retry. Scope identity is the provider-account
  // id (`model.provider`, e.g. `work-openrouter` vs `home-openrouter` per
  // docs/provider-catalogs.md) passed as both the provider and the account
  // label — never a secret, never a raw credential — and hashed to a digest by
  // `admissionScopeKey`, so only the SHA-256 digest is ever persisted.
  const models =
    params.providerAdmissionController?.wrap(
      recoveredModels,
      params.model.provider,
      params.model.provider,
    ) ?? recoveredModels;
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
  // Issue #469: responses whose `reasoning` exceeded `output` are absorbed here,
  // not discarded; the counters below become the persisted clamp observation.
  const reasoningClamp = { count: 0, maxExcessTokens: 0 };
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
    compactionMode: compaction.mode,
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
  // Opt-in dump of what the role was actually sent (issue #317). Sizes on the
  // ledger answer "did a prompt arrive"; only the text answers "was it the right
  // one" -- a question that cost this session an hour of reading source to
  // settle by hand. Off unless the operator sets the variable, because a request
  // carries the task and whatever the role has read, and that must never land in
  // a durable file by default.
  if (process.env.AD_CODER_DUMP_REQUEST !== undefined) {
    dumpRequest(store ?? new ProjectStore(absTargetDir, params.projectStoreConfig), {
      runId,
      role: params.role.name,
      step: params.step ?? "run",
      systemPrompt: effectiveSystemPrompt,
      prompt: params.resumeActiveOperation === true ? "" : params.prompt,
      toolNames: tools.map(({ name }) => name),
    });
  }
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
    // Sizes already computed above for the stage metrics, written onto every
    // ledger row as well: the metrics reach a caller only through a settled
    // pipeline result, and the ledger is what survives a run that does not
    // settle (issue #317).
    requestBytes: {
      systemPrompt: systemPromptBytes,
      prompt: promptBytes,
      toolDefinitions: toolDefinitionBytes,
      total: systemPromptBytes + promptBytes + toolDefinitionBytes,
    },
    sink,
  });

  let harness: Awaited<ReturnType<typeof AgentHarness.create<ExecutionToolContext>>>["harness"];
  try {
    ({ harness } = await AgentHarness.create<ExecutionToolContext>(options, context));
  } catch (error) {
    if (store !== undefined) await session.close(context);
    await store?.close(context);
    throw error;
  }
  ledger.attach(harness.hooks);
  if (compaction.mode === "auto") {
    attachDurableCompaction(harness.hooks, {
      budget: params.role.contextBudget,
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
  const ownsActivityChannel = params.activityChannel === undefined;
  const activityChannel = params.activityChannel ?? new ToolActivityChannel(params.toolActivity);
  const offActivityConsumer =
    params.activityConsumer === undefined
      ? undefined
      : activityChannel.subscribe(params.activityConsumer);
  const stageLimitController = params.stageLimitController;
  const offActivity = attachToolActivity({
    channel: activityChannel,
    events: harness.events,
    targetDir: absTargetDir,
    role: params.role.name,
    model: params.role.modelId,
    runId,
    step: params.step ?? "run",
    // Spend is known after every provider turn, limits or not; the remaining
    // capacity projection stays alongside for stages that do have limits.
    budget: () => ({
      ...(stageLimitController !== undefined && {
        ...projectRemainingStageBudget(stageLimitController.snapshot()),
      }),
      // Issue #469 rule: `reasoning` (reasoning_tokens) is already inside
      // `output` (completion_tokens), so it is not added again here.
      usedTokens: usage.freshInput + usage.cachedInput + usage.output,
      usedCostUsd: usage.costUsd,
    }),
  });
  harness.hooks.on("after_response", (event) => {
    try {
      const freshInput = boundedUsageInteger(event.message.usage.input, "input");
      const cachedInput = boundedUsageInteger(event.message.usage.cacheRead, "cacheRead");
      const output = boundedUsageInteger(event.message.usage.output, "output");
      const reasoningRaw = boundedUsageInteger(event.message.usage.reasoning ?? 0, "reasoning");
      let reasoning = reasoningRaw;
      // Issue #469: `output` is `completion_tokens` and already CONTAINS
      // `reasoning_tokens` (`reasoning` is `completion_tokens_details.reasoning_tokens`)
      // per the provider's own contract -- pi-ai's openai-completions converter notes
      // this itself and therefore does not add reasoning to its totalTokens. So a
      // `reasoning > output` pair is a provider accounting anomaly to be ABSORBED,
      // never a fatal error: `reasoning` is clamped DOWN to `output`, and the round
      // runs to its end instead of discarding it (the old throw landed after the
      // verdict and re-threw before the review stamp, killing a fully paid round).
      // Every OTHER bounded-usage violation (NaN, negative, non-integer, out of
      // range) still throws below via boundedUsageInteger/addUsageInteger.
      if (reasoning > output) {
        const excess = reasoning - output;
        reasoning = output;
        reasoningClamp.count += 1;
        reasoningClamp.maxExcessTokens = Math.max(reasoningClamp.maxExcessTokens, excess);
      }
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
              : params.resumePromptOnSettled === true
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
        params.costAnomalyDetector?.assertNoBoundaryFailure();
        params.stageLimitController?.assertNoBoundaryFailure();
        controller?.assertNoBoundaryFailure();
        const providerLimit = providerLimitFrom(error);
        if (providerLimit !== undefined) throw providerLimit;
        throw error;
      });
    if (isInterrupted()) throw new RunInterruptedError(runId);
    params.costAnomalyDetector?.assertNoBoundaryFailure();
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
      // A message-embedded 429 is a quota/rate-limit refusal the structured
      // conversions above cannot see: pi-agent-core composes `providerError` as
      // `{ code, message }` with no status field, so the 429 lives only in the
      // message body. Classify it HERE, at the settled-error boundary, before
      // the empty-turn fallback can misattribute it as an authentication
      // failure (#356). A refusal is a refusal whether or not the prompt's
      // input tokens were billed.
      const quota = providerQuotaFrom(result.error);
      if (quota !== undefined)
        throw new ProviderQuotaError(runId, quota.providerCode, quota.retryAfterMs);
    }
    if (result.status === "failed") {
      if (result.error?.code === "configured_tools_unavailable") {
        throw new ConfiguredToolsUnavailableError(runId, result.error);
      }
      // The harness could not produce the compaction this run needed, so the run
      // itself settled as failed. That is not an empty turn and not a provider
      // refusal: the session's context can no longer be summarized, and the
      // answer is to reopen it, not to retry it (#444, #391).
      const compactionLost = compactionLostErrorFrom(result.error, {
        role: params.role.name,
        budget: params.role.contextBudget,
        contextWindow: params.model.contextWindow,
      });
      if (compactionLost !== undefined) throw compactionLost;
      const finalMessage = await newestAssistantMessage(session, context);
      const text = assistantMessageText(finalMessage);
      // An admission refusal settles as a stream-terminal error message (the
      // stream must return synchronously), and the durable drive composes
      // every settled failure as `assistant_error` -- the typed class is
      // destroyed at that boundary exactly as an HTTP status is. Recover it
      // BEFORE the empty-turn projection: "verify authentication" is the
      // wrong instruction for a scope this runner saturated, and
      // `queue_saturated` is retryable while an empty turn is not.
      if (params.providerAdmissionController !== undefined) {
        const admissionFailure = admissionFailureFrom(result.error, params.model.provider);
        if (admissionFailure !== undefined) throw admissionFailure;
      }
      if (text.trim() === "" && usage.freshInput + usage.cachedInput + usage.output === 0) {
        // A settled failure with no text and no usage has two very different
        // causes, and the transcript cannot tell them apart. When the provider
        // named a client-error status it ANSWERED and refused the request, so
        // say that instead of sending the operator to check credentials; only
        // an unattributed failure keeps the authentication wording. (A
        // message-embedded 429 was already classified by `providerQuotaFrom`
        // at the settled-error boundary above, where usage does not gate the
        // refusal.)
        const rejection = providerRejectionStatusFrom(result.error);
        if (rejection !== undefined) throw new ProviderRejectionError(runId, rejection);
        // Bounded provider-cause enrichment for the FALLBACK only (#418). The
        // allow-list classifications above are owned boundaries and stay
        // exactly as they are; this is the case where none of them fired and
        // the class used to say "verify authentication" about a provider that
        // in fact named a status and a code (an OpenRouter 402 billing
        // refusal is neither rejection, quota, nor credential failure). The
        // extraction is bounded by `providerErrorCauseFrom`/the constructor:
        // `EmptyTurnError` drops a non-integer, out-of-range, or
        // non-strict-charset value, and its message never carries provider
        // prose or a body. The settled assistant message's `errorMessage` is
        // the second channel for the same failure string, read only when the
        // composed error carried no parsable one.
        const cause =
          providerErrorCauseFrom(result.error) ??
          providerErrorCauseFrom({
            ...(typeof finalMessage?.errorMessage === "string" && {
              message: finalMessage.errorMessage,
            }),
          });
        throw new EmptyTurnError(runId, result.error?.code, cause?.status, cause?.code);
      }
      if (text.trim() === "") {
        // Non-zero usage with no answer text: a generation RAN and produced
        // nothing usable -- pi-agent-core's one bounded compact-and-retry for a
        // length stop has already run and failed, so the settled error is the
        // generic `assistant_error` and the empty-turn fallback's credential
        // advice would be wrong twice over (#368). A truncated generation is
        // its own outcome; an error/aborted-stopped message is not a settled
        // generation and stays with the classifications above.
        const truncated = truncatedGenerationFrom(finalMessage);
        if (truncated !== undefined) {
          throw new GenerationTruncatedError(
            runId,
            truncated.stopReason,
            truncated.outputTokens,
            truncated.reasoningTokens,
          );
        }
      }
    }
    if ("status" in result && result.status === "suspended") {
      // lane.prompt returns OperationResultRecord | SuspendedRun. A single-turn
      // faux/live drive settles; a suspended run means a deferred provider
      // response this convenience path does not resume. Fail loud rather than
      // returning a record the caller would read as settled.
      throw new SuspendedRunError(runId);
    }
    if (result.status === "completed") {
      // A settled-SUCCESS turn whose final assistant message carries no answer
      // and no tool call is not a completed run (#368): the provider ANSWERED,
      // so every failure classification above is gated behind a failed status
      // that never fired, and a generation truncated by the output limit (the
      // whole budget spent on reasoning) reached the caller as an empty success
      // with `isError: false` -- discoverable only by reading the raw session
      // jsonl. A text block or a tool call is usable content; only silence --
      // thinking-only or empty -- classifies here.
      const finalMessage = await newestAssistantMessage(session, context);
      if (assistantMessageText(finalMessage).trim() === "") {
        const truncated = truncatedGenerationFrom(finalMessage);
        if (truncated !== undefined) {
          throw new GenerationTruncatedError(
            runId,
            truncated.stopReason,
            truncated.outputTokens,
            truncated.reasoningTokens,
          );
        }
      }
    }
    // The diff metric is observability, not the deliverable (issue #363): a
    // git target with no commit (or any other reason `git diff HEAD` cannot
    // run) must not destroy a COMPLETED stage. Catch only the runner's own
    // typed measurement failure, record 0 bytes, and make the lost measurement
    // visible on stderr so the settled text/followUps survive.
    let diffBytes = 0;
    try {
      diffBytes = await measureSafeGitDiffBytes(absTargetDir);
    } catch (error) {
      if (!(error instanceof RunnerError) || error.code !== "diff_metric_failed") throw error;
      process.stderr.write(
        `ad-coder: diff metric unavailable for ${absTargetDir} (git diff metric failed); ` +
          "recording diffBytes 0\n",
      );
    }
    params.stageLimitController?.assertActive();
    // Relay the recorded closeout when the stage entered a reserve (issue #327).
    const stageCloseout = stageLimitController?.closeout();
    const totalInput = boundedUsageInteger(usage.freshInput + usage.cachedInput, "total input");
    return {
      runId,
      ledgerPath,
      droppedRecords: ledger.droppedRecords,
      droppedActivityEvents: activityChannel.droppedCount,
      result,
      ...(stageCloseout !== undefined && { stageCloseout }),
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
        // Issue #469: the clamp trace rides with the observations that are
        // already persisted into the run record; absent when nothing was
        // clamped so ordinary runs stay byte-identical.
        ...(reasoningClamp.count > 0 && {
          clampedReasoning: {
            responses: reasoningClamp.count,
            maxExcess: reasoningClamp.maxExcessTokens,
          },
        }),
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
