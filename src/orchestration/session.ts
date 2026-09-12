import type { Context, Session } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Api, Model, TextContent } from "@earendil-works/pi-ai";
import { deriveContextBudget } from "../context/budget";
import { assertSummarizerWindow } from "../context/compactor";
import { resolveProfile } from "../profiles/resolve";
import type { ProfileRole, ResolvedSelection } from "../profiles/types";
import { parseProfile } from "../profiles/validate";
import type { FollowUp } from "../project-operations/types";
import { ProjectStore } from "../project-store/project-store";
import { defineRole } from "../role";
import { createRoleRunner } from "../runner/role-runner";
import type { Tool } from "../runner/tool";
import {
  buildSubmitFollowUpTool,
  type FollowUpCapture,
  formatFollowUpInstruction,
  SUBMIT_FOLLOW_UP_TOOL_NAME,
} from "./follow-up";
import type { PlanCapture } from "./plan";
import { buildSubmitPlanTool, formatPlannerInstruction } from "./plan";
import type {
  AvailableTransition,
  Complexity,
  Driver,
  PipelineConfig,
  PipelineResult,
  RoleSpec,
  StepResult,
  VerdictIssue,
  WorkflowState,
} from "./types";
import { OrchestrationError } from "./types";
import type { VerdictCapture } from "./verdict";
import { buildSubmitVerdictTool, formatReviewerInstruction } from "./verdict";

/**
 * A stepped workflow session bound to one `PipelineConfig`.
 *
 * `initialState()` yields the starting `WorkflowState`; `step(state)` runs the
 * ONE pending role turn for `state.phase`, records its runId/verdict/ledger step
 * on the shared sink, and returns the post-turn state plus the transitions on
 * offer WITHOUT committing one. The pure, exported `applyTransition(state,
 * chosen)` commits an edge and yields the next state. A driver (see `Driver`)
 * chooses which edge; `autoDriver` reproduces `runPipeline` by always taking the
 * default.
 */
export interface WorkflowSession {
  initialState(): WorkflowState;
  step(state: WorkflowState): Promise<StepResult>;
  /** Re-run only the reviewer against the current implementation and contracts. */
  reviewCurrent(state: WorkflowState): Promise<StepResult>;
  readonly projectStore: ProjectStore;
}

/** The resolved transition-policy knobs, each already defaulted to today's behavior. */
interface ResolvedDefaults {
  onChangesRequested: "advance" | "stop";
  autoAdvance: boolean;
  maxRounds: number;
  preComplexity: Complexity;
}

/**
 * Build a stepped session over the plan -> [security] -> code<->review graph.
 *
 * WHY the graph lives here exactly once: `runPipeline` is now a thin auto-driver
 * over this session (see pipeline.ts). Every rule the old inline control flow
 * encoded -- the plan->security edge only on an `elevated` surface WITH a
 * security role, the round-1-only security-notes injection, `effective =
 * complexity ?? preComplexity` routing, the `missing_verdict`/`malformed_*`
 * throw points, the ledger step labels -- lives in `step`/`applyTransition`
 * below and nowhere else.
 *
 * Validation (`empty_task`/`invalid_max_rounds`) runs up front, before any role,
 * so its throw timing is identical to the old `runPipeline`. The verbatim-safe
 * threading (model-authored plan/security text is prompt DATA, never a sink) and
 * the credential boundary (models come from the caller's registry/config, never
 * from `targetDir`) are unchanged.
 */
export function createWorkflowSession(config: PipelineConfig): WorkflowSession {
  const resolvedMaxRounds = config.defaults?.maxRounds ?? config.maxRounds;
  if (!Number.isInteger(resolvedMaxRounds) || resolvedMaxRounds < 1) {
    throw new OrchestrationError(
      "invalid_max_rounds",
      String(resolvedMaxRounds),
      "maxRounds must be an integer >= 1",
    );
  }
  if (typeof config.task !== "string" || config.task.trim() === "") {
    throw new OrchestrationError("empty_task", "", "task must be a non-empty string");
  }

  const { targetDir } = config;
  const projectStore = new ProjectStore(config.targetDir, config.projectStoreConfig);

  // Complexity-aware routing (optional). When present, re-validate the profile
  // at the sink (house style: untrusted hand-built config is re-parsed before
  // use) and carry the validated form; the runner binds to the registry's
  // models instead of config.models. When absent, every model decision below is
  // byte-for-byte the prior behavior (each RoleSpec.model over config.models).
  // A caller config error from resolveProfile (missing_mapping / unknown_model)
  // is the caller's ProfileError and propagates UNWRAPPED -- never re-wrapped in
  // OrchestrationError.
  const routing =
    config.routing !== undefined
      ? { ...config.routing, profile: parseProfile(config.routing.profile) }
      : undefined;

  // One-shot compaction must be able to accept the largest history any
  // reachable routed role can produce. Validate the whole routing space before
  // constructing a runner or dispatching a provider request.
  if (config.compaction?.mode !== "disabled-then-halt" && config.compaction?.summarizerModel) {
    const reachable: Model<Api>[] = [];
    if (routing === undefined) {
      for (const spec of Object.values(config.roles))
        if (spec !== undefined) reachable.push(spec.model);
    } else {
      for (const entry of routing.profile.entries) {
        if (entry.role !== "recorder") reachable.push(routing.registry.getModel(entry.model));
      }
      for (const [role, override] of Object.entries(routing.overrides ?? {})) {
        if (role !== "recorder" && override !== undefined) {
          reachable.push(routing.registry.getModel(override.model));
        }
      }
      if (config.roles.orchestrator !== undefined) reachable.push(config.roles.orchestrator.model);
    }
    assertSummarizerWindow(config.compaction.summarizerModel, reachable);
  }
  const runner =
    routing !== undefined
      ? createRoleRunner({
          targetDir,
          models: routing.registry.models,
          ...(config.compaction !== undefined && { compaction: config.compaction }),
          ...(config.sessionLimitController !== undefined && {
            sessionLimitController: config.sessionLimitController,
          }),
          ...(config.projectStoreConfig !== undefined && {
            projectStoreConfig: config.projectStoreConfig,
          }),
        })
      : createRoleRunner({
          targetDir,
          models: config.models,
          ...(config.compaction !== undefined && { compaction: config.compaction }),
          ...(config.sessionLimitController !== undefined && {
            sessionLimitController: config.sessionLimitController,
          }),
          ...(config.projectStoreConfig !== undefined && {
            projectStoreConfig: config.projectStoreConfig,
          }),
        });

  const defaults: ResolvedDefaults = {
    onChangesRequested: config.defaults?.onChangesRequested ?? "advance",
    autoAdvance: config.defaults?.autoAdvance ?? true,
    maxRounds: resolvedMaxRounds,
    // The planner and any other pre-complexity role route on this: the planner's
    // model must be chosen BEFORE the plan reveals a complexity, and it is also
    // the fallback for every later role when no complexity is ever submitted.
    // routing.defaultComplexity wins (validated, authoritative in the routing
    // path); a routing-less caller may still name one via defaults.
    preComplexity: routing?.defaultComplexity ?? config.defaults?.defaultComplexity ?? "medium",
  };

  // The ONE place a role's model is chosen. Routing absent -> the spec's own
  // model (prior behavior); present -> the profile's (role, complexity) cell,
  // with a per-role override winning over the cell (resolveProfile precedence).
  const pickSelection = (
    role: ProfileRole,
    spec: RoleSpec,
    complexity: Complexity,
  ): ResolvedSelection => {
    if (routing === undefined) {
      return { model: spec.model };
    }
    return resolveProfile(
      routing.profile,
      routing.registry,
      role,
      complexity,
      routing.overrides?.[role],
    );
  };

  /** Drive one role turn on a fresh session and return its final assistant text. */
  const runTurn = async (
    spec: RoleSpec,
    selection: ResolvedSelection,
    prompt: string,
    step: string,
    runId: string,
    tools?: Tool[],
  ): Promise<{ text: string; followUps: FollowUp[] }> => {
    const { model } = selection;
    // A fresh session per run: each role has its own systemPrompt, so sharing a
    // session would leak one role's history and prompt into another.
    const session = await projectStore.createSession(runId, BACKGROUND_CONTEXT);
    const budgetPercents = routing?.budgetPercents?.[spec.role.name as ProfileRole];
    const { thinkingLevel: _seedThinkingLevel, ...roleWithoutThinkingLevel } = spec.role;
    const role =
      routing === undefined
        ? spec.role
        : defineRole(
            {
              ...roleWithoutThinkingLevel,
              provider: model.provider,
              modelId: model.id,
              ...(selection.thinkingLevel !== undefined && {
                thinkingLevel: selection.thinkingLevel,
              }),
              ...(budgetPercents !== undefined && {
                contextBudget: deriveContextBudget(model.contextWindow, budgetPercents),
              }),
            },
            model,
          );
    await runner.runRole(role, model, prompt, {
      runId,
      step,
      session,
      // exactOptionalPropertyTypes: spread each optional only when present.
      ...(config.ledgerSink !== undefined && { ledgerSink: config.ledgerSink }),
      ...(tools !== undefined && { tools }),
    });
    // runRole closes the session facade it was handed (harness.close ->
    // session.close), while the durable store survives. Reopen a fresh readable
    // facade to scan the settled transcript.
    const readable = await projectStore.resumeSession(runId, BACKGROUND_CONTEXT);
    try {
      return { text: await extractFinalText(readable, BACKGROUND_CONTEXT), followUps: [] };
    } finally {
      await readable.close(BACKGROUND_CONTEXT);
    }
  };

  const runWorkflowTurn = async (
    spec: RoleSpec,
    selection: ResolvedSelection,
    prompt: string,
    stepName: string,
    runId: string,
    tools: Tool[] = [],
  ): Promise<{ text: string; followUps: FollowUp[] }> => {
    const enabled =
      spec.role.activeToolNames === undefined ||
      spec.role.activeToolNames.includes(SUBMIT_FOLLOW_UP_TOOL_NAME);
    const capture: FollowUpCapture = { followUps: [] };
    const configuredBranch = config.projectStoreConfig?.projectOperations?.branch;
    const followUpTool = buildSubmitFollowUpTool(capture, {
      producer: spec.role.name,
      runId,
      ...(configuredBranch !== undefined && { branch: configuredBranch }),
    });
    const turn = await runTurn(
      spec,
      selection,
      enabled ? `${prompt}\n\n${formatFollowUpInstruction()}` : prompt,
      stepName,
      runId,
      [...tools, followUpTool],
    );
    if (capture.error !== undefined) throw capture.error;
    return { text: turn.text, followUps: capture.followUps };
  };

  const initialState = (): WorkflowState => ({
    // No planner -> the plan phase is skipped entirely; the run starts at code.
    phase: config.roles.planner !== undefined ? "plan" : "code",
    round: 1,
    planSummary: "",
    contractRequirements: [],
    changeSummary: "",
    securityNotes: "",
    preComplexity: defaults.preComplexity,
    effective: defaults.preComplexity,
    verdicts: [],
    runIds: [],
    done: false,
    approved: false,
  });

  const stepPlan = async (state: WorkflowState): Promise<StepResult> => {
    // config.roles.planner is defined whenever phase is 'plan' (initialState
    // only sets 'plan' when it is present); assert for the type-checker.
    const planner = config.roles.planner;
    if (planner === undefined) {
      throw new OrchestrationError("empty_task", "", "plan phase requires a planner role");
    }
    const runId = crypto.randomUUID();
    const capture: PlanCapture = {};
    const submitPlanTool = buildSubmitPlanTool(capture, runId);
    const prompt = `${config.task}\n\n${formatPlannerInstruction()}`;
    const selection = pickSelection("planner", planner, state.preComplexity);
    const { text, followUps } = await runWorkflowTurn(planner, selection, prompt, "plan", runId, [
      submitPlanTool,
    ]);
    const runIds = [...state.runIds, runId];
    // A captured error is parsePlan's OrchestrationError, swallowed by the
    // harness into an error tool-result and re-thrown here (HARD malformed_plan).
    // A captured plan sets the complexity/securitySurface signals. An EMPTY
    // holder is legitimate: both stay undefined and the run proceeds (NO
    // missing_plan).
    if (capture.error !== undefined) {
      throw capture.error;
    }
    const complexity = capture.plan?.complexity;
    const securitySurface = capture.plan?.securitySurface;
    const contractRequirements = capture.plan?.contractRequirements ?? [];
    const effective: Complexity = complexity ?? state.preComplexity;

    // The plan->security edge is armed ONLY when the planner flagged an elevated
    // surface AND a security role is configured. Elevated with no role skips to
    // code and emits one content-free stderr note (the surface is still surfaced
    // on the result for the caller to act on) -- fired here, once, exactly as the
    // old inline security block did.
    const runSecurity = securitySurface === "elevated" && config.roles.security !== undefined;
    if (securitySurface === "elevated" && config.roles.security === undefined) {
      process.stderr.write(
        "orchestration: elevated security surface, no security role — skipping\n",
      );
    }

    const nextState: WorkflowState = {
      ...state,
      planSummary: text,
      contractRequirements,
      runIds,
      effective,
      ...(complexity !== undefined && { complexity }),
      ...(securitySurface !== undefined && { securitySurface }),
    };
    const transitions: AvailableTransition[] = [
      {
        kind: "advance",
        isDefault: defaults.autoAdvance,
        toPhase: runSecurity ? "security" : "code",
        toRound: state.round,
      },
      { kind: "stop", isDefault: !defaults.autoAdvance, toPhase: "done", toRound: state.round },
    ];
    return {
      state: nextState,
      result: {
        phase: "plan",
        runId,
        text,
        ...(capture.plan !== undefined && { plan: capture.plan }),
        followUps,
      },
      transitions,
    };
  };

  const stepSecurity = async (state: WorkflowState): Promise<StepResult> => {
    const security = config.roles.security;
    if (security === undefined) {
      throw new OrchestrationError("empty_task", "", "security phase requires a security role");
    }
    const runId = crypto.randomUUID();
    const prompt = composeSecurityPrompt(
      config.task,
      appendContractRequirements(state.planSummary, state.contractRequirements),
    );
    const selection = pickSelection("security", security, state.effective);
    const { text, followUps } = await runWorkflowTurn(
      security,
      selection,
      prompt,
      "security",
      runId,
    );
    const nextState: WorkflowState = {
      ...state,
      securityNotes: text,
      runIds: [...state.runIds, runId],
    };
    const transitions: AvailableTransition[] = [
      { kind: "advance", isDefault: defaults.autoAdvance, toPhase: "code", toRound: state.round },
      { kind: "stop", isDefault: !defaults.autoAdvance, toPhase: "done", toRound: state.round },
    ];
    return { state: nextState, result: { phase: "security", runId, text, followUps }, transitions };
  };

  const stepCode = async (state: WorkflowState): Promise<StepResult> => {
    const runId = crypto.randomUUID();
    const round = state.round;
    const previousVerdict = state.verdicts[state.verdicts.length - 1];
    // Round 1 carries the plan summary plus any security mitigation
    // requirements. Round 2+ carry the reviewer's issues instead; unmet
    // mitigations return via those issues, so securityNotes is NOT re-injected
    // every round (that would double-count them).
    const handoff =
      round === 1
        ? appendSecurityNotes(state.planSummary, state.securityNotes)
        : formatIssues(previousVerdict?.issues ?? []);
    const context = composeCoderPrompt(
      config.task,
      appendContractRequirements(handoff, state.contractRequirements),
    );
    const selection = pickSelection("coder", config.roles.coder, state.effective);
    const { text, followUps } = await runWorkflowTurn(
      config.roles.coder,
      selection,
      context,
      `code:${round}`,
      runId,
    );
    const nextState: WorkflowState = {
      ...state,
      changeSummary: text,
      runIds: [...state.runIds, runId],
    };
    const transitions: AvailableTransition[] = [
      { kind: "advance", isDefault: defaults.autoAdvance, toPhase: "review", toRound: round },
      // Re-run the coder for another attempt without a review in between.
      { kind: "rework", isDefault: false, toPhase: "code", toRound: round + 1 },
      { kind: "stop", isDefault: !defaults.autoAdvance, toPhase: "done", toRound: round },
    ];
    return { state: nextState, result: { phase: "code", runId, text, followUps }, transitions };
  };

  const stepReview = async (state: WorkflowState): Promise<StepResult> => {
    const runId = crypto.randomUUID();
    const round = state.round;
    // Fresh holder + tool PER ROUND: a stale verdict from an earlier round can
    // never be read as this round's (mirrors the old per-runId file keying).
    const capture: VerdictCapture = {};
    const submitTool = buildSubmitVerdictTool(capture, runId);
    const prompt = composeReviewerPrompt(
      config.task,
      state.changeSummary,
      formatReviewerInstruction(),
      state.securityNotes,
      state.contractRequirements,
    );
    const selection = pickSelection("reviewer", config.roles.reviewer, state.effective);
    const { text, followUps } = await runWorkflowTurn(
      config.roles.reviewer,
      selection,
      prompt,
      `review:${round}`,
      runId,
      [submitTool],
    );
    // Missing/malformed here throws OrchestrationError -- distinct from a
    // legitimate non-approval, which is a well-formed changes_requested verdict.
    // A captured error is parseVerdict's OrchestrationError, swallowed by the
    // harness into an error tool-result and re-thrown here; an empty holder means
    // the reviewer never called submit_verdict.
    if (capture.error !== undefined) {
      throw capture.error;
    }
    if (capture.verdict === undefined) {
      throw new OrchestrationError("missing_verdict", runId, "reviewer did not submit a verdict");
    }
    const verdict = capture.verdict;
    const nextState: WorkflowState = {
      ...state,
      verdicts: [...state.verdicts, verdict],
      runIds: [...state.runIds, runId],
    };

    let transitions: AvailableTransition[];
    if (verdict.status === "approved") {
      transitions = [
        { kind: "stop", isDefault: true, toPhase: "done", toRound: round },
        // A driver may force another coder pass even after approval.
        { kind: "rework", isDefault: false, toPhase: "code", toRound: round + 1 },
      ];
    } else if (round < defaults.maxRounds) {
      transitions = [
        {
          kind: "advance",
          isDefault: defaults.onChangesRequested === "advance",
          toPhase: "code",
          toRound: round + 1,
        },
        {
          kind: "stop",
          isDefault: defaults.onChangesRequested === "stop",
          toPhase: "done",
          toRound: round,
        },
      ];
    } else {
      // The cap is reached: the loop can only settle (approved:false). No advance
      // edge exists past maxRounds -- exactly the old loop's exit.
      transitions = [{ kind: "stop", isDefault: true, toPhase: "done", toRound: round }];
    }
    return {
      state: nextState,
      result: { phase: "review", runId, text, verdict, followUps },
      transitions,
    };
  };

  const step = async (state: WorkflowState): Promise<StepResult> => {
    switch (state.phase) {
      case "plan":
        return stepPlan(state);
      case "security":
        return stepSecurity(state);
      case "code":
        return stepCode(state);
      case "review":
        return stepReview(state);
      case "done":
        // A programming error in the driver loop, not a run outcome: a settled
        // state carries its result in itself and must be read, never re-stepped.
        throw new Error("cannot step a completed workflow (phase 'done')");
    }
  };

  return { initialState, step, reviewCurrent: stepReview, projectStore };
}

/**
 * Commit one transition and yield the next state. PURE: it reads only `state`
 * and the target `chosen.toPhase`/`toRound`, so the same inputs always yield the
 * same next state and a driver can dry-run edges. A `stop` edge settles the run
 * -- `done` is set and `approved` is derived from the last verdict (an approved
 * review -> true; an exhausted-rounds or early stop -> false), reproducing the
 * old `runPipeline` return exactly.
 */
export function applyTransition(state: WorkflowState, chosen: AvailableTransition): WorkflowState {
  if (chosen.toPhase === "done") {
    const lastVerdict = state.verdicts[state.verdicts.length - 1];
    return {
      ...state,
      phase: "done",
      done: true,
      approved: lastVerdict?.status === "approved",
    };
  }
  return { ...state, phase: chosen.toPhase, round: chosen.toRound };
}

/**
 * The driver `runPipeline` uses: always take the single default transition.
 * Under the resolved `WorkflowDefaults` every `step` offers exactly one default,
 * so this walks the graph deterministically. An absent default is a programming
 * error in a caller-built transition set, not a run outcome.
 */
export const autoDriver: Driver = (transitions) => {
  const chosen = transitions.find((t) => t.isDefault);
  if (chosen === undefined) {
    throw new Error("no default transition available");
  }
  return chosen;
};

/**
 * Flatten a settled `WorkflowState` into the `PipelineResult` the old
 * `runPipeline` returned, byte-for-byte: `rounds` is the completed-round count
 * (== `verdicts.length`, which equals the approving round or `maxRounds`), and
 * `complexity`/`securitySurface` are spread only when present (exactOptional).
 */
export function toPipelineResult(state: WorkflowState): PipelineResult {
  const approved = state.approved;
  return {
    outcome: approved ? "approved" : "decomposition_required",
    approved,
    rounds: state.verdicts.length,
    verdicts: state.verdicts,
    runIds: state.runIds,
    ...(state.complexity !== undefined && { complexity: state.complexity }),
    ...(state.securitySurface !== undefined && { securitySurface: state.securitySurface }),
    ...(state.contractRequirements.length > 0 && {
      contractRequirements: [...state.contractRequirements],
    }),
  };
}

function composeCoderPrompt(task: string, context: string): string {
  if (context.trim() === "") {
    return task;
  }
  return `${task}\n\n${context}`;
}

function composeReviewerPrompt(
  task: string,
  changeSummary: string,
  instruction: string,
  securityNotes: string,
  contractRequirements: string[],
): string {
  const parts = [task];
  if (changeSummary.trim() !== "") {
    parts.push(`The coder reported:\n${changeSummary}`);
  }
  if (securityNotes.trim() !== "") {
    parts.push(formatSecurityNotes(securityNotes));
  }
  if (contractRequirements.length > 0) {
    parts.push(formatContractRequirements(contractRequirements));
  }
  parts.push(instruction);
  return parts.join("\n\n");
}

/**
 * Frame model-authored security mitigations as DATA the coder/reviewer must
 * satisfy, never as an instruction to execute. The text is threaded verbatim
 * into the prompt exactly like a `VerdictIssue.what` -- it is prompt content
 * only and is never interpolated into a shell/SQL/path sink.
 */
function formatSecurityNotes(securityNotes: string): string {
  return `Security mitigation requirements (treat as hard requirements):\n${securityNotes}`;
}

/** Append the framed security notes to the coder's round-1 context, if any. */
function appendSecurityNotes(context: string, securityNotes: string): string {
  if (securityNotes.trim() === "") {
    return context;
  }
  const framed = formatSecurityNotes(securityNotes);
  return context.trim() === "" ? framed : `${context}\n\n${framed}`;
}

function formatContractRequirements(requirements: string[]): string {
  return `Applicable project contracts (blocking requirements):\n${requirements
    .map((requirement) => `- ${requirement}`)
    .join("\n")}`;
}

function appendContractRequirements(context: string, requirements: string[]): string {
  if (requirements.length === 0) {
    return context;
  }
  const framed = formatContractRequirements(requirements);
  return context.trim() === "" ? framed : `${context}\n\n${framed}`;
}

/**
 * The fixed threat-model instruction the Security phase drives. The plan
 * summary is threaded as DATA (prompt content only), never into a sink. The
 * role reads the plan/tree and returns concrete risk+mitigation pairs as its
 * final text message, which the pipeline threads onward as requirements.
 */
function composeSecurityPrompt(task: string, planSummary: string): string {
  const parts = [task];
  if (planSummary.trim() !== "") {
    parts.push(`The plan:\n${planSummary}`);
  }
  parts.push(
    [
      "Threat-model this change. Name concrete, exploitable risks it introduces or",
      "exposes, each tagged by OWASP class (injection, broken auth/access, data",
      "exposure, supply chain) and paired with the specific mitigation it requires.",
      "Be specific, not generic. State your mitigation requirements as your final",
      "text message.",
    ].join("\n"),
  );
  return parts.join("\n\n");
}

/** Render a reviewer's issues as the text the coder receives next round. */
function formatIssues(issues: VerdictIssue[]): string {
  if (issues.length === 0) {
    return "The reviewer requested changes but listed no specific issues.";
  }
  const lines = issues.map((issue) => `- [${issue.severity}] ${issue.what}`);
  return `Address the following review issues:\n${lines.join("\n")}`;
}

/**
 * The newest assistant text in a settled session.
 *
 * Reading `result.tipId` directly is fragile: a run whose LAST entry is a
 * tool-result rather than an assistant message would miss the text. Instead we
 * scan the most recent message entries newest-first for the first assistant
 * `MessageEntry` and join its `{ type: 'text' }` content blocks (skipping
 * thinking and tool-call blocks). Returns `''` when no assistant text exists.
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
