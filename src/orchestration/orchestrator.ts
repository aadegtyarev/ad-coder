import { Type } from "@earendil-works/pi-ai";
import type { ResolvePipelineConfigOptions } from "../cli/resolve-config";
import { resolvePipelineConfig } from "../cli/resolve-config";
import type { ConversationSession } from "../conversation/conversation";
import { startConversation } from "../conversation/conversation";
import type { MemoryLedgerSink } from "../ledger/ledger";
import { MemoryLedgerSink as MemoryLedgerSinkImpl } from "../ledger/ledger";
import { ProjectOperationsError } from "../project-operations/errors";
import { RunCoordinator } from "../project-operations/run-coordinator";
import { resolvePrompt } from "../prompts/prompts";
import type { Role } from "../role";
import { defineRole } from "../role";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";
import type { SessionLimitSnapshot, SessionLimits } from "../session-limits";
import { SessionLimitController } from "../session-limits";
import type { WorkflowSession } from "./session";
import { autoDriver, createWorkflowSession } from "./session";
import { assertTransitionOffered, DriveError } from "./transition-guard";
import type {
  AvailableTransition,
  PipelineConfig,
  PipelineResult,
  Plan,
  TransitionKind,
  Verdict,
  WorkflowPhase,
  WorkflowState,
} from "./types";

/** The four tool names the orchestrator model drives the workflow through. */
export const RUN_PIPELINE_TOOL_NAME = "run_pipeline";
export const RUN_STEP_TOOL_NAME = "run_step";
export const CHOOSE_TRANSITION_TOOL_NAME = "choose_transition";
export const SHOW_COST_TOOL_NAME = "show_cost";

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
  | "no_pending_transition";

/**
 * Raised on an orchestrator-core precondition failure. Carries a `code`
 * discriminant and a names-only `detail` (a method/state token) -- never model
 * text, prompt content, a runId body, or a filesystem path. Mirrors
 * `DriveError`/`OrchestrationError` house style: safe tokens only, dense WHY in
 * JSDoc, nothing that leaks into the transcript.
 */
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
  result: PipelineResult;
  /** Per-step cost for THIS run only, in step order. */
  perStep: StepCost[];
  /** Sum of `perStep` costs for this run. */
  totalCost: number;
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
export interface OrchestratorDeps {
  buildConfig: (task: string) => PipelineConfig;
  ledgerSink: MemoryLedgerSink;
  sessionLimitController?: SessionLimitController;
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
export interface Orchestrator {
  runPipeline(task: string): Promise<RunPipelineResult>;
  beginStepping(task: string): void;
  stepOnce(): Promise<StepView>;
  chooseTransition(kind: TransitionKind, rationale?: string): WorkflowPhase;
  showCost(): CostReport;
  /** True while a stepping run is in progress and not yet settled. */
  isStepping(): boolean;
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
  const buildConfig = (task: string): PipelineConfig => ({
    ...deps.buildConfig(task),
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

  const runPipeline = async (task: string): Promise<RunPipelineResult> => {
    const config = buildConfig(task);
    const wf = createWorkflowSession(config);
    const runCoordinator = new RunCoordinator(wf, wf.projectStore, config.coordinator);
    const perStep: StepCost[] = [];
    let costCursor = sink.records().length;
    const completed = await runCoordinator.run(autoDriver, ({ result }) => {
      const after = sink.records().length;
      perStep.push(recordStep(result.phase, costCursor, after));
      costCursor = after;
    });
    if (completed.result === undefined) {
      const decision = completed.checkpoint.decisions.find((item) => item.status === "pending");
      throw new ProjectOperationsError(
        "pending_decision",
        decision?.id ?? completed.checkpoint.runId,
      );
    }
    const totalCost = perStep.reduce((sum, e) => sum + e.cost, 0);
    return { result: completed.result, perStep, totalCost };
  };

  const beginStepping = (task: string): void => {
    const config = buildConfig(task);
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

  return { runPipeline, beginStepping, stepOnce, chooseTransition, showCost, isStepping };
}

/**
 * Project any error into a transcript-safe one-line string.
 *
 * SECURITY (data_exposure): the tool handlers return text the model reads and
 * the ledger/transcript captures. Every house error (`DriveError`,
 * `OrchestratorError`, `OrchestrationError`, and the config-layer
 * `RegistryError`/`ProfileError` that `buildConfig` may throw) carries a
 * safe `code`+`detail`; this surfaces ONLY those two, never `String(error)`,
 * `error.message`, or a stack (which can hold absolute paths). An unrecognised
 * error collapses to a fixed generic string.
 */
function safeErrorText(error: unknown): string {
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
  return "error: an unexpected internal error occurred";
}

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

/** The last verdict's status, or `none` when a run settled without one. */
function lastVerdictStatus(result: PipelineResult): string {
  return result.verdicts[result.verdicts.length - 1]?.status ?? "none";
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
export function buildOrchestratorTools(core: Orchestrator): Tool[] {
  const runPipelineTool = defineTool({
    name: RUN_PIPELINE_TOOL_NAME,
    description:
      "Run a full autonomous pipeline (plan -> [security] -> code <-> review) for a task and report the outcome and cost. Executes code within the fixed working directory.",
    label: "run pipeline",
    parameters: Type.Object({ task: Type.String() }),
    async execute(_toolCallId, params) {
      try {
        const run = await core.runPipeline(params.task);
        const summary =
          `pipeline complete: approved=${run.result.approved} ` +
          `rounds=${run.result.rounds} verdict=${lastVerdictStatus(run.result)}`;
        return {
          content: [
            { type: "text", text: `${summary}\n${formatCost(run.perStep, run.totalCost)}` },
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
    parameters: Type.Object({ task: Type.Optional(Type.String()) }),
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
          core.beginStepping(params.task);
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

  return [runPipelineTool, runStepTool, chooseTransitionTool, showCostTool];
}

/**
 * Everything `startOrchestrator` needs to assemble the conversational front.
 * It is the pipeline config surface MINUS `task` (which arrives per-run through
 * the tools): a fixed `targetDir` plus the optional provider/model/env knobs
 * `resolvePipelineConfig` accepts. `targetDir` is the ONE trust anchor -- it is
 * closed over here and never a tool parameter.
 */
export type OrchestratorConfig = Omit<ResolvePipelineConfigOptions, "task"> & {
  sessionLimits?: SessionLimits;
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
  const sink = new MemoryLedgerSinkImpl();
  const controller = new SessionLimitController(config.sessionLimits);
  const buildConfig = (task: string): PipelineConfig => resolvePipelineConfig({ ...config, task });
  const core = createOrchestrator({
    buildConfig,
    ledgerSink: sink,
    sessionLimitController: controller,
  });
  const tools = buildOrchestratorTools(core);

  // A placeholder task only seeds the config that yields the orchestrator's own
  // conversation model + window budget; the real per-run task arrives through
  // the tools. Reusing the coder's resolved model/budget keeps every credential
  // on the single resolvePipelineConfig surface.
  const seed = buildConfig("orchestrate");
  const orchestratorModel = seed.roles.coder.model;
  const orchestratorRole: Role = defineRole(
    {
      name: "orchestrator",
      provider: orchestratorModel.provider,
      modelId: orchestratorModel.id,
      systemPrompt: resolvePrompt("orchestrator", { projectDir: config.targetDir }),
      activeToolNames: [
        "read",
        "bash",
        RUN_PIPELINE_TOOL_NAME,
        RUN_STEP_TOOL_NAME,
        CHOOSE_TRANSITION_TOOL_NAME,
        SHOW_COST_TOOL_NAME,
      ],
      cacheRetention: "short",
      contextBudget: seed.roles.coder.role.contextBudget,
    },
    orchestratorModel,
  );

  return startConversation({
    role: orchestratorRole,
    targetDir: config.targetDir,
    models: seed.models,
    model: orchestratorModel,
    tools,
    ledgerSink: sink,
    sessionLimitController: controller,
    ...(seed.compaction !== undefined && { compaction: seed.compaction }),
  });
}
