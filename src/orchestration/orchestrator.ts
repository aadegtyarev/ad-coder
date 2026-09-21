import * as crypto from "node:crypto";
import * as path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import { Type } from "@earendil-works/pi-ai";
import type { DelegatedRoute, ResolvePipelineConfigOptions } from "../cli/resolve-config";
import { resolveOrchestratorSeed, resolvePipelineConfig } from "../cli/resolve-config";
import type { ConversationSession, ConversationTurnResult } from "../conversation/conversation";
import {
  startConversation as startConversationImpl,
  TurnInterruptedError,
} from "../conversation/conversation";
import type { CostAnomalyDetector } from "../economics/cost-anomaly";
import { CostAnomalyBlockedError } from "../economics/cost-anomaly";
import type { MemoryLedgerSink } from "../ledger/ledger";
import { FileLedgerSink, MemoryLedgerSink as MemoryLedgerSinkImpl } from "../ledger/ledger";
import type { ToolActivityConsumer, ToolActivitySnapshot } from "../observability/tool-activity";
import { ToolActivityChannel } from "../observability/tool-activity";
import type { StageCloseoutFact } from "../orchestration/stage-limits";
import { StageCloseoutError, StageLimitError } from "../orchestration/stage-limits";
import type { ProfileRole } from "../profiles/types";
import { PROFILE_ROLES } from "../profiles/validate";
import { ProjectOperationsError } from "../project-operations/errors";
import {
  clearsOnExplicitAct,
  type RunCheckpoint,
  RunCoordinator,
} from "../project-operations/run-coordinator";
import { ProjectStore } from "../project-store/project-store";
import { ProjectStoreError } from "../project-store/types";
import type { Role } from "../role";
import { defineRole } from "../role";
import {
  ConfiguredToolsUnavailableError,
  EmptyTurnError,
  GenerationTruncatedError,
  ProviderLimitError,
  ProviderQuotaError,
  ProviderRejectionError,
  RunInterruptedError,
  RunnerError,
  resolveTargetDir,
  SuspendedRunError,
} from "../runner/errors";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";
import type { SessionLimitSnapshot, SessionLimits } from "../session-limits";
import { SessionLimitController, SessionLimitError } from "../session-limits";
import { pluginNamesFromToolNames } from "../skills/resolver";
import { roleSkillKit } from "../skills/role-kit";
import { recordReviewStampFromResult } from "../stamp/record-review-stamp";
import { buildWebTools } from "../web/tools";
import { resolveWorkflowModules } from "../workflows/registry";
import type { OrchestratorWorkflowModule } from "../workflows/types";
import {
  type BackgroundRunExecutor,
  type BackgroundRunLimits,
  BackgroundRunManager,
} from "./background-runs";
import { pipelinePauseFromCheckpoint } from "./pipeline";
import { COMPLEXITY_RUBRIC, CONTRACT_INDEX } from "./plan";
import type { WorkflowSession } from "./session";
import { autoDriver, createWorkflowSession } from "./session";
import { STAGE_LIMIT_KEY, type StageLimitReason } from "./stage-limits";
import { isSubmissionToolName } from "./submission-tools";
import { assertTransitionOffered, DriveError } from "./transition-guard";
import {
  createTrivialEditGuard,
  type TrivialEditCoverFn,
  type TrivialEditCoverSettle,
  trivialEditGuardPlan,
} from "./trivial-edit";
import {
  type AvailableTransition,
  type Complexity,
  OrchestrationError,
  type PipelineConfig,
  type PipelineResult,
  type Plan,
  type TransitionKind,
  type Verdict,
  type WorkflowPhase,
  type WorkflowState,
} from "./types";
import {
  buildSubmitVerdictTool,
  formatReviewerInstruction,
  REVIEW_SUBMISSION_ATTEMPTS,
  reviewRetryTask,
  SUBMIT_VERDICT_TOOL_NAME,
  type VerdictCapture,
} from "./verdict";
import { WakePump } from "./wake";

/** The four tool names the orchestrator model drives the workflow through. */
export const RUN_PIPELINE_TOOL_NAME = "run_pipeline";
export const RESUME_PIPELINE_TOOL_NAME = "resume_pipeline";
export const DECOMPOSE_TASK_TOOL_NAME = "decompose_task";
export const RUN_STEP_TOOL_NAME = "run_step";
export const CHOOSE_TRANSITION_TOOL_NAME = "choose_transition";
export const SHOW_COST_TOOL_NAME = "show_cost";
export const RUN_ROLE_TOOL_NAME = "run_role";
export const START_PIPELINE_TOOL_NAME = "start_pipeline";
export const PIPELINE_STATUS_TOOL_NAME = "pipeline_status";
export const PIPELINE_EVENTS_TOOL_NAME = "pipeline_events";
export const PIPELINE_RESULT_TOOL_NAME = "pipeline_result";
export const CANCEL_PIPELINE_TOOL_NAME = "cancel_pipeline";

export const DELEGATABLE_ROLE_NAMES = [
  "planner",
  "researcher",
  "security",
  "coder",
  "reviewer",
  "auditor",
] as const;
export type DelegatableRoleName = (typeof DELEGATABLE_ROLE_NAMES)[number];

export interface DelegatedRoleResult {
  role: DelegatableRoleName;
  text: string;
  cost: number;
  /**
   * Stage closeout relay (issue #327). Stays absent for delegated
   * conversations until issue #328 wires per-stage ceilings there.
   */
  stageCloseout?: StageCloseoutFact;
}

/**
 * Why an orchestrator-core precondition was rejected. Distinct from
 * `DriveError('transition_not_offered')` (the untrusted-kind guard, which stays
 * the shared transition-guard's job): these are call-ordering faults the model
 * can trigger through the tools -- stepping before a run began, stepping past a
 * settled run, choosing a transition with none on offer, or stepping again while
 * one is still awaiting a choice. Each is a hard, loud failure so a mis-sequenced
 * tool call can never be read as progress.
 */
export type OrchestratorErrorCode =
  | "no_active_session"
  | "awaiting_transition"
  | "no_pending_transition"
  | "invalid_role"
  // A malformed ceiling raise is not a bad role: errors.md requires invalid
  // input to stay distinguishable rather than collapsing into one code.
  | "invalid_raise";

/**
 * Raised on an orchestrator-core precondition failure. Carries a `code`
 * discriminant and a names-only `detail` (a method/state token) -- never model
 * text, prompt content, a runId body, or a filesystem path. Mirrors
 * `DriveError`/`OrchestrationError` house style: safe tokens only, dense WHY in
 * JSDoc, nothing that leaks into the transcript.
 */
class BackgroundCancellation extends Error {}

export class OrchestratorError extends Error {
  override readonly name = "OrchestratorError";
  readonly code: OrchestratorErrorCode;
  /** A method/state token (e.g. `stepOnce`, `done`). Never content. */
  readonly detail: string;

  constructor(code: OrchestratorErrorCode, detail: string, message: string) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** The cost attributed to one executed workflow step, by ledger-record position. */
export interface StepCost {
  /** The phase whose role turn this step ran. */
  phase: WorkflowPhase;
  /** 1-based index of this step across the orchestrator's whole lifetime. */
  step: number;
  /** Sum of `usage.cost.total` over the ledger records the step appended. */
  cost: number;
}

/** The settled outcome of one autonomous `runPipeline`, plus its per-step cost. */
export interface RunPipelineResult {
  /** Durable coordinator identity used to resume an interrupted execution. */
  runId: string;
  result: PipelineResult;
  /** Per-step cost for THIS run only, in step order. */
  perStep: StepCost[];
  /** Sum of `perStep` costs for this run. */
  totalCost: number;
}

export interface DecompositionResult {
  plan: Plan;
  text: string;
  cost: StepCost;
}

/**
 * The narrowed view one manual `stepOnce` hands back: the phase that ran, its
 * runId, the turn's assistant text, an optional structured verdict/plan, and the
 * KINDS of the transitions now on offer. Deliberately NOT the raw
 * `OperationResultRecord` or any `LedgerRecord[]` -- it mirrors the
 * `ConversationTurnResult` narrowing so nothing but safe, projected fields
 * reaches the model/transcript.
 */
export interface StepView {
  phase: WorkflowPhase;
  runId: string;
  text: string;
  verdict?: Verdict;
  plan?: Plan;
  /** The offered transition KINDS; the model picks one for `chooseTransition`. */
  transitions: TransitionKind[];
}

/** The cumulative cost report across every step the orchestrator has run. */
export interface CostReport {
  /** Every step so far, in order. */
  perStep: StepCost[];
  /** Sum of `usage.cost.total` over EVERY ledger record on the shared sink. */
  totalCost: number;
  /** Authoritative model-boundary accounting, distinct from ledger attribution. */
  sessionLimits?: Readonly<SessionLimitSnapshot>;
}

/**
 * The dependencies a headless orchestrator core is built from.
 *
 * `buildConfig` turns a task into a runnable `PipelineConfig` (the credential
 * boundary lives entirely inside it -- see `startOrchestrator`); the core spreads
 * the shared `ledgerSink` over every config it builds so per-step cost is always
 * read from the one sink. Keeping these injected is what lets the mandatory
 * "capability reachable without the chat front" test drive the core with faux
 * models and no `startConversation`.
 */
/**
 * A ceiling the orchestrator raised after a stage exhausted it.
 *
 * `docs/contracts/operator-flow.md` requires an underestimate on progressing
 * work to be raised and recorded rather than to kill the run. The coordinator
 * already refuses to resume a stage-limit pause at an unchanged ceiling
 * (`unchanged <reason> stage limit`), so without a way to carry a larger number
 * back in, that refusal blocked the very correction it was written to require.
 */
export interface RaisedStageLimits {
  role: ProfileRole;
  reason: StageLimitReason;
  limit: number;
}

/**
 * Check a raise against the shipped unions, or refuse it by name.
 *
 * Module scope, not inside a factory: every entry point -- the `resume_pipeline`
 * tool, the exported `resumePipeline`, a library caller building the object
 * itself -- must clear the same gate. Validating only at the tool would leave a
 * programmatic raise silently unmatched by the overlay, and the run would then
 * fail on the coordinator's "unchanged ceiling" guard, reporting the wrong
 * cause (docs/contracts/errors.md: an expected boundary failure has a stable
 * typed code, and invalid input stays distinguishable).
 */
export function assertRaisedLimits(raised: RaisedStageLimits): RaisedStageLimits {
  if (!PROFILE_ROLES.includes(raised.role))
    throw new OrchestratorError(
      "invalid_raise",
      `unknown raiseRole ${raised.role}; expected one of ${PROFILE_ROLES.join(", ")}`,
      "the raised ceiling must name a configured role",
    );
  if (!(raised.reason in STAGE_LIMIT_KEY))
    throw new OrchestratorError(
      "invalid_raise",
      `unknown raiseReason ${raised.reason}; expected one of ${Object.keys(STAGE_LIMIT_KEY).join(", ")}`,
      "the raised ceiling must name the exhausted limit",
    );
  // NOT `>= 0`. Zero DISABLES a limit (docs/contracts/config.md), and the
  // coordinator's unchanged-ceiling guard short-circuits on a resolved zero
  // (`resumedLimit !== 0 && ...`), so a zero raise would slip past the very
  // protection this path exists to satisfy and remove the ceiling instead of
  // enlarging it. Raising is not disabling.
  if (!Number.isFinite(raised.limit) || raised.limit <= 0)
    throw new OrchestratorError(
      "invalid_raise",
      `raiseLimit ${raised.limit} must be a finite number greater than 0`,
      "a raise enlarges a ceiling; zero would disable it",
    );
  return raised;
}

export interface OrchestratorDeps {
  buildConfig: (
    task: string,
    complexity?: Complexity,
    raisedLimits?: RaisedStageLimits,
  ) => PipelineConfig;
  ledgerSink: MemoryLedgerSink;
  sessionLimitController?: SessionLimitController;
  backgroundRuns?: Partial<BackgroundRunLimits>;
  /** Durable background state root. Required by production fronts; optional for embedded test cores. */
  backgroundTargetDir?: string;
  /** Stable owner scope used to reconnect to this session's background runs. */
  backgroundOwnerId?: string;
  /** Host-owned detached worker launcher; required by start_pipeline. */
  backgroundHostLauncher?: import("./background-runs").BackgroundHostLauncher;
  /** Injection seam for tests/embedders to own the background-run executor; defaults to the real pipeline executor. */
  backgroundRunExecutor?: BackgroundRunExecutor;
}

/**
 * The headless orchestrator: the third driver of the stepped workflow engine (a
 * model or a caller), alongside `runPipeline`'s auto-driver and the human CLI.
 *
 * `runPipeline` drives a whole plan -> [security] -> code<->review run
 * autonomously. `beginStepping`/`stepOnce`/`chooseTransition` expose the same
 * engine one step at a time, where a driver inspects each step's result before
 * committing a transition. `showCost` reports cumulative per-step cost.
 *
 * SECURITY INVARIANT: a model chooses only a transition KIND; `chooseTransition`
 * resolves it against the engine-authored offered set and validates it with
 * `assertTransitionOffered` before `applyTransition`. It NEVER accepts a
 * model-supplied `toPhase`/`toRound`, so a run can never be driven off its own
 * graph (e.g. jumped straight to `done`).
 */
export interface ForegroundRunProjection {
  runId: string;
  lifecycle: "pending" | "paused" | "completed";
  foreground: true;
  phase: WorkflowPhase;
  round: number;
  metrics: { steps: number; totalCost: number };
  pause?: RunCheckpoint["pause"];
  outcome?: PipelineResult["outcome"];
  approved?: boolean;
  rounds?: number;
  verdict?: string;
  message?: string;
  actions: {
    status: "applicable";
    result: "applicable";
    events: "not_applicable";
    cancel: "not_applicable";
  };
}

export interface Orchestrator {
  /**
   * `complexity` is the orchestrator's own pre-read classification (issue
   * #264): it overrides the constant default so the tier the run starts at is
   * an assessment, not the fallback. Resume intentionally does not take it --
   * the checkpoint already recorded what the run routed on.
   */
  runPipeline(task: string, complexity?: Complexity): Promise<RunPipelineResult>;
  resumePipeline(
    task: string,
    runId: string,
    raisedLimits?: RaisedStageLimits,
  ): Promise<RunPipelineResult>;
  decomposeTask(task: string, complexity?: Complexity): Promise<DecompositionResult>;
  beginStepping(task: string, complexity?: Complexity): void;
  stepOnce(): Promise<StepView>;
  chooseTransition(kind: TransitionKind, rationale?: string): WorkflowPhase;
  showCost(): CostReport;
  /** Session-scoped asynchronous execution; callers must not share this object across principals. */
  readonly backgroundRuns: BackgroundRunManager;
  /** True while a stepping run is in progress and not yet settled. */
  isStepping(): boolean;
  /** Safe lookup for the foreground coordinator record; never returns task content. */
  foregroundStatus(runId: string): ForegroundRunProjection | undefined;
  foregroundExists(runId: string): boolean;
}

/**
 * Build a headless orchestrator core over the injected deps.
 *
 * Per-step cost is attributed by ledger-record POSITION, never a `runId` join: a
 * record's `runId` is the harness op id, not the step runId (the same reason
 * `costForRange` in src/cli/drive.ts sums by position). Every `session.step`
 * runs exactly one role turn, awaited to completion with no concurrency, so the
 * records the shared sink grew by across that await ARE that step's records.
 */
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const sink = deps.ledgerSink;
  const cumulative: StepCost[] = [];
  let stepCounter = 0;

  // Manual-stepping state. `session`/`state` are the live run; `pending` holds
  // the offered transitions awaiting a `chooseTransition`, and its presence is
  // what distinguishes "mid-step" from "ready to step again".
  let session: WorkflowSession | undefined;
  let state: WorkflowState | undefined;
  let pending: AvailableTransition[] | undefined;
  let coordinator: RunCoordinator | undefined;

  /** Enforce the shared sink on every config the core builds. */
  const buildConfig = (
    task: string,
    complexity?: Complexity,
    raisedLimits?: RaisedStageLimits,
  ): PipelineConfig => ({
    ...deps.buildConfig(task, complexity, raisedLimits),
    ledgerSink: sink,
    ...(deps.sessionLimitController !== undefined && {
      sessionLimitController: deps.sessionLimitController,
    }),
  });

  /** Sum the sink records appended in [from, to) and log the step's cost. */
  const recordStep = (phase: WorkflowPhase, from: number, to: number): StepCost => {
    const records = sink.records();
    let cost = 0;
    for (let i = from; i < to; i += 1) {
      cost += records[i]?.usage.cost.total ?? 0;
    }
    stepCounter += 1;
    const entry: StepCost = { phase, step: stepCounter, cost };
    cumulative.push(entry);
    return entry;
  };

  const executePipeline = async (
    task: string,
    resumeRunId?: string,
    control?: { cancelled: () => boolean; onStage: (step: StepCost) => void },
    createWithRunId = false,
    complexity?: Complexity,
    raisedLimits?: RaisedStageLimits,
  ): Promise<RunPipelineResult> => {
    // Validated HERE, not at the tool: `resumePipeline` is exported, so a
    // library caller reaches this path without passing the tool's parameter
    // parsing. An unvalidated raise would never match the overlay and the run
    // would then fail on the coordinator's "unchanged ceiling" guard -- a
    // message about the wrong thing entirely.
    const raised = raisedLimits === undefined ? undefined : assertRaisedLimits(raisedLimits);
    const config = buildConfig(task, complexity, raised);
    const wf = createWorkflowSession(config);
    const runCoordinator = new RunCoordinator(wf, wf.projectStore, {
      ...config.coordinator,
      task,
      ...(resumeRunId === undefined
        ? {}
        : { runId: resumeRunId, ...(createWithRunId ? {} : { resumeExisting: true }) }),
    });
    // An explicit resume act clears every pause `resumeStage` accepts from a
    // host/operator source: the act itself is the operator instruction to try
    // the paused stage again (issue #315's resumable `plan_not_submitted`
    // included). `stage_limit` stays raise-aware inside `resumeStage` -- an
    // unchanged ceiling still refuses there.
    if (resumeRunId !== undefined && clearsOnExplicitAct(runCoordinator.checkpoint.pause?.code))
      runCoordinator.resumeStage({ source: "host_config", action: "retry" });
    const perStep: StepCost[] = [];
    let costCursor = sink.records().length;
    const completed = await runCoordinator.run(autoDriver, ({ result }) => {
      const after = sink.records().length;
      const step = recordStep(result.phase, costCursor, after);
      perStep.push(step);
      costCursor = after;
      if (control?.cancelled()) throw new BackgroundCancellation();
      control?.onStage(step);
    });
    if (completed.result === undefined) {
      // The pause outranks a pending decision ON PURPOSE (issue #261): the
      // coordinator deletes the pause when a decision resolves, so a pause
      // present here is the live state and must be projected as one.
      const pause = pipelinePauseFromCheckpoint(completed.checkpoint);
      if (pause !== undefined) {
        // A foreground resume that re-pauses must reach the background
        // registry too (issue #363): this orchestrator owns both records, and
        // the registry otherwise keeps the stale earlier pause. A runId with
        // no entry here (a run this process never registered) projects
        // nothing.
        backgroundRuns.projectForegroundPause(pause.detail, pause.pause, pause.metrics, perStep);
        throw pause;
      }
      const decision = completed.checkpoint.decisions.find((item) => item.status === "pending");
      throw new ProjectOperationsError(
        "pending_decision",
        decision?.id ?? completed.checkpoint.runId,
      );
    }
    // The core's own settle paths owe the same paperwork as the CLI fronts'
    // runPipeline (issue #378): run_pipeline/resume_pipeline settle a
    // structured verdict HERE, so this is where their stamp is written --
    // same one-writer hook, ignored outcome, no stderr the fronts don't have.
    // The writer stays a no-op in targets without the stamp marker, and a
    // pause or a pending decision threw above and writes nothing.
    recordReviewStampFromResult(
      config.targetDir,
      completed.result,
      new Date(),
      config.requireStamp,
    );
    const totalCost = perStep.reduce((sum, e) => sum + e.cost, 0);
    const pipelineResult = {
      runId: completed.checkpoint.runId,
      result: completed.result,
      perStep,
      totalCost,
    };
    backgroundRuns.projectForegroundResult(completed.checkpoint.runId, pipelineResult);
    return pipelineResult;
  };

  const runPipeline = (task: string, complexity?: Complexity): Promise<RunPipelineResult> =>
    executePipeline(task, undefined, undefined, false, complexity);
  const resumePipeline = (
    task: string,
    runId: string,
    raisedLimits?: RaisedStageLimits,
  ): Promise<RunPipelineResult> =>
    executePipeline(task, runId, undefined, false, undefined, raisedLimits);
  const executeBackgroundPipeline = async (
    task: string,
    runId: string,
    control: { cancelled: () => boolean; onStage: (step: StepCost) => void },
  ): Promise<RunPipelineResult> => {
    const resolved = deps.buildConfig(task);
    // Same mirror as the session sink: a detached pipeline worker is the run
    // LEAST likely to have anyone watching its stderr, so its rows must reach
    // disk under its own runId.
    const workerSink = new MemoryLedgerSinkImpl(
      new FileLedgerSink(
        path.join(resolved.targetDir, ".ad-coder", "ledger", `${runId}.jsonl`),
        resolved.projectStoreConfig?.byteLimits?.jsonlRecord ?? 0,
      ),
    );
    const inheritedLimits =
      resolved.sessionLimitController?.limits ?? deps.sessionLimitController?.limits;
    const workerLimits = new SessionLimitController(inheritedLimits);
    const config: PipelineConfig = {
      ...resolved,
      ledgerSink: workerSink,
      sessionLimitController: workerLimits,
    };
    const workflow = createWorkflowSession(config);
    const workerCoordinator = new RunCoordinator(workflow, workflow.projectStore, {
      ...config.coordinator,
      task,
      runId,
    });
    const perStep: StepCost[] = [];
    let cursor = 0;
    // The worker sink owns a file descriptor now, so it is released on EVERY
    // exit -- a cancelled or failed background run included.
    const completed = await (async () => {
      try {
        return await workerCoordinator.run(autoDriver, ({ result }) => {
          const records = workerSink.records();
          let cost = 0;
          for (let index = cursor; index < records.length; index += 1)
            cost += records[index]?.usage.cost.total ?? 0;
          cursor = records.length;
          const step = { phase: result.phase, step: perStep.length + 1, cost };
          perStep.push(step);
          if (control.cancelled()) throw new BackgroundCancellation();
          control.onStage(step);
        });
      } finally {
        workerSink.close();
      }
    })();
    if (completed.result === undefined) {
      // The pause outranks a pending decision ON PURPOSE (issue #261): the
      // coordinator deletes the pause when a decision resolves; a background
      // worker has no decision-resolver, so a co-present pause is the live
      // state and must be projected as one.
      const pause = pipelinePauseFromCheckpoint(completed.checkpoint);
      if (pause !== undefined) throw pause;
      const decision = completed.checkpoint.decisions.find((item) => item.status === "pending");
      throw new ProjectOperationsError(
        "pending_decision",
        decision?.id ?? completed.checkpoint.runId,
      );
    }
    // Same settle hook as executePipeline (issue #378): start_pipeline and the
    // background lanes settle their verdict here, so their stamp lands here.
    recordReviewStampFromResult(
      config.targetDir,
      completed.result,
      new Date(),
      config.requireStamp,
    );
    return {
      runId: completed.checkpoint.runId,
      result: completed.result,
      perStep,
      totalCost: perStep.reduce((sum, step) => sum + step.cost, 0),
    };
  };
  const backgroundRuns = new BackgroundRunManager(
    deps.backgroundRunExecutor ?? executeBackgroundPipeline,
    deps.backgroundRuns,
    deps.backgroundTargetDir,
    deps.backgroundOwnerId,
    deps.backgroundHostLauncher,
  );
  const foregroundStore =
    deps.backgroundTargetDir === undefined ? undefined : new ProjectStore(deps.backgroundTargetDir);
  const readForeground = (runId: string): RunCheckpoint | undefined => {
    if (foregroundStore === undefined) return undefined;
    foregroundStore.validateId(runId);
    try {
      return foregroundStore.readVersionedJson<RunCheckpoint>(
        path.join(foregroundStore.layout.runs, `coordinator-${runId}.json`),
      ).value;
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "not_found") return undefined;
      throw error;
    }
  };

  const decomposeTask = async (
    task: string,
    complexity?: Complexity,
  ): Promise<DecompositionResult> => {
    const config = buildConfig(task, complexity);
    if (config.roles.planner === undefined) {
      throw new OrchestratorError(
        "no_active_session",
        "planner",
        "decomposition requires a planner role",
      );
    }
    const workflow = createWorkflowSession(config);
    const isolated = new RunCoordinator(workflow, workflow.projectStore, config.coordinator);
    const before = sink.records().length;
    const prepared = await isolated.prepareStep();
    if (
      prepared === undefined ||
      prepared.result.phase !== "plan" ||
      prepared.result.plan === undefined
    ) {
      throw new OrchestratorError(
        "no_active_session",
        "plan",
        "planner did not return a decomposition",
      );
    }
    const cost = recordStep("plan", before, sink.records().length);
    return { plan: prepared.result.plan, text: prepared.result.text, cost };
  };

  const beginStepping = (task: string, complexity?: Complexity): void => {
    const config = buildConfig(task, complexity);
    session = createWorkflowSession(config);
    coordinator = new RunCoordinator(session, session.projectStore, config.coordinator);
    state = session.initialState();
    pending = undefined;
  };

  const isStepping = (): boolean => session !== undefined && state !== undefined && !state.done;

  const stepOnce = async (): Promise<StepView> => {
    if (session === undefined || state === undefined) {
      throw new OrchestratorError(
        "no_active_session",
        "stepOnce",
        "no stepping run in progress; call beginStepping first",
      );
    }
    if (state.done) {
      throw new OrchestratorError(
        "no_active_session",
        "done",
        "the stepping run has already settled",
      );
    }
    if (pending !== undefined) {
      throw new OrchestratorError(
        "awaiting_transition",
        "stepOnce",
        "a step is awaiting a transition choice; call chooseTransition first",
      );
    }
    const before = sink.records().length;
    const stepResult = await (coordinator as RunCoordinator).prepareStep();
    if (stepResult === undefined) {
      throw new OrchestratorError("no_active_session", "done", "the stepping run has settled");
    }
    const after = sink.records().length;
    recordStep(stepResult.result.phase, before, after);
    state = stepResult.state;
    pending = stepResult.transitions;
    return {
      phase: stepResult.result.phase,
      runId: stepResult.result.runId,
      text: stepResult.result.text,
      ...(stepResult.result.verdict !== undefined && { verdict: stepResult.result.verdict }),
      ...(stepResult.result.plan !== undefined && { plan: stepResult.result.plan }),
      transitions: stepResult.transitions.map((t) => t.kind),
    };
  };

  const chooseTransition = (kind: TransitionKind, _rationale?: string): WorkflowPhase => {
    if (pending === undefined || state === undefined) {
      throw new OrchestratorError(
        "no_pending_transition",
        "chooseTransition",
        "no step is awaiting a transition choice; call stepOnce first",
      );
    }
    // The model authored only a KIND. Resolve it against the engine-authored
    // offered set -- whose toPhase/toRound are trustworthy -- and NEVER fabricate
    // a target. A kind not present is a hard, loud rejection carrying only the
    // kind.
    const resolved = pending.find((t) => t.kind === kind);
    if (resolved === undefined) {
      throw new DriveError(
        "transition_not_offered",
        kind,
        "chosen transition kind was not offered by the step",
      );
    }
    assertTransitionOffered(resolved, pending);
    state = (coordinator as RunCoordinator).commitTransition(resolved);
    pending = undefined;
    return state.phase;
  };

  const foregroundProjection = (checkpoint: RunCheckpoint): ForegroundRunProjection => {
    const metrics = checkpoint.workflowState.stageMetrics ?? [];
    const pause = checkpoint.pause === undefined ? undefined : structuredClone(checkpoint.pause);
    const base = {
      runId: checkpoint.runId,
      foreground: true as const,
      phase: checkpoint.workflowState.phase,
      round: checkpoint.workflowState.round,
      metrics: {
        steps: metrics.length,
        totalCost: metrics.reduce((sum, metric) => sum + (metric.costUsd ?? 0), 0),
      },
      ...(pause === undefined ? {} : { pause }),
      actions: {
        status: "applicable" as const,
        result: "applicable" as const,
        events: "not_applicable" as const,
        cancel: "not_applicable" as const,
      },
    };
    if (checkpoint.closeout !== undefined) {
      const lastVerdict = checkpoint.closeout.pipeline.verdicts.at(-1);
      return {
        ...base,
        lifecycle: "completed",
        outcome: checkpoint.closeout.pipeline.outcome,
        approved: checkpoint.closeout.pipeline.approved,
        rounds: checkpoint.closeout.pipeline.rounds,
        ...(lastVerdict === undefined ? {} : { verdict: lastVerdict.status }),
      };
    }
    if (pause !== undefined) return { ...base, lifecycle: "paused" };
    return {
      ...base,
      lifecycle: "pending",
      message: "This foreground run has no outcome yet; it is still pending.",
    };
  };
  const foregroundStatus = (runId: string): ForegroundRunProjection | undefined => {
    const checkpoint = readForeground(runId);
    return checkpoint === undefined ? undefined : foregroundProjection(checkpoint);
  };
  const foregroundExists = (runId: string): boolean => readForeground(runId) !== undefined;

  const showCost = (): CostReport => {
    let totalCost = 0;
    for (const record of sink.records()) {
      totalCost += record.usage.cost.total;
    }
    return {
      perStep: [...cumulative],
      totalCost,
      ...(deps.sessionLimitController !== undefined && {
        sessionLimits: deps.sessionLimitController.snapshot(),
      }),
    };
  };

  return {
    runPipeline,
    resumePipeline,
    decomposeTask,
    beginStepping,
    stepOnce,
    chooseTransition,
    showCost,
    backgroundRuns,
    isStepping,
    foregroundStatus,
    foregroundExists,
  };
}

/**
 * Project any error into a transcript-safe one-line string.
 *
 * SECURITY (data_exposure) + the errors contract (2026-09-16): the tool
 * handlers return text the model reads and the ledger/transcript captures, and
 * a rejection must CARRY ITS REASON, not collapse to a code. The two demands
 * are resolved by three ordered projections, each safe by construction:
 *
 * 1. `code`+`detail` passthrough. The errors seen here with a safe `code` and
 *    a names-only `detail` (`DriveError`, `OrchestratorError`,
 *    `OrchestrationError`, and the config-layer `RegistryError`/`ProfileError`)
 *    surface exactly those two. Unchanged shape (compat:
 *    `error: code (detail)`).
 * 2. Known house classes, matched BY CLASS, message included: classes whose
 *    message is an AUTHORED string -- fixed wording, numbers, a validated run
 *    id, or a harness-authored code token, never `String(error)` or an
 *    uncontrolled field. Rendered `error: code (authored message)`. Every new
 *    candidate must be audited field-by-field before entering the list;
 *    `WorkflowStageFailureError` is deliberately EXCLUDED because its message
 *    re-wraps an uncontrolled source error (a leaking member would poison the
 *    whole projection).
 * 3. Constructor-name fallback: an unrecognised error still names its
 *    constructor (`(TypeError)`) -- a bounded inert token, never paths,
 *    payloads, or a message. That is the "one word that ends the
 *    investigation" the fixed string denied #236 and #237, while the fixed
 *    generic text itself stays (compat).
 */
const SAFE_RESEARCH_REQUIRED_CONTRACT_IDS_PREFIX =
  /^coverage\[\d+\]\.contractIds must be non-empty when status is "research_required"; resubmit with canonical contract IDs/;

function safeErrorText(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "malformed_plan" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const prefix = SAFE_RESEARCH_REQUIRED_CONTRACT_IDS_PREFIX.exec(
      (error as { message: string }).message,
    )?.[0];
    if (prefix !== undefined) return `error: malformed_plan (${prefix})`;
  }
  // `malformed_plan` is the one typed error whose authored message names the
  // rejected field and the repair. Keep that message at this boundary, but
  // only after matching the validator's fixed message vocabulary. Do not add
  // OrchestrationError to SAFE_HOUSE_ERRORS: its other messages are not all
  // safe to expose, and this must never become an arbitrary Error.message
  // projection.
  if (
    error instanceof OrchestrationError &&
    error.code === "malformed_plan" &&
    SAFE_MALFORMED_PLAN_MESSAGE.test(error.message)
  ) {
    return `error: ${error.code} (${error.detail}): ${error.message}`;
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string" &&
    "detail" in error &&
    typeof (error as { detail: unknown }).detail === "string"
  ) {
    const e = error as { code: string; detail: string };
    return `error: ${e.code} (${e.detail})`;
  }
  if (error instanceof Error) {
    for (const house of SAFE_HOUSE_ERRORS) {
      if (!(error instanceof house)) continue;
      // The allow-list above guarantees: `code` is an authored literal or a
      // validated token, `message` is authored-safe, and `runId` only exists on
      // classes whose constructor validated it (`assertRunId`) before any
      // projection.
      const e = error as Error & { code?: unknown; message: string; runId?: unknown };
      const code = typeof e.code === "string" ? e.code : undefined;
      const runId = typeof e.runId === "string" ? e.runId : undefined;
      const tail = runId !== undefined ? `; run ${runId}` : "";
      return code === undefined
        ? `error: ${house.name} (${e.message}${tail})`
        : `error: ${code} (${e.message}${tail})`;
    }
    const unrecognised =
      error.constructor === undefined || error.constructor.name === ""
        ? error.name
        : error.constructor.name;
    if (typeof unrecognised === "string" && SAFE_NAME_PATTERN.test(unrecognised)) {
      return `error: an unexpected internal error occurred (${unrecognised})`;
    }
  }
  return "error: an unexpected internal error occurred";
}

const SAFE_NAME_PATTERN = /^[\w$.-]{1,64}$/;

// These are the structural messages authored by parsePlan/parsePlanText. The
// only interpolated values are bounded indexes/counts; plan values, task text,
// paths, and provider/exception messages do not match this allow-list.
const SAFE_CONTRACT_IDS = Object.keys(CONTRACT_INDEX).join(", ");
const SAFE_MALFORMED_PLAN_MESSAGE = new RegExp(
  [
    "plan is not an object",
    "plan\\.(?:complexity|securitySurface) must be one of (?:trivial, medium, complex|none, low, elevated)",
    "plan\\.summary must be a string",
    "plan\\.(?:contractRequirements|affectedFiles) must be an array of non-empty strings",
    "surfaceAnalysis (?:exceeds (?:aggregate byte|nesting) limit|must be an object)",
    "surfaceAnalysis\\.projectType is required",
    "surfaceAnalysis\\.surfaces exceeds the configured item limit",
    "surfaces\\[\\d+\\]\\.\\w+ (?:is not an object|must be a non-empty string)",
    "surface ids must be unique",
    "coverage must contain exactly one entry per surface",
    "coverage\\[\\d+\\]\\.\\w+ must be (?:a non-empty string|one of covered, not_applicable, research_required|bounded non-empty strings)",
    'coverage\\[\\d+\\] is "covered" and requires contractIds and evidence',
    'coverage\\[\\d+\\] is "not_applicable" and requires evidence and no contracts',
    'coverage\\[\\d+\\] is "research_required" and requires evidence of the gap',
    'coverage\\[\\d+\\]\\.contractIds must be non-empty when status is "research_required"; resubmit with canonical contract IDs',
    `coverage\\[\\d+\\]\\.contractIds contains \\d+ unknown id\\(s\\); known ids are ${SAFE_CONTRACT_IDS}`,
    "planner JSON handoff is (?:invalid|truncated: the submitted object never closes)",
    "planner text contains more than one distinct plan; submit exactly one",
  ]
    .map((pattern) => `^(?:${pattern})$`)
    .join("|"),
);

const SAFE_HOUSE_ERRORS = [
  // Field-by-field audit (errors contract 2026-09-19 / issue #418):
  // `code` is the authored literal `empty_turn`; `providerCode` is the
  // harness-composed failure code (e.g. `assistant_error`);
  // `providerStatus` is a safe integer the constructor BOUNDS to 400..599
  // and otherwise DROPS (recording only -- it moves no class boundary);
  // `providerErrorCode` is the strict-charset token
  // (`[A-Za-z0-9_.-]{1,64}`, length-capped, prose/URLs impossible), likewise
  // dropped otherwise; `runId` is validated by `assertRunId` before any
  // projection. `message` is an AUTHORED string splicing only those bounded
  // fields -- provider prose and response bodies never cross, and when no
  // non-credential status was parsed the message stays verbatim the pinned
  // "verify authentication and retry" wording.
  EmptyTurnError,
  ProviderRejectionError,
  // Field-by-field audit (errors contract 2026-09-16 / 2026-09-19):
  // `code` is the authored literal `provider_quota`; `status` is the literal
  // 429; `providerCode` is a strict-charset token
  // (`[A-Za-z0-9_.-]{1,64}`, length-capped, prose/URLs impossible) extracted
  // from the body, never its prose; `retryAfterMs` is a safe-integer delay
  // bounded by MAX_PROVIDER_RETRY_HINT_MS; `runId` is validated by
  // `assertRunId` before any projection. `message` is an AUTHORED string
  // splicing only those bounded fields.
  ProviderQuotaError,
  // Field-by-field audit (errors contract 2026-09-19): `code` is the authored
  // literal `generation_truncated`; `stopReason` is a strict-charset token
  // (`[A-Za-z0-9_-]{1,32}`) bounded by the constructor, which DROPS a
  // non-matching value; `outputTokens`/`reasoningTokens` are safe
  // non-negative integers, likewise dropped otherwise; `runId` is validated by
  // `assertRunId` before any projection. `message` is an AUTHORED string
  // splicing only those bounded fields. The thinking prose and every other
  // transcript value stay in the session.
  GenerationTruncatedError,
  ConfiguredToolsUnavailableError,
  ProviderLimitError,
  RunInterruptedError,
  SuspendedRunError,
  RunnerError,
  SessionLimitError,
  TurnInterruptedError,
  StageLimitError,
  StageCloseoutError,
  CostAnomalyBlockedError,
] as const;

/** Render a `StepCost[]` + total as a compact, safe cost summary. */
function formatCost(
  perStep: StepCost[],
  totalCost: number,
  sessionLimits?: Readonly<SessionLimitSnapshot>,
): string {
  const lines = perStep.map((e) => `  step ${e.step} ${e.phase}: ${e.cost}`);
  if (sessionLimits !== undefined) {
    lines.push(
      `session limits: turns ${sessionLimits.admittedTurns}/${sessionLimits.maxTurns}, ` +
        `cost ${sessionLimits.observedCostUsd}/${sessionLimits.maxCostUsd}, ` +
        `in-flight ${sessionLimits.costInFlight}, terminal ${sessionLimits.terminalReason ?? "none"}`,
    );
  }
  return [`total cost: ${totalCost}`, ...lines].join("\n");
}

/** The last verdict's status, or `not_run` when a settled run had no review. */
function lastReviewStatus(result: PipelineResult): string {
  if (result.reviewRan === false) return "not_run";
  return result.verdicts[result.verdicts.length - 1]?.status ?? "not_run";
}

/** Gate summary for one settled run: the operator reads which blocker fired. */
function lastGateStatus(result: PipelineResult): string {
  const report = result.gateReport;
  if (report === undefined) return "not_run";
  return report.passed
    ? "pass"
    : `fail(${report.results
        .filter((r) => !r.passed)
        .map((r) => r.name)
        .join(",")})`;
}

/** Compact provider-reported stage totals; no prompts, paths, or model text. */
function formatStageMetrics(result: PipelineResult): string {
  const totals = result.stageMetrics.reduce(
    (sum, metric) => ({
      durationMs: sum.durationMs + (metric.durationMs ?? 0),
      input: sum.input + metric.input,
      cached: sum.cached + metric.cachedInput,
      fresh: sum.fresh + metric.freshInput,
      output: sum.output + metric.output,
      reasoning: sum.reasoning + (metric.reasoning ?? 0),
      cost: sum.cost + (metric.costUsd ?? 0),
    }),
    { durationMs: 0, input: 0, cached: 0, fresh: 0, output: 0, reasoning: 0, cost: 0 },
  );
  return (
    `stage metrics: durationMs=${totals.durationMs} input=${totals.input} ` +
    `fresh=${totals.fresh} cached=${totals.cached} output=${totals.output} ` +
    `reasoning=${totals.reasoning} providerCost=${totals.cost}`
  );
}

/**
 * Live execution facts the orchestrator model must not have to infer: which
 * worker roles this session actually has and on which models, plus which
 * workflow modules are enabled. Assembled from the resolved config -- the same
 * facts the startup banner prints -- so a session's world is stated, not
 * inferred from which tools happen to appear.
 */
export interface RunRoleSessionFacts {
  route: DelegatedRoute;
  workflows: readonly string[];
}

/** One line per reachable delegate target; absent names collapse into one clause. */
export function formatDelegatedRoute(route: DelegatedRoute): string {
  const groups = route.groups
    .map((group) => `${group.model}: ${group.roles.join(", ")}`)
    .join(" | ");
  const unreachable =
    route.unreachable.length > 0 ? ` | not configured: ${route.unreachable.join(", ")}` : "";
  return `${route.source} | complexity "${route.complexity}" | ${groups}${unreachable}`;
}

/**
 * The advisory that keeps a run_role review from reading as gate evidence
 * (issue #376). A delegated conversation delivers by assistant text only -- the
 * handler registers no submission tools (issue #236) -- so no structured
 * verdict exists on that path, `recordReviewStampFromResult` is never reached,
 * and the pre-merge gate `bun run stamp:check` sees no stamp. The description
 * variant and the result-text framing below must keep naming the gate and the
 * two settle paths that DO write the stamp; transcribing a verdict out of the
 * delegated prose would forge the gate's evidence.
 */
const RUN_ROLE_REVIEWER_DESCRIPTION_ADVISORY =
  "A reviewer run through this tool is advisory: it delivers prose, writes no review stamp, and cannot satisfy the pre-merge gate `bun run stamp:check` -- gate-satisfying review rounds must come from a settle path that produces a structured verdict and writes the stamp (the built-in pipeline's review stage, or the standalone `ad-coder role reviewer` CLI).";

const RUN_ROLE_REVIEWER_RESULT_ADVISORY =
  "review advisory: this run_role review delivered prose only, wrote no review stamp, and cannot satisfy the pre-merge gate `bun run stamp:check` -- gate-satisfying review rounds must come from a settle path that produces a structured verdict and writes the stamp (the built-in pipeline's review stage, or the standalone `ad-coder role reviewer` CLI).";

/**
 * The reviewer-side framing for one trivial-edit cover turn (issue #388).
 *
 * Stated HERE and not imported from the CLI on purpose: the cover is an
 * orchestrator-front seam, the CLI's standalone framing is a different
 * surface, and importing across the fronts would couple them for one
 * paragraph (and risk an import cycle through `src/cli.ts`). The framing
 * states what a reviewer cannot infer from its pipeline prompt: that this is
 * an independent invocation over the ORCHESTRATOR'S OWN bounded trivial edit,
 * that `submit_verdict` IS registered here and is the way to settle, and that
 * the task carries paths and counts only -- the file's content is read, never
 * pasted (docs/contracts/errors.md).
 */
const TRIVIAL_EDIT_COVER_FRAMING = [
  "This is an independent reviewer invocation covering the orchestrator's own bounded trivial edit (issue #388): a machine-measured change of at most one file and five changed lines that the orchestrator applied directly, recorded in the run's trivial-edit record.",
  `The ${SUBMIT_VERDICT_TOOL_NAME} tool IS registered in this conversation and is the way to settle: submit the verdict through it, and it is recorded like any other stage verdict.`,
  "The task names the change (tool, file, +added/-removed lines) and the uncovered window as the guard reports them -- never file contents. Inspect the file's CURRENT content with the read tool before settling.",
].join("\n");

/** Build general role delegation; unlike workflow tools this remains available with no module. */
export function buildRunRoleTool(
  runRole: (
    role: DelegatableRoleName,
    task: string,
    complexity?: Complexity,
  ) => Promise<DelegatedRoleResult>,
  sessionFacts?: RunRoleSessionFacts,
): Tool {
  // With session facts the description carries the live routing; the fallback
  // keeps the plain role list for hosts that build the tool outside a resolved
  // session. Static role knowledge lives in the role-selection skill either way.
  const description =
    sessionFacts === undefined
      ? `Run one shipped worker role independently and get its result as assistant text. Available roles: planner, researcher, security, coder, reviewer, auditor. This does not start or advance a workflow. Pass the complexity you classified this task at as the optional complexity parameter so the delegate routes on your assessment, not the default. ${RUN_ROLE_REVIEWER_DESCRIPTION_ADVISORY}`
      : `Run one shipped worker role independently and get its result as assistant text. This does not start or advance a workflow. This session runs in ${
          sessionFacts.workflows.length > 0
            ? `roles plus workflow mode (${sessionFacts.workflows.join(", ")})`
            : "roles-only mode (no workflow module is enabled; there is no pipeline to start)"
        }. Reachable delegates and their resolved models -- the same facts the startup banner prints -- are:

${formatDelegatedRoute(sessionFacts.route)}

Only the roles named above are callable; calling a "not configured" role fails with invalid_role. Load the role-selection skill for what each role does, returns, and when delegation is the wrong call. Pass the complexity you classified this task at as the optional complexity parameter (issues #263/#264) so the delegate routes on your assessment, not the default. ${RUN_ROLE_REVIEWER_DESCRIPTION_ADVISORY}`;
  return defineTool({
    name: RUN_ROLE_TOOL_NAME,
    description,
    label: "run role",
    parameters: Type.Object({
      role: Type.String(),
      task: Type.String(),
      // The orchestrator's own pre-read classification (issues #263/#264):
      // optional so a host that never classifies keeps today's behavior, but
      // present so an assessment can replace the constant default at the
      // routing sink instead of dying in prose.
      complexity: Type.Optional(
        Type.Union([Type.Literal("trivial"), Type.Literal("medium"), Type.Literal("complex")]),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        if (!(DELEGATABLE_ROLE_NAMES as readonly string[]).includes(params.role)) {
          throw new OrchestratorError(
            "invalid_role",
            params.role,
            `unknown delegated role; expected one of ${DELEGATABLE_ROLE_NAMES.join(", ")}`,
          );
        }
        const result = await runRole(
          params.role as DelegatableRoleName,
          params.task,
          params.complexity,
        );
        // Do not claim "complete" for a stage that entered its closeout
        // reserve; the reason rides in the text the model reads (issue #327).
        const closeout = result.stageCloseout;
        // A reviewer delegation is advisory only (issue #376): the delegated
        // conversation delivers prose with no structured verdict, so nothing
        // settles and no stamp is written. The advisory rides in BOTH branches
        // -- a closed-out reviewer has no verdict at all and must never read
        // as an approval -- while every other role keeps today's text.
        const reviewAdvisory =
          result.role === "reviewer" ? `\n${RUN_ROLE_REVIEWER_RESULT_ADVISORY}` : "";
        return {
          content: [
            {
              type: "text",
              text:
                closeout === undefined
                  ? `${result.role} complete (cost ${result.cost})\n${result.text || "(no text)"}${reviewAdvisory}`
                  : `${result.role} closed out early (cost ${result.cost}) stage_closeout reason=${closeout.reason} detail=${closeout.detail}\n${result.text || "(no text)"}${reviewAdvisory}`,
            },
          ],
          details: undefined,
        };
      } catch (error) {
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });
}

/**
 * Build the four tools that let an orchestrator model drive the workflow.
 *
 * The handlers are thin marshallers ONLY: args -> core -> safe text, no
 * orchestration logic. Each catches every throw and projects it through
 * `safeErrorText`, because the harness surfaces a tool result's text to the
 * model and a raw error could leak a path or a message. The schemas expose ONLY
 * `{task}` / `{task?}` / `{kind, rationale?}` / `{}` -- never `targetDir`, a
 * path, a provider/registry override, or a `toPhase`/`toRound` -- so the trust
 * boundary (fixed targetDir, engine-authored transitions) cannot be widened from
 * a tool call. Leaves are permissive `Type.String()` so the core's own guards
 * stay the gate, mirroring `buildSubmitVerdictTool`.
 */
export function buildBuiltInPipelineTools(core: Orchestrator): Tool[] {
  const decomposeTaskTool = defineTool({
    name: DECOMPOSE_TASK_TOOL_NAME,
    description:
      "Run only the Planner and return a structured decomposition with affected surfaces and contract coverage. Does not dispatch Coder or alter a manual workflow.",
    label: "decompose task",
    parameters: Type.Object({
      task: Type.String(),
      // Pre-read classification (issues #263/#264): replaces the default-
      // complexity fallback so pre-plan routing is an assessment.
      complexity: Type.Optional(
        Type.Union([Type.Literal("trivial"), Type.Literal("medium"), Type.Literal("complex")]),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = await core.decomposeTask(params.task, params.complexity);
        return {
          content: [
            {
              type: "text",
              text: [
                `complexity: ${result.plan.complexity}`,
                `security surface: ${result.plan.securitySurface}`,
                `summary: ${result.plan.summary}`,
                `surfaces: ${result.plan.surfaceAnalysis.surfaces.map(({ name }) => name).join(", ")}`,
                `planner cost: ${result.cost.cost}`,
              ].join("\n"),
            },
          ],
          details: result.plan,
        };
      } catch (error) {
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  /**
   * Parse the tool's three loose fields into a raise, or refuse by name.
   *
   * The fields arrive as free strings from a model, so "all three or none" is
   * checked here where the shape is still three parameters; the resulting
   * object is validated by `assertRaisedLimits` at the core boundary like any
   * other caller's.
   */
  const raisedLimitsFrom = (
    role: string | undefined,
    reason: string | undefined,
    limit: number | undefined,
  ): RaisedStageLimits | undefined => {
    if (role === undefined && reason === undefined && limit === undefined) return undefined;
    if (role === undefined || reason === undefined || limit === undefined)
      throw new OrchestratorError(
        "invalid_raise",
        "raiseRole, raiseReason and raiseLimit are supplied together or not at all",
        "a partial raise cannot name a ceiling",
      );
    return assertRaisedLimits({
      role: role as ProfileRole,
      reason: reason as StageLimitReason,
      limit,
    });
  };

  const runPipelineTool = defineTool({
    name: RUN_PIPELINE_TOOL_NAME,
    description:
      "Run a full autonomous pipeline (plan -> [security] -> code <-> review) for a task and report the outcome and cost. Executes code within the fixed working directory.",
    label: "run pipeline",
    parameters: Type.Object({
      task: Type.String(),
      // Pre-read classification (issues #263/#264): replaces the default-
      // complexity fallback so pre-plan routing is an assessment.
      complexity: Type.Optional(
        Type.Union([Type.Literal("trivial"), Type.Literal("medium"), Type.Literal("complex")]),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const run = await core.runPipeline(params.task, params.complexity);
        const summary =
          `pipeline complete: runId=${run.runId} approved=${run.result.approved} ` +
          `rounds=${run.result.rounds} review=${lastReviewStatus(run.result)} ` +
          `gates=${lastGateStatus(run.result)}`;
        return {
          content: [
            {
              type: "text",
              text: `${summary}\n${formatStageMetrics(run.result)}\n${formatCost(run.perStep, run.totalCost)}`,
            },
          ],
          details: undefined,
        };
      } catch (error) {
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  const startPipelineTool = defineTool({
    name: START_PIPELINE_TOOL_NAME,
    description:
      "Start the built-in pipeline in an isolated background conversation and return immediately. The only parameter is untrusted task data.",
    label: "start pipeline",
    parameters: Type.Object({ task: Type.String() }),
    async execute(_toolCallId, params) {
      try {
        const started = await core.backgroundRuns.startDetached(params.task);
        return {
          content: [{ type: "text", text: `pipeline requested: runId=${started.runId}` }],
          details: undefined,
        };
      } catch (error) {
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  const pipelineStatusTool = defineTool({
    name: PIPELINE_STATUS_TOOL_NAME,
    description:
      "Read safe lifecycle and aggregate metrics for a background pipeline owned by this conversation. A paused run is reported as lifecycle 'paused' with the pause record (phase, code, action) and the limiting stage reason -- it is resumable, not failed -- and the metrics already name what the run spent.",
    label: "pipeline status",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_toolCallId, params) {
      try {
        const status = core.backgroundRuns.status(params.runId);
        return { content: [{ type: "text", text: JSON.stringify(status) }], details: undefined };
      } catch (error) {
        const foreground = core.foregroundStatus(params.runId);
        if (foreground !== undefined)
          return {
            content: [{ type: "text", text: JSON.stringify(foreground) }],
            details: undefined,
          };
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  const pipelineEventsTool = defineTool({
    name: PIPELINE_EVENTS_TOOL_NAME,
    description: "Consume a bounded page of content-free lifecycle events after a cursor.",
    label: "pipeline events",
    parameters: Type.Object({
      runId: Type.String(),
      cursor: Type.Number(),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      try {
        const page = core.backgroundRuns.events(params.runId, params.cursor, params.limit);
        return { content: [{ type: "text", text: JSON.stringify(page) }], details: undefined };
      } catch (error) {
        if (core.foregroundExists(params.runId))
          return {
            content: [
              {
                type: "text",
                text: "error: foreground_run (pipeline_events does not apply: a foreground run has no event log or separate process)",
              },
            ],
            details: undefined,
          };
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  const pipelineResultTool = defineTool({
    name: PIPELINE_RESULT_TOOL_NAME,
    description:
      "Read terminal outcome and aggregate usage for a background pipeline owned by this conversation. A run paused on a stage limit is also reported here: lifecycle 'paused', the pause record, and real spent metrics -- the pause reaches this surface exactly like a completed run's outcome does.",
    label: "pipeline result",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_toolCallId, params) {
      try {
        const run = core.backgroundRuns.result(params.runId);
        return {
          content: [{ type: "text", text: JSON.stringify(run) }],
          details: undefined,
        };
      } catch (error) {
        const foreground = core.foregroundStatus(params.runId);
        if (foreground !== undefined)
          return {
            content: [{ type: "text", text: JSON.stringify(foreground) }],
            details: undefined,
          };
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  const cancelPipelineTool = defineTool({
    name: CANCEL_PIPELINE_TOOL_NAME,
    description: "Cancel a background pipeline owned by this conversation.",
    label: "cancel pipeline",
    parameters: Type.Object({ runId: Type.String() }),
    async execute(_toolCallId, params) {
      try {
        return {
          content: [
            { type: "text", text: JSON.stringify(core.backgroundRuns.cancel(params.runId)) },
          ],
          details: undefined,
        };
      } catch (error) {
        if (core.foregroundExists(params.runId))
          return {
            content: [
              {
                type: "text",
                text: "error: foreground_run (cancel_pipeline does not apply: a foreground run has no separate process to cancel)",
              },
            ],
            details: undefined,
          };
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  const resumePipelineTool = defineTool({
    name: RESUME_PIPELINE_TOOL_NAME,
    description:
      "Resume an interrupted built-in pipeline from its durable run ID using the original task. Completed stages are reused. A run paused on a stage ceiling CANNOT resume at the same ceiling -- pass raiseRole (the role whose stage paused), raiseReason and raiseLimit (the pause reports the reason and the exhausted value) to resume with a larger one, which is the correction the operator-flow contract requires for an underestimate on progressing work.",
    label: "resume pipeline",
    parameters: Type.Object({
      task: Type.String(),
      runId: Type.String(),
      raiseRole: Type.Optional(Type.String()),
      raiseReason: Type.Optional(Type.String()),
      raiseLimit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      try {
        const raised = raisedLimitsFrom(params.raiseRole, params.raiseReason, params.raiseLimit);
        const run = await core.resumePipeline(params.task, params.runId, raised);
        const summary =
          `pipeline complete: runId=${run.runId} approved=${run.result.approved} ` +
          `rounds=${run.result.rounds} review=${lastReviewStatus(run.result)} ` +
          `gates=${lastGateStatus(run.result)}`;
        return {
          content: [
            {
              type: "text",
              text: `${summary}\n${formatStageMetrics(run.result)}\n${formatCost(run.perStep, run.totalCost)}`,
            },
          ],
          details: undefined,
        };
      } catch (error) {
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  const runStepTool = defineTool({
    name: RUN_STEP_TOOL_NAME,
    description:
      "Run the next single workflow step. Provide a task to begin a new stepping run; omit it to continue the run in progress. Returns the step result and the transition kinds now on offer.",
    label: "run step",
    parameters: Type.Object({
      task: Type.Optional(Type.String()),
      // Pre-read classification (issues #263/#264), applied only when a task
      // starts a new stepping run.
      complexity: Type.Optional(
        Type.Union([Type.Literal("trivial"), Type.Literal("medium"), Type.Literal("complex")]),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        if (!core.isStepping()) {
          if (params.task === undefined) {
            throw new OrchestratorError(
              "no_active_session",
              "run_step",
              "no stepping run in progress; provide a task to begin one",
            );
          }
          core.beginStepping(params.task, params.complexity);
        }
        const view = await core.stepOnce();
        const lines = [
          `step ${view.phase} (runId ${view.runId})`,
          view.text.trim() === "" ? "(no text)" : view.text,
        ];
        if (view.verdict !== undefined) {
          lines.push(`verdict: ${view.verdict.status}`);
        }
        lines.push(`offered transitions: ${view.transitions.join(", ")}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
      } catch (error) {
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  const chooseTransitionTool = defineTool({
    name: CHOOSE_TRANSITION_TOOL_NAME,
    description:
      "Commit one of the transition kinds the last step offered (advance / rework / stop). The optional rationale is recorded as data only.",
    label: "choose transition",
    parameters: Type.Object({ kind: Type.String(), rationale: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try {
        // `kind` is untrusted: the core resolves it against the offered set and
        // rejects an unoffered kind. `rationale` is echoed back as data only,
        // never interpolated into a shell/path/URL sink.
        const phase = core.chooseTransition(params.kind as TransitionKind, params.rationale);
        const note = params.rationale !== undefined ? ` (rationale: ${params.rationale})` : "";
        return {
          content: [
            { type: "text", text: `transition ${params.kind} committed; now at ${phase}${note}` },
          ],
          details: undefined,
        };
      } catch (error) {
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  const showCostTool = defineTool({
    name: SHOW_COST_TOOL_NAME,
    description: "Report the cumulative per-step and total cost of the session so far.",
    label: "show cost",
    parameters: Type.Object({}),
    async execute(_toolCallId) {
      try {
        const report = core.showCost();
        return {
          content: [
            {
              type: "text",
              text: formatCost(report.perStep, report.totalCost, report.sessionLimits),
            },
          ],
          details: undefined,
        };
      } catch (error) {
        return { content: [{ type: "text", text: safeErrorText(error) }], details: undefined };
      }
    },
  });

  return [
    runPipelineTool,
    resumePipelineTool,
    startPipelineTool,
    pipelineStatusTool,
    pipelineEventsTool,
    pipelineResultTool,
    cancelPipelineTool,
    decomposeTaskTool,
    runStepTool,
    chooseTransitionTool,
    showCostTool,
  ];
}

/** Compose general plugins with only the workflow modules explicitly enabled by the host. */
export function buildOrchestratorTools(
  core: Orchestrator | undefined,
  pluginTools: Tool[] = buildWebTools(),
  workflowModules: readonly OrchestratorWorkflowModule[] = [],
): Tool[] {
  if (workflowModules.length > 0 && core === undefined)
    throw new Error("enabled workflow modules require an orchestrator core");
  return [
    ...pluginTools,
    ...workflowModules.flatMap((module) => module.buildTools(core as Orchestrator)),
  ];
}

/**
 * Everything `startOrchestrator` needs to assemble the conversational front.
 * It is the pipeline config surface MINUS `task` (which arrives per-run through
 * the tools): a fixed `targetDir` plus the optional provider/model/env knobs
 * `resolvePipelineConfig` accepts. `targetDir` is the ONE trust anchor -- it is
 * closed over here and never a tool parameter.
 */
export type OrchestratorConfig = Omit<ResolvePipelineConfigOptions, "task"> & {
  /**
   * Run id for the orchestrator's own conversation AND for the session ledger
   * file. A front that wants to point at the evidence before the first turn
   * (or to resume onto the same file) supplies it; otherwise one is minted.
   */
  runId?: string;
  /**
   * Ledger rows a resumed front replays into its readable sink's cost view,
   * read back from the ledger file a previous process wrote. Seeding fills
   * only the in-memory view (the rows are already on the append-only mirror
   * file); absent means a fresh session with an empty cost view.
   */
  seedLedgerRecords?: readonly import("../ledger/types").LedgerRecord[];
  /** Explicit lazy skills for this managed conversation; absent means none. */
  selectedSkills?: readonly string[];
  /** Explicit off: no catalogue, no loader, no appendix for any role. */
  skillsDisabled?: boolean | undefined;
  sessionLimits?: SessionLimits;
  /** Optional construction seam for embedding hosts that own the conversation lifecycle. */
  startConversation?: typeof startConversationImpl;
  /** Independent worker-session seam; defaults to the same headless conversation constructor. */
  startDelegatedConversation?: typeof startConversationImpl;
  workflowModules?: readonly OrchestratorWorkflowModule[];
  /** Public limits for asynchronous pipeline workers; omitted values use bounded defaults. */
  backgroundRuns?: Partial<BackgroundRunLimits>;
  /** Stable opaque owner scope for durable reconnect; defaults to a fresh conversation scope. */
  backgroundOwnerId?: string;
  /** CLI or embedding host provider for detached start_pipeline work. */
  backgroundHostLauncher?: import("./background-runs").BackgroundHostLauncher;
  /** Injection seam for tests/embedders to own the background-run executor; defaults to the real pipeline executor. */
  backgroundRunExecutor?: BackgroundRunExecutor;
  /** Empty by default: the built-in pipeline is shipped but opt-in. */
  enabledWorkflows?: readonly string[];
};

/**
 * Assemble the conversational orchestrator front over a headless core.
 *
 * Wires `resolvePipelineConfig` (the per-task `buildConfig` factory and the SOLE
 * credential surface -- keys resolve only through its injected `env` accessor,
 * never `targetDir/.env`), the target-aware `resolvePrompt('orchestrator')`, and
 * `startConversation` with the four orchestrator tools, all sharing ONE
 * `MemoryLedgerSink` so `show_cost` reads every turn's cost. The orchestrator's
 * own conversation model, window budget, and `Models` come from that same
 * resolved config, so provider auth stays on one surface.
 *
 * SECURITY: `run_pipeline` is code-execution-capable within `targetDir` (a
 * starting cwd, not a sandbox): the pipeline's coder holds bash/write/edit there.
 * The model authors only the `task` string, threaded as prompt DATA via
 * `PipelineConfig.task` -- never interpolated into a shell command, path, or URL.
 */
export async function startOrchestrator(config: OrchestratorConfig): Promise<ConversationSession> {
  // ONE file for the whole orchestrated session, named after the orchestrator's
  // own run. The shared in-memory sink is what `show_cost` and the per-step cost
  // arithmetic read back, but it MIRRORS to that file so a conversational front
  // leaves the same audit trail `ad-coder role` does -- every delegated
  // `run_role` row lands there too, each carrying its own runId and its
  // `role:<name>` step, which is what later makes the delegation provable.
  const orchestratorRunId = config.runId ?? crypto.randomUUID();
  const ledgerPath = path.join(
    config.targetDir,
    ".ad-coder",
    "ledger",
    `${orchestratorRunId}.jsonl`,
  );
  const sink = new MemoryLedgerSinkImpl(
    new FileLedgerSink(ledgerPath, config.projectStoreConfig?.byteLimits?.jsonlRecord ?? 0),
  );
  // A resumed front replays prior rows into its OWN READ VIEW only: the mirror
  // file already holds them (append-only), so seeding through write() would
  // duplicate history on disk. show_cost and the per-step cost arithmetic sum
  // this view, which is what makes a resumed session's cost cumulative.
  if (config.seedLedgerRecords !== undefined) sink.seed(config.seedLedgerRecords);
  const ownerId = config.backgroundOwnerId ?? crypto.randomUUID();
  const controller = new SessionLimitController(config.sessionLimits);
  // ONE activity channel for the whole orchestrated session. A conversation
  // that is handed no channel builds a private one, so without this every
  // delegated `run_role` worker and every pipeline stage published into a
  // channel nobody could subscribe to: `subscribeToolActivity` on the returned
  // session only ever saw the orchestrator's own tool calls. Owning it here
  // makes nested work observable through that one subscription while keeping
  // the channel's existing bounds -- `subscriberPendingCapacity` still caps
  // each subscriber's queue and over-capacity events are counted as drops, so
  // a busy pipeline cannot flood a consumer.
  const ownsActivityChannel = config.activityChannel === undefined;
  const activityChannel = config.activityChannel ?? new ToolActivityChannel(config.toolActivity);
  // Subscribe a configured consumer ONCE, against the shared channel. Handing
  // it to each conversation instead would attach the same consumer several
  // times to the same channel, so every event would be rendered once per
  // attached conversation.
  const offConfiguredConsumer =
    config.activityConsumer === undefined
      ? undefined
      : activityChannel.subscribe(config.activityConsumer);
  const sharedConfig: OrchestratorConfig = { ...config, activityChannel };
  delete sharedConfig.activityConsumer;
  const buildConfig = (
    task: string,
    complexity?: Complexity,
    raisedLimits?: RaisedStageLimits,
  ): PipelineConfig =>
    // An explicitly classified tier (issues #263/#264) replaces the built-in
    // default at routing; validated at the routing sink like every other one.
    resolvePipelineConfig({
      ...sharedConfig,
      task,
      ...(complexity !== undefined && { defaultComplexity: complexity }),
      // A raised ceiling lands as a role overlay over the shipped defaults, the
      // one place `resolvePipelineConfig` already merges per-role limits. The
      // coordinator compares the pause's prior limit against the resolved one
      // and refuses an unchanged number, so this overlay is what makes a
      // resume legal at all.
      ...(raisedLimits !== undefined && {
        roleStageLimits: {
          ...sharedConfig.roleStageLimits,
          [raisedLimits.role]: {
            ...sharedConfig.roleStageLimits?.[raisedLimits.role],
            [STAGE_LIMIT_KEY[raisedLimits.reason]]: raisedLimits.limit,
          },
        },
      }),
    });
  // Which workflow modules this orchestrated session really resolved. Hoisted
  // above the role kit so a skill's `requires.workflows` is judged against the
  // run's actual composition rather than an assumed one.
  const enabledModules = resolveWorkflowModules(
    config.workflowModules ?? [],
    config.enabledWorkflows ?? [],
  );
  // One source for skill behaviour, shared with `resolve-config`, the pipeline
  // stages, and the standalone role command: an explicit `--skills` list is a
  // PIN pasted into the prompt; no pin means the CATALOGUE a role loads from
  // with `load_skill` after reading the task. Selecting everything and pasting
  // it cost the orchestrator 2106 words of appendix it mostly did not need;
  // `docs/contracts/skills.md` forbids exactly that.
  const roleKit = (role: DelegatableRoleName | "orchestrator") =>
    roleSkillKit({
      role,
      selectedSkills: config.selectedSkills,
      disabled: config.skillsDisabled,
      projectDir: config.targetDir,
      availableWorkflows: enabledModules.map((module) => module.name),
      availablePlugins: pluginNamesFromToolNames(
        (config.pluginTools ?? []).map((tool) => tool.name),
      ),
    });

  // A placeholder task only seeds the config that yields the orchestrator's own
  // conversation model + window budget; the real per-run task arrives through
  // the tools. Its independent role selection still shares the registry and
  // credential boundary with the pipeline.
  const seed = resolveOrchestratorSeed({ ...sharedConfig, task: "orchestrate" });
  // The trivial-edit guard is installed ONLY when the orchestrator can delegate
  // (issue #388), which it reads off `delegatedRoute.groups.length > 0`. A
  // session whose route leaves the reviewer unreachable is still a delegating
  // session -- the guard installs, and the reviewerCover half below decides
  // whether the edits get covered. The orchestrator-only collapse (#386) edits
  // directly -- no guard, no bound, no record.
  const trivialPlan = trivialEditGuardPlan(seed.delegatedRoute);
  // The guard reads file content for measurement through the SAME env shape the
  // orchestrator conversation's built-in tools use (its own startConversation
  // builds one privately, so this one exists solely to feed the guard).
  const trivialEnv = trivialPlan.guard
    ? new NodeExecutionEnv({ cwd: resolveTargetDir(config.targetDir) })
    : undefined;
  const trivialStore = trivialPlan.guard
    ? new ProjectStore(config.targetDir, config.projectStoreConfig)
    : undefined;
  const core =
    enabledModules.length === 0
      ? undefined
      : createOrchestrator({
          buildConfig,
          ledgerSink: sink,
          sessionLimitController: controller,
          ...(config.backgroundRuns !== undefined && { backgroundRuns: config.backgroundRuns }),
          backgroundTargetDir: config.targetDir,
          backgroundOwnerId: ownerId,
          ...(config.backgroundHostLauncher !== undefined && {
            backgroundHostLauncher: config.backgroundHostLauncher,
          }),
          ...(config.backgroundRunExecutor !== undefined && {
            backgroundRunExecutor: config.backgroundRunExecutor,
          }),
        });
  // The session's resolved delegation surface rides on the tool description:
  // which roles exist, on which models, and which world the tools describe
  // (roles only vs roles plus workflow). Assembled from the seed's resolved
  // facts -- the same source the startup banner prints -- never authored prose.
  const sessionFacts: RunRoleSessionFacts | undefined =
    seed.delegatedRoute === undefined
      ? undefined
      : {
          route: seed.delegatedRoute,
          workflows: enabledModules.map((module) => module.name),
        };
  const delegatedRoleTool = buildRunRoleTool(async (name, task, complexity) => {
    // Resolve worker roles lazily: disabling the pipeline does not construct its
    // graph, yet every role remains independently callable by the Orchestrator.
    // A classified tier rides with the call (issues #263/#264): the tool schema
    // is the validation point, and the tier replaces the built-in default at
    // resolveProfile's sink, so the delegate routes on the assessment.
    const resolved = resolvePipelineConfig({
      ...sharedConfig,
      task,
      ...(complexity !== undefined && { defaultComplexity: complexity }),
    });
    const base =
      name === "planner"
        ? resolved.roles.planner
        : name === "researcher"
          ? resolved.roles.researcher
          : name === "security"
            ? resolved.roles.security
            : name === "coder"
              ? resolved.roles.coder
              : name === "reviewer"
                ? resolved.roles.reviewer
                : resolved.roles.auditor;
    if (base === undefined) {
      throw new OrchestratorError("invalid_role", name, `role ${name} is not configured`);
    }
    const runnableKit = roleKit(name);
    const writable = name === "coder";
    // Plugin tools plus the loader, the way the runner registers tools: an
    // activeToolNames entry with no registered object would be a listed tool
    // the conversation could never call.
    const delegatedTools = [
      ...(resolved.pluginToolsForModel?.(base.model) ?? resolved.pluginTools ?? []),
      ...(runnableKit.includeLoadTool ? [runnableKit.buildTool()] : []),
    ];
    const availablePluginNames = delegatedTools.map((tool) => tool.name);
    // A delegated invocation delivers by assistant text, not by the pipeline's
    // submission tools, and nothing here registers their objects. Inheriting
    // the pipeline role's activeToolNames wholesale carried `submit_plan`,
    // `submit_verdict` and `submit_follow_up` into that list (#236): the
    // provider rejected the whole request as `configured_tools_unavailable`,
    // and the turn settled empty. Filter them out so the listed names match
    // what the prompt already promises: "do not expect pipeline submission
    // tools".
    const inheritedToolNames = (base.role.activeToolNames ?? []).filter(
      (tool) => !isSubmissionToolName(tool),
    );
    const role = defineRole(
      {
        ...base.role,
        name,
        // A planner reached this way rates complexity like any other, so it
        // needs the same definition the pipeline's plan stage sends. Without
        // it the tier came from whatever the model assumed a tier meant.
        // The role spec from the resolver carries its catalogue or pin and
        // names the loader when skills are listed; the independent-invocation
        // framing rides on top of exactly that prompt.
        systemPrompt: `${base.role.systemPrompt}\n\nThis is an independent role invocation. Return the complete result as assistant text; do not expect pipeline submission tools.\n\n${COMPLEXITY_RUBRIC}`,
        activeToolNames: [
          ...new Set([
            "read",
            "bash",
            ...(writable ? ["write", "edit"] : []),
            ...inheritedToolNames,
            ...availablePluginNames,
          ]),
        ],
      },
      base.model,
    );
    const before = sink.records().length;
    const conversation = await (config.startDelegatedConversation ?? startConversationImpl)({
      role,
      targetDir: config.targetDir,
      models: resolved.models,
      model: base.model,
      tools: delegatedTools,
      ledgerSink: sink,
      sessionLimitController: controller,
      // The delegated `run_role` turn reaches a provider the same way any other
      // turn does, so an operator block applies to it too.
      ...(resolved.costAnomalyDetector !== undefined && {
        costAnomalyDetector: resolved.costAnomalyDetector,
      }),
      ...(resolved.providerAdmissionController !== undefined && {
        providerAdmissionController: resolved.providerAdmissionController,
      }),
      activityChannel,
      ...(config.toolActivity !== undefined && { toolActivity: config.toolActivity }),
      ...(resolved.compaction !== undefined && { compaction: resolved.compaction }),
      ...(resolved.projectStoreConfig !== undefined && {
        projectStoreConfig: resolved.projectStoreConfig,
      }),
    });
    try {
      const turn = await conversation.step(task, { step: `role:${name}` });
      const cost = sink
        .records()
        .slice(before)
        .reduce((sum, record) => sum + record.usage.cost.total, 0);
      return { role: name, text: turn.assistantText, cost };
    } finally {
      await conversation.close();
    }
  }, sessionFacts);
  // The reviewer cover over the orchestrator's OWN bounded trivial edits (issue
  // #388). Defined only when the guard is installed AND a reviewer is reachable
  // (`trivialPlan.reviewerCover`): a session whose route leaves the reviewer
  // unreachable keeps the guard with NO cover, so every edit records
  // `reviewer_unavailable` -- that is the disabled half of the gate, not a
  // failure to wire it. The shape mirrors the delegated-role callback above:
  // resolve the reviewer lazily through `resolvePipelineConfig`, then start the
  // cover turn through the SAME seam the delegated path uses, so a host (and
  // the gate test) intercepts it identically. A reviewer role that cannot even
  // resolve throws, which the guard records as `reviewer_failed`.
  const trivialReviewCover: TrivialEditCoverFn | undefined =
    trivialPlan.guard &&
    trivialPlan.reviewerCover &&
    trivialEnv !== undefined &&
    trivialStore !== undefined
      ? async (change, uncovered): Promise<TrivialEditCoverSettle> => {
          const coverTask = [
            "Review a bounded trivial edit the orchestrator applied directly (issue #388).",
            `Change: the ${change.tool} tool on ${change.file}, +${change.linesAdded}/-${change.linesRemoved} changed lines.`,
            `Uncovered window: ${uncovered.files} file(s) / ${uncovered.lines} changed line(s) awaiting reviewer cover.`,
            `Inspect the file's CURRENT content with the read tool, then settle the verdict by calling ${SUBMIT_VERDICT_TOOL_NAME}.`,
          ].join("\n");
          const resolved = resolvePipelineConfig({ ...sharedConfig, task: coverTask });
          const base = resolved.roles.reviewer;
          if (base === undefined) {
            throw new OrchestratorError(
              "invalid_role",
              "reviewer",
              "role reviewer is not configured",
            );
          }
          // Same filter as the delegated path: inheriting the pipeline role's
          // submission-tool names wholesale listed tools that are not
          // registered here (#236). The cover's ONLY submission tool is the
          // verdict tool built below, per attempt.
          const inheritedToolNames = (base.role.activeToolNames ?? []).filter(
            (tool) => !isSubmissionToolName(tool),
          );
          const role = defineRole(
            {
              ...base.role,
              name: "reviewer",
              systemPrompt: `${base.role.systemPrompt}\n\n${TRIVIAL_EDIT_COVER_FRAMING}\n\n${formatReviewerInstruction()}`,
              activeToolNames: [
                ...new Set(["read", "bash", SUBMIT_VERDICT_TOOL_NAME, ...inheritedToolNames]),
              ],
            },
            base.model,
          );
          const runAttempt = async (
            reviewerRunId: string,
            task: string,
          ): Promise<{ settle?: TrivialEditCoverSettle; text: string }> => {
            const capture: VerdictCapture = {};
            const conversation = await (config.startDelegatedConversation ?? startConversationImpl)(
              {
                role,
                targetDir: config.targetDir,
                runId: reviewerRunId,
                models: resolved.models,
                model: base.model,
                tools: [buildSubmitVerdictTool(capture, reviewerRunId)],
                ledgerSink: sink,
                sessionLimitController: controller,
                ...(resolved.costAnomalyDetector !== undefined && {
                  costAnomalyDetector: resolved.costAnomalyDetector,
                }),
                activityChannel,
                ...(resolved.compaction !== undefined && { compaction: resolved.compaction }),
              },
            );
            let text = "";
            try {
              const turn = await conversation.step(task, { step: "role:reviewer" });
              text = turn.assistantText;
            } finally {
              await conversation.close();
            }
            if (capture.verdict === undefined) return { text };
            return {
              settle: {
                verdict: capture.verdict.status,
                reviewerRunId,
                issueCount: capture.verdict.issues.length,
              },
              text,
            };
          };
          // Same shape as the CLI's runReviewWithSubmissionRetry: one retry
          // converts a prose-ending review into a settled one, each attempt
          // under a FRESH run id (a turn is keyed by run id in the session
          // store), and the runId that settles is the one recorded. The retry
          // carries the attempts' prose for the same reason the CLI's does
          // (issue #525): a fresh session has no review of its own to submit.
          let attempt = await runAttempt(crypto.randomUUID(), coverTask);
          if (attempt.settle !== undefined) return attempt.settle;
          let carried = attempt.text;
          for (let index = 1; index < REVIEW_SUBMISSION_ATTEMPTS; index += 1) {
            attempt = await runAttempt(crypto.randomUUID(), reviewRetryTask(coverTask, carried));
            if (attempt.settle !== undefined) return attempt.settle;
            carried = carried === "" ? attempt.text : `${carried}\n\n${attempt.text}`;
          }
          // Exhausted attempts and provider errors both throw: the guard
          // records `reviewer_failed` and refuses to report the edit as
          // settled -- never an undefined return that could read as "no
          // reviewer stage", which this wiring has already ruled out.
          throw new Error(
            `trivial-edit cover: the reviewer ended without calling ${SUBMIT_VERDICT_TOOL_NAME} in ${REVIEW_SUBMISSION_ATTEMPTS} attempts`,
          );
        }
      : undefined;
  const seedKit = roleKit("orchestrator");
  const tools = buildOrchestratorTools(
    core,
    [
      ...(seed.pluginTools ?? []),
      delegatedRoleTool,
      // Same condition as the delegated roles: pinned skills are already in
      // the prompt, so the loader would have nothing left to fetch.
      ...(seedKit.includeLoadTool ? [seedKit.buildTool()] : []),
    ],
    enabledModules,
  );

  const orchestratorSpec = seed.roles.orchestrator ?? seed.roles.coder;
  const orchestratorModel = orchestratorSpec.model;
  const orchestratorRole: Role = defineRole(
    {
      name: "orchestrator",
      provider: orchestratorModel.provider,
      modelId: orchestratorModel.id,
      // The orchestrator routes on its own pre-read tier before any planner
      // runs, so it decides with the same definition rather than its own.
      // The seed role prompt carries the catalogue or pin from the shared kit.
      systemPrompt: `${orchestratorSpec.role.systemPrompt}\n\n${COMPLEXITY_RUBRIC}`,
      // Read off the spec like every other field here. `resolve-config` has
      // already applied the profile's value (defaulting to "short"), so
      // restating a literal here would discard a declared "long"/"none" for
      // the conversational role alone -- the delegated roles a few lines up
      // inherit it correctly through `...base.role`.
      cacheRetention: orchestratorSpec.role.cacheRetention,
      contextBudget: orchestratorSpec.role.contextBudget,
      ...(orchestratorSpec.role.thinkingLevel !== undefined && {
        thinkingLevel: orchestratorSpec.role.thinkingLevel,
      }),
      ...(orchestratorSpec.role.requestTimeoutMs !== undefined && {
        requestTimeoutMs: orchestratorSpec.role.requestTimeoutMs,
      }),
    },
    orchestratorModel,
  );

  const conversation = await (config.startConversation ?? startConversationImpl)({
    role: orchestratorRole,
    targetDir: config.targetDir,
    models: seed.models,
    model: orchestratorModel,
    runId: orchestratorRunId,
    tools,
    ledgerSink: sink,
    sessionLimitController: controller,
    ...(seed.costAnomalyDetector !== undefined && {
      costAnomalyDetector: seed.costAnomalyDetector,
    }),
    ...(seed.providerAdmissionController !== undefined && {
      providerAdmissionController: seed.providerAdmissionController,
    }),
    ...(core !== undefined && {
      subscribeBackgroundRuns: core.backgroundRuns.subscribe.bind(core.backgroundRuns),
    }),
    activityChannel,
    ...(config.toolActivity !== undefined && { toolActivity: config.toolActivity }),
    ...(seed.compaction !== undefined && { compaction: seed.compaction }),
    // Guard the orchestrator's OWN direct edit/write calls ONLY (issue #388).
    // The cover rides along only when a reviewer is reachable; otherwise the
    // guard runs bare and its entries record `reviewer_unavailable` -- the
    // disabled half of the gate, kept for the #386 orchestrator-only collapse.
    ...(trivialPlan.guard &&
      trivialEnv !== undefined &&
      trivialStore !== undefined && {
        wrapBuiltinTools: (builtins) =>
          createTrivialEditGuard(builtins, {
            env: trivialEnv,
            store: trivialStore,
            runId: orchestratorRunId,
            ...(trivialReviewCover !== undefined && { cover: trivialReviewCover }),
          }),
      }),
  });
  // Neither conversation closes a channel it did not create, so whoever built
  // this one closes it -- and only if it was built here, never a caller's.
  const closeActivityChannel = async (): Promise<void> => {
    if (ownsActivityChannel) await activityChannel.close();
    else offConfiguredConsumer?.();
  };
  // Subscribe against the SHARED channel rather than whatever the conversation
  // seam happens to expose, so a caller sees delegated and pipeline activity
  // even when an embedding host supplies its own conversation implementation.
  const sharedActivity = {
    subscribeToolActivity: (
      consumer: ToolActivityConsumer,
      options?: { replay?: boolean },
    ): (() => void) => activityChannel.subscribe(consumer, options),
    toolActivitySnapshot: (): ToolActivitySnapshot => activityChannel.snapshot(),
  };
  if (core === undefined)
    return {
      ...conversation,
      ...sharedActivity,
      // The conversation reports `undefined` because it was handed a sink; the
      // durable path is known HERE, and a front that cannot name it cannot tell
      // the operator where the run's evidence went.
      ledgerPath,
      step: conversation.step.bind(conversation),
      close: async () => {
        try {
          await conversation.close();
        } finally {
          await closeActivityChannel();
        }
      },
      // Exposed for the same reason `backgroundRuns` is: a front renders and
      // releases state the session OWNS. Handing a front its own detector would
      // give it a second in-memory copy of the same file, so releasing a block
      // there would leave the block this session refuses on still standing.
      ...(seed.costAnomalyDetector !== undefined && {
        costAnomalyDetector: seed.costAnomalyDetector,
      }),
    };
  // Wake pump: state notices (paused/failed/...) must start an orchestrator
  // turn even when no front drives one. The pump re-reads durable wake state on
  // every notify, drains up to maxWakesPerTurn windows into ONE turn, marks them
  // handled after the turn resolves, and reschedules only if unhandled windows
  // remain. Wakes are owner-scoped exactly like run records (same manager, same
  // ownerId-scoped private state).
  //
  // A single `turnBusy` flag owned here tells the pump the TRUTH about whether
  // a conversation.step is in flight (front OR wake), so a wake landing during
  // a front turn defers instead of racing `conversation step already active`,
  // and drains on the front turn's settle.
  let turnBusy = false;
  const wakeTurnConsumers = new Set<
    (
      event:
        | { phase: "started"; step: string }
        | { phase: "settled"; result: ConversationTurnResult },
    ) => void
  >();
  const wakePump = new WakePump({
    listPending: () => core.backgroundRuns.pendingWakes(),
    markHandled: (runId, wakes) => core.backgroundRuns.markWakesHandled(runId, wakes),
    onTurnStarted: (step) => {
      for (const consumer of wakeTurnConsumers) consumer({ phase: "started", step });
    },
    runTurn: async (prompt, step) => {
      turnBusy = true;
      try {
        return await conversation.step(prompt, { step });
      } finally {
        turnBusy = false;
      }
    },
    onTurnSettled: (result) => {
      for (const consumer of wakeTurnConsumers) consumer({ phase: "settled", result });
    },
    turnActive: () => turnBusy,
    maxWakesPerTurn: core.backgroundRuns.backgroundLimits.maxWakesPerTurn,
  });
  const unsubscribeWakes = core.backgroundRuns.subscribe(() => wakePump.notifyChange());
  // Pick up any wake recorded while this session was gone (restart/reconnect).
  // Fire-and-forget: the pump is single-flight and drains via the subscription
  // on later notices too; blocking startOrchestrator on a model turn would hang
  // startup behind a wake it may not be able to answer yet.
  void wakePump.startupScan();

  return {
    ...conversation,
    ...sharedActivity,
    ledgerPath,
    step: async (userInput, opts) => {
      turnBusy = true;
      try {
        return await conversation.step(userInput, opts);
      } finally {
        // Every turn -- front-driven or wake -- settles through here, so the
        // pump re-reads durable state and drains anything left unhandled. The
        // flag is cleared BEFORE the settle's queued drain runs, so the pump
        // sees the lane free and drains coalesced wakes in one turn.
        turnBusy = false;
        wakePump.onTurnSettled();
      }
    },
    close: async () => {
      unsubscribeWakes();
      try {
        await core.backgroundRuns.close();
      } finally {
        try {
          await conversation.close();
        } finally {
          await closeActivityChannel();
        }
      }
    },
    subscribeBackgroundRuns: core.backgroundRuns.subscribe.bind(core.backgroundRuns),
    subscribeWakeTurns: (consumer) => {
      wakeTurnConsumers.add(consumer);
      return () => wakeTurnConsumers.delete(consumer);
    },
    backgroundRuns: core.backgroundRuns,
    ...(seed.costAnomalyDetector !== undefined && {
      costAnomalyDetector: seed.costAnomalyDetector,
    }),
  } as ConversationSession & {
    backgroundRuns: BackgroundRunManager;
    costAnomalyDetector?: CostAnomalyDetector;
  };
}
