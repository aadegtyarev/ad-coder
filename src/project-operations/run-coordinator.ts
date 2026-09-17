import * as crypto from "node:crypto";
import * as path from "node:path";
import type { WorkflowSession } from "../orchestration/session";
import {
  applyTransition,
  autoDriver,
  toPipelineResult,
  WorkflowStageFailureError,
  WorkflowStageLimitError,
} from "../orchestration/session";
import {
  ROLE_BY_PHASE,
  STAGE_LIMIT_KEY,
  StageLimitError,
  type StageLimitReason,
} from "../orchestration/stage-limits";
import type {
  Driver,
  PipelineResult,
  ResearchDispatchIntent,
  StepResult,
  WorkflowPhase,
  WorkflowState,
} from "../orchestration/types";
import { OrchestrationError } from "../orchestration/types";
import type { ProjectStore } from "../project-store/project-store";
import type { VersionedState } from "../project-store/types";
import { ProjectStoreError } from "../project-store/types";
import { ProviderRejectionError } from "../runner/errors";
import { type BacklogStore, FileBacklogStore } from "./backlog";
import {
  appendDocumentationProposal,
  type DocumentationProposal,
  routeDocumentationFollowUp,
} from "./documentation";
import { ProjectOperationsError } from "./errors";
import { aggregateFollowUps, followUpSemanticId } from "./follow-ups";
import type { FollowUp } from "./types";

export type CoordinatorPhase = "workflow" | "follow-ups" | "decisions" | "closeout" | "complete";
export type DecisionStatus = "pending" | "accepted" | "rejected" | "deferred";

export interface OperatorDecision {
  id: string;
  followUpId: string;
  kind: "contract" | "product";
  status: DecisionStatus;
  authorizationSource?: "operator";
  contractText?: string;
}

export interface ContractReviewRecord {
  decisionId: string;
  status: "pending" | "approved" | "changes_requested";
  runId?: string;
}

export interface CoordinatorCloseout {
  pipeline: PipelineResult;
  followUpIds: string[];
  decisionIds: string[];
}

export interface RunCheckpoint {
  schemaVersion: 1;
  runId: string;
  /** Binds a resumable run to its original task without persisting task contents. */
  taskDigest?: string;
  phase: CoordinatorPhase;
  workflowState: WorkflowState;
  followUps: FollowUp[];
  completedEffects: string[];
  decisions: OperatorDecision[];
  contractReviews: ContractReviewRecord[];
  closeout?: CoordinatorCloseout;
  pendingStep?: StepResult;
  researchEffect?: {
    intent: ResearchDispatchIntent;
    status: "prepared" | "dispatched" | "completed";
  };
  pause?: {
    phase: WorkflowState["phase"];
    code: string;
    action: string;
    limitReason?: StageLimitReason;
    limit?: number;
  };
}

/**
 * The durable pause a non-limit stage failure leaves behind.
 *
 * WHY THE CAUSE IS INSPECTED HERE. The checkpoint is often the only thing an
 * operator reads after an unattended run stops, and a fixed "inspect the
 * provider failure" told them nothing about WHICH failure -- a provider that
 * refused a malformed request read exactly like one that was never
 * authenticated. `WorkflowStageFailureError` preserves its `sourceError`, so a
 * typed rejection can name the status and the party at fault right in the
 * pause.
 *
 * NUMBERS AND CODES ONLY. `ProviderRejectionError` carries no body, so nothing
 * uncontrolled reaches durable state -- the same discipline the stage-limit
 * pause above follows.
 */
function stageFailurePause(
  phase: WorkflowState["phase"],
  sourceError: unknown,
): { phase: WorkflowState["phase"]; code: string; action: string } {
  // The REVIEW stage failing to run is its OWN outcome (issue #227): an
  // operator skimming a generic stage_failed line is exactly how PR #220's
  // unreviewed branch went quiet. Naming it here is what makes a review that
  // did not happen render differently from any other stage failure.
  if (phase === "review") {
    return {
      phase,
      code: "review_not_run",
      action:
        "the review stage did not run to a verdict; inspect the reviewer's registration and " +
        "configuration, then resume the review explicitly",
    };
  }
  if (sourceError instanceof ProviderRejectionError) {
    return {
      phase,
      code: "provider_rejected",
      action:
        `the provider rejected the request with HTTP ${sourceError.status}; ` +
        "inspect the request this stage sends (model id, tool schemas, parameters), then retry the stage explicitly",
    };
  }
  return {
    phase,
    code: "stage_failed",
    action: "inspect the provider failure and retry the stage explicitly",
  };
}

export interface RunCoordinatorOptions {
  runId?: string;
  task?: string;
  /** Fail instead of silently creating a new checkpoint for a mistyped resume id. */
  resumeExisting?: boolean;
  decisionLimit?: number;
  checkpointByteLimit?: number;
  /** Required for a non-file backlog authority; the coordinator never falls back. */
  backlogStore?: BacklogStore;
  /** Process-local cooperative cancellation probe; never persisted. */
  interrupted?: () => boolean;
}

export const DEFAULT_RUN_COORDINATOR_OPTIONS = {
  decisionLimit: 0,
  checkpointByteLimit: 0,
} as const;
const MANDATORY_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;

function assertCheckpointSize(
  value: RunCheckpoint,
  configuredLimit: number,
  enforceConfigured = true,
): void {
  const checkpointBytes = Buffer.byteLength(JSON.stringify(value));
  if (checkpointBytes > MANDATORY_CHECKPOINT_MAX_BYTES)
    throw new ProjectOperationsError("resource_limit", "mandatoryCheckpointByteLimit");
  if (enforceConfigured && configuredLimit > 0 && checkpointBytes > configuredLimit)
    throw new ProjectOperationsError("resource_limit", "checkpointByteLimit");
}

export interface CoordinatorRunResult {
  status: "awaiting_decision" | "paused" | "complete";
  checkpoint: RunCheckpoint;
  result?: PipelineResult;
}

export interface DecisionResolution {
  source: "operator";
  action: "accept" | "reject" | "defer";
  contractText?: string;
}

export interface ResearchPauseResolution {
  source: "operator" | "host_config";
  action: "retry";
}

export type CoordinatorDriver = (
  transitions: Parameters<Driver>[0],
) => ReturnType<Driver> | Promise<ReturnType<Driver>>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateContractText(text: unknown, id: string): string {
  if (
    typeof text !== "string" ||
    text.trim() === "" ||
    text !== text.trim() ||
    /[\r\n\0]/.test(text) ||
    text.includes("<!--")
  )
    throw new ProjectOperationsError("invalid_follow_up", id);
  return text;
}

/** Deterministic, non-model owner of workflow progress and project closeout. */
export class RunCoordinator {
  private persisted: VersionedState<RunCheckpoint>;
  private readonly checkpointPath: string;
  private readonly decisionLimit: number;
  private readonly checkpointByteLimit: number;
  private readonly backlogStore: BacklogStore | undefined;
  private readonly interrupted: (() => boolean) | undefined;

  constructor(
    private readonly session: WorkflowSession,
    private readonly store: ProjectStore,
    options: RunCoordinatorOptions = {},
  ) {
    const runId = options.runId ?? crypto.randomUUID();
    this.decisionLimit = options.decisionLimit ?? DEFAULT_RUN_COORDINATOR_OPTIONS.decisionLimit;
    this.checkpointByteLimit =
      options.checkpointByteLimit ?? DEFAULT_RUN_COORDINATOR_OPTIONS.checkpointByteLimit;
    this.backlogStore = options.backlogStore;
    this.interrupted = options.interrupted;
    for (const [name, value] of [
      ["decisionLimit", this.decisionLimit],
      ["checkpointByteLimit", this.checkpointByteLimit],
    ] as const)
      if (!Number.isSafeInteger(value) || value < 0)
        throw new ProjectOperationsError("invalid_config", name);
    this.store.validateId(runId);
    this.checkpointPath = path.join(store.layout.runs, `coordinator-${runId}.json`);
    const taskDigest =
      options.task === undefined
        ? undefined
        : crypto.createHash("sha256").update(options.task).digest("hex");
    try {
      this.persisted = store.readVersionedJson<RunCheckpoint>(this.checkpointPath);
      if (this.persisted.value.schemaVersion !== 1 || this.persisted.value.runId !== runId)
        throw new ProjectOperationsError("invalid_config", runId);
      if (
        taskDigest !== undefined &&
        this.persisted.value.taskDigest !== undefined &&
        this.persisted.value.taskDigest !== taskDigest
      )
        throw new ProjectOperationsError("invalid_config", "resume task does not match checkpoint");
      // Legacy checkpoints predate task binding. The explicit operator resume is
      // the migration boundary: bind once, then reject every later mismatch.
      if (options.resumeExisting && taskDigest !== undefined && !this.persisted.value.taskDigest) {
        this.persisted = store.writeVersionedJson(
          this.checkpointPath,
          { ...this.persisted.value, taskDigest },
          this.persisted.version,
        );
      }
    } catch (error) {
      if (!(error instanceof ProjectStoreError) || error.code !== "not_found") throw error;
      if (options.resumeExisting) throw new ProjectOperationsError("not_found", runId);
      const initial: RunCheckpoint = {
        schemaVersion: 1,
        runId,
        ...(taskDigest === undefined ? {} : { taskDigest }),
        phase: "workflow",
        workflowState: session.initialState(),
        followUps: [],
        completedEffects: [],
        decisions: [],
        contractReviews: [],
      };
      assertCheckpointSize(initial, this.checkpointByteLimit, false);
      this.persisted = store.writeVersionedJson(this.checkpointPath, initial, 0);
    }
  }

  get checkpoint(): RunCheckpoint {
    return clone(this.persisted.value);
  }

  get checkpointFile(): string {
    return this.checkpointPath;
  }

  resumeResearch(resolution: ResearchPauseResolution): void {
    const checkpoint = this.persisted.value;
    if (resolution.source !== "operator" || checkpoint.pause?.phase !== "research")
      throw new ProjectOperationsError("unauthorized_resolution", checkpoint.runId);
    const next = { ...checkpoint };
    delete next.pause;
    if (next.researchEffect?.status === "dispatched")
      next.researchEffect = { intent: next.researchEffect.intent, status: "prepared" };
    this.save(next);
  }

  /** Clear a stage-budget pause after the operator supplies a larger/disabled budget. */
  resumeStage(resolution: ResearchPauseResolution): void {
    const checkpoint = this.persisted.value;
    const pause = checkpoint.pause;
    const pauseCode = pause?.code;
    if (
      (resolution.source !== "operator" && resolution.source !== "host_config") ||
      (pauseCode !== "stage_limit" &&
        pauseCode !== "stage_failed" &&
        // A provider rejection is the same class of pause as `stage_failed` --
        // it is that pause with the cause named -- so it must stay resumable by
        // the same operator act, or naming the cause would cost recoverability.
        pauseCode !== "provider_rejected" &&
        pauseCode !== "interrupted" &&
        // A review that never ran is a red pause like a red gate: the same
        // explicit operator act is what lets the review be attempted again.
        pauseCode !== "review_not_run" &&
        // A plan that never arrived is resumable for the same reason a review
        // that never ran is (issue #315): the stage can be attempted again.
        pauseCode !== "plan_not_submitted")
    )
      throw new ProjectOperationsError("unauthorized_resolution", checkpoint.runId);
    if (pauseCode !== "stage_limit") {
      const next = { ...checkpoint };
      delete next.pause;
      this.save(next);
      return;
    }
    const reason = pause?.limitReason;
    const priorLimit = pause?.limit;
    if (reason === undefined || priorLimit === undefined)
      throw new ProjectOperationsError("invalid_config", "stage pause lacks limit evidence");
    // One table shared with the orchestrator's raise path: the field checked
    // here and the field written there must be the same one, or a raise would
    // satisfy this check without changing what the stage actually measures.
    const key = STAGE_LIMIT_KEY[reason];
    // ...and the same OBJECT, which is the half this originally missed (#208).
    // A raise lands on the role that ran the paused stage -- the orchestrator
    // raises `planner` when the plan stage exhausts its budget -- so reading the
    // session-wide ceiling saw an unchanged number and refused a correct raise,
    // leaving the run unresumable however large the new ceiling was. Observed
    // live: two resumes with raiseLimit 900000 both rejected against the 180000
    // default. The phase names the role, so nothing extra has to be persisted
    // and checkpoints written before this fix still resolve.
    const pausedRole = ROLE_BY_PHASE[checkpoint.workflowState.phase as WorkflowPhase];
    const roleLimit =
      pausedRole === undefined ? undefined : this.session.roleStageLimits?.[pausedRole]?.[key];
    const resumedLimit = roleLimit ?? this.session.stageLimits?.[key] ?? 0;
    if (resumedLimit !== 0 && resumedLimit <= priorLimit)
      throw new ProjectOperationsError("invalid_config", `unchanged ${reason} stage limit`);
    const next = { ...checkpoint };
    delete next.pause;
    this.save(next);
  }

  private save(value: RunCheckpoint): void {
    assertCheckpointSize(value, this.checkpointByteLimit);
    try {
      this.persisted = this.store.writeVersionedJson(
        this.checkpointPath,
        value,
        this.persisted.version,
      );
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === "version_conflict")
        throw new ProjectOperationsError("checkpoint_conflict", value.runId);
      throw error;
    }
  }

  async step(
    driver: CoordinatorDriver = autoDriver,
    onStep?: (result: StepResult) => void | Promise<void>,
  ): Promise<StepResult | undefined> {
    const result = await this.prepareStep();
    if (result === undefined) return undefined;
    await onStep?.(result);
    const chosen = await driver(result.transitions);
    this.commitTransition(chosen);
    return result;
  }

  async prepareStep(): Promise<StepResult | undefined> {
    let checkpoint = this.persisted.value;
    if (checkpoint.phase !== "workflow" || checkpoint.workflowState.done) return undefined;
    if (checkpoint.pause !== undefined) return undefined;
    if (checkpoint.pendingStep !== undefined) return clone(checkpoint.pendingStep);
    if (this.interrupted?.()) {
      this.save({
        ...checkpoint,
        pause: {
          phase: checkpoint.workflowState.phase,
          code: "interrupted",
          action: "resume the interrupted workflow explicitly",
        },
      });
      return undefined;
    }
    if (checkpoint.workflowState.phase === "research") {
      if (checkpoint.researchEffect?.status === "dispatched") {
        this.save({
          ...checkpoint,
          pause: {
            phase: "research",
            code: "ambiguous_dispatch",
            action: "reconcile the provider effect by its effectId, then resume explicitly",
          },
        });
        return undefined;
      }
      if (checkpoint.researchEffect === undefined) {
        let intent: ResearchDispatchIntent | undefined;
        try {
          intent = this.session.prepareResearch?.(checkpoint.workflowState);
        } catch (error) {
          this.save({
            ...checkpoint,
            pause: {
              phase: "research",
              code: "unsafe_request",
              action: error instanceof Error ? error.message : "narrow the research request",
            },
          });
          return undefined;
        }
        if (intent === undefined) {
          this.save({
            ...checkpoint,
            pause: {
              phase: "research",
              code: "researcher_unavailable",
              action: "configure roles.researcher and resume",
            },
          });
          return undefined;
        }
        this.save({
          ...checkpoint,
          workflowState: { ...checkpoint.workflowState, researchIntent: intent },
          researchEffect: { intent, status: "prepared" },
        });
        checkpoint = this.persisted.value;
      }
      this.save({
        ...checkpoint,
        researchEffect: {
          ...(checkpoint.researchEffect as NonNullable<RunCheckpoint["researchEffect"]>),
          status: "dispatched",
        },
      });
      checkpoint = this.persisted.value;
    }
    let result: StepResult;
    try {
      result = await this.session.step(checkpoint.workflowState);
    } catch (error) {
      if (this.interrupted?.()) {
        this.save({
          ...this.persisted.value,
          pause: {
            phase: checkpoint.workflowState.phase,
            code: "interrupted",
            action: "resume the interrupted workflow explicitly",
          },
        });
        return undefined;
      }
      if (error instanceof StageLimitError) {
        const activePhase = checkpoint.workflowState.phase;
        const resumablePhase =
          activePhase === "plan" ||
          activePhase === "security" ||
          activePhase === "code" ||
          activePhase === "review";
        const failedState =
          error instanceof WorkflowStageLimitError
            ? {
                ...checkpoint.workflowState,
                runIds: [...checkpoint.workflowState.runIds, error.runId],
                stageMetrics: [...(checkpoint.workflowState.stageMetrics ?? []), error.metrics],
                ...(!resumablePhase
                  ? {}
                  : {
                      activeStage: {
                        phase: activePhase,
                        step: error.metrics.stage,
                        runId: error.runId,
                        metrics: error.metrics,
                        ...(error.snapshot === undefined
                          ? {}
                          : {
                              snapshot: {
                                elapsedMs: error.snapshot.elapsedMs,
                                modelTurns: error.snapshot.modelTurns,
                                toolTurns: error.snapshot.toolTurns,
                                inputTokens: error.snapshot.inputTokens,
                                lastInputTokens: error.snapshot.lastInputTokens,
                                costUsd: error.snapshot.costUsd,
                              },
                            }),
                      },
                    }),
              }
            : checkpoint.workflowState;
        this.save({
          ...this.persisted.value,
          workflowState: failedState,
          pause: {
            phase: checkpoint.workflowState.phase,
            code: "stage_limit",
            action: `increase or disable the ${error.reason} stage limit, then resume explicitly`,
            limitReason: error.reason,
            limit: error.limit,
          },
        });
        return undefined;
      }
      if (
        error instanceof WorkflowStageFailureError &&
        checkpoint.workflowState.phase !== "research"
      ) {
        this.save({
          ...this.persisted.value,
          workflowState: {
            ...checkpoint.workflowState,
            runIds: [...checkpoint.workflowState.runIds, error.runId],
            stageMetrics: [...(checkpoint.workflowState.stageMetrics ?? []), error.metrics],
          },
          pause: stageFailurePause(checkpoint.workflowState.phase, error.sourceError),
        });
        return undefined;
      }
      if (
        error instanceof OrchestrationError &&
        (error.code === "missing_verdict" || error.code === "malformed_verdict") &&
        checkpoint.workflowState.phase === "review"
      ) {
        // A verdict the Reviewer could not produce is a RED review, not a
        // missing one: the run pauses with its own code so "review did not
        // happen" never renders like "review ran, no findings", and the
        // explicit operator resume is what re-attempts the review.
        this.save({
          ...checkpoint,
          pause: {
            phase: "review",
            code: "review_not_run",
            action: `the review stage did not run (${error.code}); inspect the reviewer's registration and configuration, then resume the review explicitly`,
          },
        });
        return undefined;
      }
      if (
        error instanceof OrchestrationError &&
        // `missing_plan` ONLY: a planner that called the tool with bad data is a
        // different failure, and `malformed_plan` names the field that was
        // refused. Pausing on that would send the operator looking for a planner
        // that never ran instead of at the field to correct -- the same
        // confusion the session's own comment warns about.
        error.code === "missing_plan" &&
        checkpoint.workflowState.phase === "plan"
      ) {
        // Same reasoning as the review pause above, for the stage that comes
        // first (issue #315). A planner that spends its handoff attempts without
        // calling `submit_plan` throws here, and with no branch for it the error
        // escaped every handler: the checkpoint kept its pre-stage value, the
        // run never settled, and the `run_pipeline` tool call that started it
        // stayed pending forever. Observed live -- two planner attempts ending
        // `stop` with no tool call, then 48 minutes of silence that looked
        // exactly like work in progress. A pause is recoverable; silence is the
        // one outcome a caller cannot act on.
        this.save({
          ...checkpoint,
          pause: {
            phase: "plan",
            code: "plan_not_submitted",
            action: `the planner did not submit a plan (${error.code}); inspect the planner's registration and configuration, then resume the plan explicitly`,
          },
        });
        return undefined;
      }
      if (checkpoint.workflowState.phase !== "research") throw error;
      const failedState =
        error instanceof WorkflowStageFailureError
          ? {
              ...checkpoint.workflowState,
              runIds: [...checkpoint.workflowState.runIds, error.runId],
              stageMetrics: [...(checkpoint.workflowState.stageMetrics ?? []), error.metrics],
            }
          : checkpoint.workflowState;
      this.save({
        ...this.persisted.value,
        workflowState: failedState,
        pause: {
          phase: "research",
          code: "research_rejected",
          action:
            error instanceof Error ? error.message : "inspect and retry the research response",
        },
      });
      return undefined;
    }
    const followUps = aggregateFollowUps(
      [...checkpoint.followUps, ...(result.result.followUps ?? [])],
      this.store.projectOperations,
    );
    const contractReviews =
      result.result.verdict?.status === "approved"
        ? checkpoint.contractReviews.map((record) =>
            record.status === "changes_requested"
              ? { ...record, status: "approved" as const, runId: result.result.runId }
              : record,
          )
        : checkpoint.contractReviews;
    const completedResearch =
      checkpoint.workflowState.phase === "research" ? checkpoint.researchEffect : undefined;
    this.save({
      ...checkpoint,
      followUps,
      contractReviews,
      pendingStep: result,
      ...(completedResearch !== undefined && {
        researchEffect: { intent: completedResearch.intent, status: "completed" as const },
        completedEffects: [
          ...new Set([...checkpoint.completedEffects, completedResearch.intent.effectId]),
        ].sort(),
      }),
    });
    return clone(result);
  }

  commitTransition(chosen: ReturnType<Driver>): WorkflowState {
    const checkpoint = this.persisted.value;
    const pending = checkpoint.pendingStep;
    if (pending === undefined) throw new ProjectOperationsError("invalid_transition", chosen.kind);
    const offered = pending.transitions.find(
      (transition) =>
        transition.kind === chosen.kind &&
        transition.toPhase === chosen.toPhase &&
        transition.toRound === chosen.toRound,
    );
    if (offered === undefined) throw new ProjectOperationsError("invalid_transition", chosen.kind);
    const workflowState = applyTransition(pending.state, offered);
    const next: RunCheckpoint = {
      ...checkpoint,
      workflowState,
      phase: workflowState.done ? "follow-ups" : "workflow",
    };
    delete next.pendingStep;
    this.save(next);
    if (workflowState.done) {
      this.processFollowUps();
      if (this.persisted.value.phase === "closeout") this.closeout();
    }
    return clone(workflowState);
  }

  private recordEffect(checkpoint: RunCheckpoint, key: string): void {
    if (checkpoint.completedEffects.includes(key)) return;
    this.save({
      ...checkpoint,
      completedEffects: [...checkpoint.completedEffects, key].sort(),
    });
  }

  private ensureDecision(followUp: FollowUp, kind: OperatorDecision["kind"]): void {
    const checkpoint = this.persisted.value;
    const followUpId = followUpSemanticId(followUp);
    const id = crypto
      .createHash("sha256")
      .update(`decision:${followUpId}`)
      .digest("hex")
      .slice(0, 32);
    if (checkpoint.decisions.some((decision) => decision.id === id)) return;
    if (this.decisionLimit > 0 && checkpoint.decisions.length >= this.decisionLimit)
      throw new ProjectOperationsError("resource_limit", "decisionLimit");
    this.save({
      ...checkpoint,
      decisions: [...checkpoint.decisions, { id, followUpId, kind, status: "pending" }],
    });
  }

  private processFollowUps(): void {
    let checkpoint = this.persisted.value;
    if (checkpoint.phase !== "follow-ups") return;
    for (const followUp of checkpoint.followUps) {
      const id = followUpSemanticId(followUp);
      const effect = `follow-up:${id}`;
      if (this.persisted.value.completedEffects.includes(effect)) continue;
      if (followUp.kind === "contract") {
        this.ensureDecision(followUp, "contract");
        this.recordEffect(this.persisted.value, effect);
        continue;
      }
      if (followUp.kind === "backlog") {
        const backlog =
          this.backlogStore ??
          (this.store.projectOperations.backlogBackend === "github"
            ? undefined
            : new FileBacklogStore(this.store));
        if (backlog === undefined)
          throw new ProjectOperationsError("github_unavailable", "backlogStore");
        try {
          backlog.create(followUp, id.slice(0, 32));
        } catch (error) {
          if (!(error instanceof ProjectStoreError) || error.code !== "version_conflict")
            throw error;
          backlog.get(id.slice(0, 32));
        }
        this.recordEffect(this.persisted.value, effect);
        continue;
      }
      try {
        const proposal = routeDocumentationFollowUp(
          this.store.layout.targetDir,
          followUp,
          this.store.projectOperations,
        );
        appendDocumentationProposal(proposal, id);
        this.recordEffect(this.persisted.value, effect);
      } catch (error) {
        if (!(error instanceof ProjectOperationsError) || error.code !== "unsafe_destination")
          throw error;
        this.ensureDecision(followUp, "product");
        this.recordEffect(this.persisted.value, effect);
      }
    }
    checkpoint = this.persisted.value;
    this.save({ ...checkpoint, phase: checkpoint.decisions.length > 0 ? "decisions" : "closeout" });
  }

  private acceptedContractProposal(followUp: FollowUp, text: string): DocumentationProposal {
    const routed = routeDocumentationFollowUp(
      this.store.layout.targetDir,
      followUp,
      this.store.projectOperations,
    );
    return { ...routed, content: `- ${text}\n` };
  }

  async resolveDecision(id: string, resolution: DecisionResolution): Promise<void> {
    if (resolution.source !== "operator")
      throw new ProjectOperationsError("unauthorized_resolution", id);
    let checkpoint = this.persisted.value;
    const index = checkpoint.decisions.findIndex((decision) => decision.id === id);
    const current = checkpoint.decisions[index];
    if (current === undefined) throw new ProjectOperationsError("not_found", id);
    if (
      current.status !== "pending" &&
      !(current.status === "accepted" && current.kind === "contract")
    )
      return;
    const next: OperatorDecision =
      current.status === "pending"
        ? {
            ...current,
            status:
              resolution.action === "accept"
                ? "accepted"
                : resolution.action === "reject"
                  ? "rejected"
                  : "deferred",
            authorizationSource: "operator",
          }
        : current;
    if (resolution.action === "accept" && current.kind === "contract")
      next.contractText = validateContractText(resolution.contractText, id);
    if (current.status === "pending") {
      const decisions = [...checkpoint.decisions];
      decisions[index] = next;
      this.save({ ...checkpoint, decisions });
    }
    if (next.status !== "accepted" || next.kind !== "contract") return;

    checkpoint = this.persisted.value;
    const followUp = checkpoint.followUps.find(
      (item) => followUpSemanticId(item) === next.followUpId,
    );
    if (followUp === undefined || followUp.kind !== "contract")
      throw new ProjectOperationsError("not_found", next.followUpId);
    const contractText = next.contractText as string;
    appendDocumentationProposal(
      this.acceptedContractProposal(followUp, contractText),
      `contract-${id}`,
    );
    const state: WorkflowState = {
      ...checkpoint.workflowState,
      contractRequirements: [
        ...new Set([...checkpoint.workflowState.contractRequirements, contractText]),
      ],
      done: false,
      approved: false,
      phase: "review",
    };
    const contractReviews = checkpoint.contractReviews.some((record) => record.decisionId === id)
      ? checkpoint.contractReviews
      : [
          ...checkpoint.contractReviews,
          { decisionId: id, status: "pending" } as ContractReviewRecord,
        ];
    this.save({
      ...checkpoint,
      workflowState: state,
      contractReviews,
    });
    const review = await this.session.reviewCurrent(state);
    const verdict = review.result.verdict;
    if (verdict === undefined) throw new ProjectOperationsError("unresolved_review", id);
    const reviewRecord: ContractReviewRecord = {
      decisionId: id,
      status: verdict.status,
      runId: review.result.runId,
    };
    const reviews = this.persisted.value.contractReviews.map((record) =>
      record.decisionId === id ? reviewRecord : record,
    );
    const followUps = aggregateFollowUps(
      [...this.persisted.value.followUps, ...(review.result.followUps ?? [])],
      this.store.projectOperations,
    );
    if (verdict.status === "approved") {
      this.save({
        ...this.persisted.value,
        workflowState: { ...review.state, phase: "done", done: true, approved: true },
        contractReviews: reviews,
        followUps,
        phase: "follow-ups",
      });
      return;
    }
    const advance = review.transitions.find((transition) => transition.toPhase === "code");
    if (advance === undefined) {
      this.save({
        ...this.persisted.value,
        workflowState: review.state,
        contractReviews: reviews,
        followUps,
      });
      throw new ProjectOperationsError("unresolved_review", id);
    }
    this.save({
      ...this.persisted.value,
      workflowState: applyTransition(review.state, advance),
      contractReviews: reviews,
      followUps,
      phase: "workflow",
    });
  }

  private closeout(): CoordinatorRunResult {
    const checkpoint = this.persisted.value;
    if (checkpoint.closeout !== undefined)
      return {
        status: "complete",
        checkpoint: clone(checkpoint),
        result: checkpoint.closeout.pipeline,
      };
    const pending = checkpoint.decisions.filter((decision) => decision.status === "pending");
    if (pending.length > 0) return { status: "awaiting_decision", checkpoint: clone(checkpoint) };
    if (!checkpoint.workflowState.done)
      return { status: "awaiting_decision", checkpoint: clone(checkpoint) };
    if (checkpoint.contractReviews.some((record) => record.status !== "approved"))
      throw new ProjectOperationsError("unresolved_review", checkpoint.runId);
    const pipeline = toPipelineResult(checkpoint.workflowState);
    const closeout: CoordinatorCloseout = {
      pipeline,
      followUpIds: checkpoint.followUps.map(followUpSemanticId).sort(),
      decisionIds: checkpoint.decisions.map((decision) => decision.id).sort(),
    };
    const complete: RunCheckpoint = { ...checkpoint, phase: "complete", closeout };
    this.save(complete);
    return { status: "complete", checkpoint: clone(this.persisted.value), result: pipeline };
  }

  async run(
    driver: CoordinatorDriver = autoDriver,
    onStep?: (result: StepResult) => void | Promise<void>,
  ): Promise<CoordinatorRunResult> {
    while (this.persisted.value.phase === "workflow") {
      const stepped = await this.step(driver, onStep);
      if (stepped === undefined && this.persisted.value.pause !== undefined)
        return { status: "paused", checkpoint: this.checkpoint };
    }
    if (this.persisted.value.phase === "follow-ups") this.processFollowUps();
    if (this.persisted.value.phase === "decisions") {
      for (const decision of this.persisted.value.decisions) {
        if (
          decision.status === "accepted" &&
          decision.kind === "contract" &&
          !this.persisted.value.contractReviews.some(
            (record) => record.decisionId === decision.id && record.status === "approved",
          )
        )
          await this.resolveDecision(decision.id, {
            source: "operator",
            action: "accept",
            ...(decision.contractText !== undefined && { contractText: decision.contractText }),
          });
      }
      const resumedPhase: CoordinatorPhase = this.checkpoint.phase;
      if (resumedPhase === "follow-ups") this.processFollowUps();
      if (resumedPhase === "workflow") return this.run(driver, onStep);
      const pending = this.persisted.value.decisions.some(
        (decision) => decision.status === "pending",
      );
      if (pending) return { status: "awaiting_decision", checkpoint: this.checkpoint };
      this.save({ ...this.persisted.value, phase: "closeout" });
    }
    return this.closeout();
  }
}

export function createRunCoordinator(
  session: WorkflowSession,
  store: ProjectStore,
  options: RunCoordinatorOptions = {},
): RunCoordinator {
  return new RunCoordinator(session, store, options);
}
