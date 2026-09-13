import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import {
  buildControlPlaneTools,
  createOrchestratorControlPlane,
  DEFAULT_CONTROL_PLANE_CONFIG,
  LiveRetryCoordinator,
  triageControlPlaneTask,
} from "../src/orchestration/control-plane";
import { SUBMIT_FOLLOW_UP_TOOL_NAME } from "../src/orchestration/follow-up";
import {
  buildBuiltInPipelineTools,
  buildOrchestratorTools,
  buildRunRoleTool,
  CANCEL_PIPELINE_TOOL_NAME,
  CHOOSE_TRANSITION_TOOL_NAME,
  createOrchestrator,
  DECOMPOSE_TASK_TOOL_NAME,
  PIPELINE_EVENTS_TOOL_NAME,
  PIPELINE_RESULT_TOOL_NAME,
  PIPELINE_STATUS_TOOL_NAME,
  RESUME_PIPELINE_TOOL_NAME,
  RUN_PIPELINE_TOOL_NAME,
  RUN_ROLE_TOOL_NAME,
  RUN_STEP_TOOL_NAME,
  SHOW_COST_TOOL_NAME,
  START_PIPELINE_TOOL_NAME,
  startOrchestrator,
} from "../src/orchestration/orchestrator";
import { SUBMIT_PLAN_TOOL_NAME } from "../src/orchestration/plan";
import { createWorkflowSession } from "../src/orchestration/session";
import { DriveError } from "../src/orchestration/transition-guard";
import type {
  PipelineConfig,
  PipelineResult,
  RoleSpec,
  TransitionKind,
  Verdict,
} from "../src/orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { RunCoordinator } from "../src/project-operations/run-coordinator";
import { ProjectStore } from "../src/project-store/project-store";
import { EXPLORE_PROJECT_TOOL_NAME } from "../src/project-tools/explore";
import { READ_PROJECT_TOOL_NAME } from "../src/project-tools/read";
import { SEARCH_PROJECT_TOOL_NAME } from "../src/project-tools/search";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { ProviderLimitError } from "../src/runner/errors";
import type { Tool } from "../src/runner/tool";
import { SessionLimitController, SessionLimitError } from "../src/session-limits";
import {
  INSPECT_IMAGE_TOOL_NAME,
  WEB_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../src/web/tools";
import {
  BUILT_IN_PIPELINE_WORKFLOW,
  BUILT_IN_PIPELINE_WORKFLOW_NAME,
} from "../src/workflows/builtin-pipeline";

const CONTEXT_WINDOW = 200_000;
const BUDGET = { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 } as const;

interface Fixture {
  faux: FauxProviderHandle;
  sink: MemoryLedgerSink;
  targetDir: string;
  /** A per-task PipelineConfig factory over the fixture's faux roles + shared sink. */
  buildConfig: (task: string) => PipelineConfig;
}

/**
 * A faux provider + shared sink + a `buildConfig` that yields a planner/coder/
 * reviewer pipeline config over the one faux model. The single faux queue serves
 * every role turn in order, exactly as test/orchestration.test.ts drives it.
 */
function fixture(): Fixture {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-orchestrator-")),
  );
  const sink = new MemoryLedgerSink();

  const role = (name: string, systemPrompt: string, activeToolNames: string[]): RoleSpec => {
    const built: Role = defineRole(
      {
        name,
        provider: "faux",
        modelId: model.id,
        systemPrompt,
        activeToolNames,
        cacheRetention: "none",
        contextBudget: { ...BUDGET },
      },
      model,
    );
    return { role: built, model };
  };

  const defaultTools = ["bash", "read", "write", "edit", SUBMIT_FOLLOW_UP_TOOL_NAME];
  const buildConfig = (task: string): PipelineConfig => ({
    targetDir,
    models,
    task,
    maxRounds: 3,
    roles: {
      planner: role("planner", "You plan.", defaultTools),
      coder: role("coder", "You code.", defaultTools),
      reviewer: role("reviewer", "You review.", [...defaultTools, SUBMIT_VERDICT_TOOL_NAME]),
    },
    ledgerSink: sink,
  });

  return { faux, sink, targetDir, buildConfig };
}

test("startOrchestrator automatically resolves its target-local prompt override", async () => {
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-orchestrator-prompt-")),
  );
  const promptDir = path.join(targetDir, ".ad-coder", "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  fs.writeFileSync(path.join(promptDir, "orchestrator.md"), "", "utf8");

  await expect(
    startOrchestrator({
      targetDir,
      env: (name) => (name === "DEEPSEEK_API_KEY" ? "test-only" : undefined),
      warn: () => {},
    }),
  ).rejects.toThrow("systemPrompt must be a non-empty string");
});

test("startOrchestrator preserves the resolved seed thinking level", async () => {
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-orchestrator-thinking-")),
  );
  const credentials: CredentialStore = {
    read: async () => ({
      type: "oauth",
      access: "test-access",
      refresh: "test-refresh",
      expires: 0,
    }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  let captured: Role | undefined;
  let capturedToolNames: string[] | undefined;
  let capturedBackgroundSubscribe:
    | NonNullable<
        import("../src/conversation/conversation").ConversationConfig["subscribeBackgroundRuns"]
      >
    | undefined;

  const session = await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    orchestratorThinkingLevel: "high",
    workflowModules: [BUILT_IN_PIPELINE_WORKFLOW],
    enabledWorkflows: [BUILT_IN_PIPELINE_WORKFLOW_NAME],
    startConversation: async (config) => {
      captured = config.role;
      capturedToolNames = config.tools?.map(({ name }) => name);
      capturedBackgroundSubscribe = config.subscribeBackgroundRuns;
      return {
        runId: "test-session",
        ledgerPath: undefined,
        step: async () => ({
          runId: "test-session",
          step: "turn:1",
          status: "completed",
          assistantText: "",
          toolCalls: [],
          droppedRecords: 0,
        }),
        close: async () => {},
      };
    },
  });

  expect(session.runId).toBe("test-session");
  expect(captured?.thinkingLevel).toBe("high");
  expect(captured?.requestTimeoutMs).toBe(120_000);
  expect(captured?.activeToolNames).toBeUndefined();
  expect(capturedToolNames).toEqual([
    EXPLORE_PROJECT_TOOL_NAME,
    SEARCH_PROJECT_TOOL_NAME,
    READ_PROJECT_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME,
    WEB_READ_TOOL_NAME,
    INSPECT_IMAGE_TOOL_NAME,
    RUN_ROLE_TOOL_NAME,
    RUN_PIPELINE_TOOL_NAME,
    RESUME_PIPELINE_TOOL_NAME,
    START_PIPELINE_TOOL_NAME,
    PIPELINE_STATUS_TOOL_NAME,
    PIPELINE_EVENTS_TOOL_NAME,
    PIPELINE_RESULT_TOOL_NAME,
    CANCEL_PIPELINE_TOOL_NAME,
    DECOMPOSE_TASK_TOOL_NAME,
    RUN_STEP_TOOL_NAME,
    CHOOSE_TRANSITION_TOOL_NAME,
    SHOW_COST_TOOL_NAME,
  ]);
  const notices: string[] = [];
  const unsubscribe = capturedBackgroundSubscribe?.((notice) => {
    notices.push(notice.events[0]?.lifecycle ?? "missing");
  });
  const backgroundRuns = session as typeof session & {
    backgroundRuns: import("../src/orchestration/background-runs").BackgroundRunManager;
  };
  const run = backgroundRuns.backgroundRuns.start("safe background task");
  backgroundRuns.backgroundRuns.cancel(run.runId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  unsubscribe?.();
  expect(notices).toEqual(["requested", "cancelled"]);
  await session.close();
});

test("disabled pipeline does not resolve its role prompts or construct its core tools", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-disabled-")));
  const promptDir = path.join(targetDir, ".ad-coder", "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  for (const name of ["planner", "coder", "reviewer", "security"])
    fs.writeFileSync(path.join(promptDir, `${name}.md`), "", "utf8");
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  let names: string[] = [];
  await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    workflowModules: [BUILT_IN_PIPELINE_WORKFLOW],
    enabledWorkflows: [],
    startConversation: async (config) => {
      names = config.tools?.map(({ name }) => name) ?? [];
      return {
        runId: "disabled",
        ledgerPath: undefined,
        step: async () => ({
          runId: "disabled",
          step: "turn:1",
          status: "completed",
          assistantText: "",
          toolCalls: [],
          droppedRecords: 0,
        }),
        close: async () => {},
      };
    },
  });
  expect(names).not.toContain(RUN_PIPELINE_TOOL_NAME);
  expect(names).not.toContain(RUN_STEP_TOOL_NAME);
  expect(names).toContain(RUN_ROLE_TOOL_NAME);
  expect(names).toContain(EXPLORE_PROJECT_TOOL_NAME);
});

test("run_role delegates independently and rejects unknown role names safely", async () => {
  const calls: Array<{ role: string; task: string }> = [];
  const tool = buildRunRoleTool(async (role, task) => {
    calls.push({ role, task });
    return { role, text: "focused result", cost: 0.25 };
  });

  expect(await callTool(tool, { role: "auditor", task: "inspect health" })).toContain(
    "auditor complete (cost 0.25)\nfocused result",
  );
  expect(calls).toEqual([{ role: "auditor", task: "inspect health" }]);
  expect(await callTool(tool, { role: "publisher", task: "publish" })).toBe(
    "error: invalid_role (publisher)",
  );
  expect(calls).toHaveLength(1);
});

test("pipeline-disabled startOrchestrator delegates Researcher and Auditor with own roles", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-delegated-")));
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  let outerTools: Tool[] = [];
  const delegated: Array<{ role: Role; modelId: string; tools: string[] }> = [];
  await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    researcherModel: "codex-sol",
    auditorModel: "codex-terra",
    enabledWorkflows: [],
    startConversation: async (config) => {
      outerTools = config.tools ?? [];
      return fakeConversation("outer");
    },
    startDelegatedConversation: async (config) => {
      delegated.push({
        role: config.role,
        modelId: config.model.id,
        tools: (config.tools ?? []).map(({ name }) => name),
      });
      return fakeConversation(config.role.name);
    },
  });
  const runRole = outerTools.find(({ name }) => name === RUN_ROLE_TOOL_NAME) as Tool;
  await callTool(runRole, { role: "researcher", task: "find evidence" });
  await callTool(runRole, { role: "auditor", task: "audit health" });

  expect(delegated.map(({ role }) => role.name)).toEqual(["researcher", "auditor"]);
  expect(delegated[0]?.role.systemPrompt).toContain("You are the Researcher");
  expect(delegated[1]?.role.systemPrompt).toContain("# Auditor");
  expect(delegated[0]?.modelId).not.toBe(delegated[1]?.modelId);
  expect(delegated[0]?.tools).toContain(WEB_SEARCH_TOOL_NAME);
  expect(delegated[1]?.tools).toContain(EXPLORE_PROJECT_TOOL_NAME);
  expect(delegated.flatMap(({ tools }) => tools)).not.toContain("write");
});

function fakeConversation(runId: string) {
  return {
    runId,
    ledgerPath: undefined,
    step: async () => ({
      runId,
      step: "turn:1",
      status: "completed",
      assistantText: `${runId} result`,
      toolCalls: [],
      droppedRecords: 0,
    }),
    close: async () => {},
  };
}

/** Script a plan -> code -> review(approved) run: one faux queue, in phase order. */
function approveScenario(fx: Fixture, verdict: Verdict): void {
  fx.faux.setResponses([
    ...governedPlanTurn(),
    fauxAssistantMessage("coded X"),
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, verdict)),
    fauxAssistantMessage("review complete"),
  ]);
}

function governedPlanTurn() {
  return [
    fauxAssistantMessage(
      fauxToolCall(SUBMIT_PLAN_TOOL_NAME, {
        complexity: "medium",
        securitySurface: "none",
        summary: "plan: do X",
        contractRequirements: [],
        surfaceAnalysis: {
          projectType: "test fixture",
          surfaces: [{ id: "core", name: "core", rationale: "exercise orchestration" }],
          coverage: [
            {
              surfaceId: "core",
              status: "not_applicable",
              contractIds: [],
              evidence: ["fixture changes no product contract surface"],
              rationale: "orchestrator plumbing only",
            },
          ],
        },
      }),
    ),
    fauxAssistantMessage("plan: do X"),
  ];
}

/**
 * Invoke a tool's execute the way the harness would, but with only the two args
 * the orchestrator handlers read. The full `AgentHarnessTool.execute` takes six
 * (onUpdate/toolContext/invocation/context); the handlers ignore them, so a
 * two-arg cast exercises the marshalling without standing up a harness.
 */
async function callTool(tool: Tool, params: Record<string, unknown>): Promise<string> {
  const execute = tool.execute as unknown as (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }> }>;
  const result = await execute("tc-test", params);
  return result.content.map((c) => c.text).join("");
}

const ALL_KINDS: readonly TransitionKind[] = ["advance", "rework", "stop"];

test("built-in pipeline tools are absent until its workflow module is enabled", () => {
  const fx = fixture();
  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  expect(buildOrchestratorTools(core, [])).toEqual([]);
  expect(
    buildOrchestratorTools(core, [], [BUILT_IN_PIPELINE_WORKFLOW]).map(({ name }) => name),
  ).toEqual([
    RUN_PIPELINE_TOOL_NAME,
    RESUME_PIPELINE_TOOL_NAME,
    START_PIPELINE_TOOL_NAME,
    PIPELINE_STATUS_TOOL_NAME,
    PIPELINE_EVENTS_TOOL_NAME,
    PIPELINE_RESULT_TOOL_NAME,
    CANCEL_PIPELINE_TOOL_NAME,
    DECOMPOSE_TASK_TOOL_NAME,
    RUN_STEP_TOOL_NAME,
    CHOOSE_TRANSITION_TOOL_NAME,
    SHOW_COST_TOOL_NAME,
  ]);
});

test("decomposeTask runs Planner only and leaves manual stepping untouched", async () => {
  const fx = fixture();
  fx.faux.setResponses(governedPlanTurn());
  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });

  const result = await core.decomposeTask("split this task");

  expect(result.plan.summary).toBe("plan: do X");
  expect(result.cost.phase).toBe("plan");
  expect(core.isStepping()).toBe(false);
  expect(
    fx.sink
      .records()
      .map(({ role }) => role)
      .every((role) => role === "planner"),
  ).toBe(true);
});

test("capability reachable without the chat front: runPipeline drives to a verdict", async () => {
  const fx = fixture();
  const verdict: Verdict = { status: "approved", issues: [], summary: "looks good" };
  approveScenario(fx, verdict);

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  const run = await core.runPipeline("implement X");

  expect(run.result.approved).toBe(true);
  expect(run.result.rounds).toBe(1);
  expect(run.result.verdicts[0]?.status).toBe("approved");
  // plan, code, review each ran as one step.
  expect(run.perStep.map((e) => e.phase)).toEqual(["plan", "code", "review"]);
  // No startConversation / tools were involved -- the core alone reached a verdict.
});

test("conversational core uses coordinator closeout for captured FollowUps", async () => {
  const fx = fixture();
  const verdict: Verdict = { status: "approved", issues: [], summary: "looks good" };
  fx.faux.setResponses([
    ...governedPlanTurn(),
    fauxAssistantMessage(
      fauxToolCall(SUBMIT_FOLLOW_UP_TOOL_NAME, {
        kind: "note",
        title: "Conversational coordinator scenario",
        evidence: [{ summary: "The core captured a durable follow-up" }],
      }),
    ),
    fauxAssistantMessage("coded X"),
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, verdict)),
    fauxAssistantMessage("review complete"),
  ]);

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  const run = await core.runPipeline("implement X");
  expect(run.result.approved).toBe(true);
  const checkpointName = fs
    .readdirSync(path.join(fx.targetDir, ".ad-coder", "runs"))
    .find((name) => name.startsWith("coordinator-"));
  expect(checkpointName).toBeDefined();
  const checkpoint = JSON.parse(
    fs.readFileSync(path.join(fx.targetDir, ".ad-coder", "runs", checkpointName as string), "utf8"),
  ).value;
  expect(checkpoint.phase).toBe("complete");
  expect(checkpoint.followUps).toHaveLength(1);
  expect(
    fs.readFileSync(path.join(fx.targetDir, "docs", "notes", "candidates.md"), "utf8"),
  ).toContain("<!-- ad-coder:");
});

test("unoffered transition is rejected at the core with only the kind", async () => {
  const fx = fixture();
  fx.faux.setResponses(governedPlanTurn());

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  core.beginStepping("implement X");
  const view = await core.stepOnce();

  const unoffered = ALL_KINDS.find((k) => !view.transitions.includes(k));
  expect(unoffered).toBeDefined();

  let caught: unknown;
  try {
    core.chooseTransition(unoffered as TransitionKind);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DriveError);
  expect((caught as DriveError).code).toBe("transition_not_offered");
  expect((caught as DriveError).detail).toBe(unoffered as string);
});

test("unoffered transition is rejected via the choose_transition tool", async () => {
  const fx = fixture();
  fx.faux.setResponses(governedPlanTurn());

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  core.beginStepping("implement X");
  const view = await core.stepOnce();
  const unoffered = ALL_KINDS.find((k) => !view.transitions.includes(k)) as TransitionKind;

  const tools = buildBuiltInPipelineTools(core);
  const chooseTool = tools.find((t) => t.name === CHOOSE_TRANSITION_TOOL_NAME);
  expect(chooseTool).toBeDefined();

  const text = await callTool(chooseTool as Tool, { kind: unoffered });
  // The typed rejection is surfaced as safe text (code + kind), never swallowed.
  expect(text).toContain("transition_not_offered");
  expect(text).toContain(unoffered);
});

test("beginStepping -> stepOnce yields a StepView; chooseTransition advances the phase", async () => {
  const fx = fixture();
  fx.faux.setResponses([...governedPlanTurn(), fauxAssistantMessage("coded X")]);

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  core.beginStepping("implement X");
  const view = await core.stepOnce();

  expect(view.phase).toBe("plan");
  expect(view.transitions.length).toBeGreaterThan(0);
  expect(view.transitions).toContain("advance");

  const next = core.chooseTransition("advance");
  expect(next).toBe("code");
});

test("showCost perStep sums to totalCost", async () => {
  const fx = fixture();
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  const run = await core.runPipeline("implement X");
  const report = core.showCost();

  expect(report.perStep).toHaveLength(run.perStep.length);
  const summed = report.perStep.reduce((sum, e) => sum + e.cost, 0);
  expect(summed).toBe(report.totalCost);
  expect(run.perStep.reduce((sum, e) => sum + e.cost, 0)).toBe(run.totalCost);
});

test("headless orchestrator shares limits across pipeline and manual workflow work", async () => {
  const fx = fixture();
  const controller = new SessionLimitController({ maxTurns: 5 });
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);
  const core = createOrchestrator({
    buildConfig: fx.buildConfig,
    ledgerSink: fx.sink,
    sessionLimitController: controller,
  });

  await core.runPipeline("first task");
  expect(controller.snapshot().admittedTurns).toBe(5);
  core.beginStepping("second task");
  await expect(core.stepOnce()).rejects.toBeInstanceOf(SessionLimitError);
  expect(fx.faux.state.callCount).toBe(5);
  expect(core.showCost().sessionLimits?.admittedTurns).toBe(5);
});

test("run_step tool begins a run from a task and reports the offered transitions", async () => {
  const fx = fixture();
  fx.faux.setResponses(governedPlanTurn());

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  const tools = buildBuiltInPipelineTools(core);
  const runStep = tools.find((t) => t.name === RUN_STEP_TOOL_NAME) as Tool;

  const text = await callTool(runStep, { task: "implement X" });
  expect(text).toContain("step plan");
  expect(text).toContain("offered transitions:");
  expect(core.isStepping()).toBe(true);
});

test("run_step tool without a task and no active run reports a safe precondition error", async () => {
  const fx = fixture();
  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  const tools = buildBuiltInPipelineTools(core);
  const runStep = tools.find((t) => t.name === RUN_STEP_TOOL_NAME) as Tool;

  const text = await callTool(runStep, {});
  expect(text).toContain("no_active_session");
});

test("run_pipeline tool reports approval, rounds, and cost", async () => {
  const fx = fixture();
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  const tools = buildBuiltInPipelineTools(core);
  const runPipelineTool = tools.find((t) => t.name === RUN_PIPELINE_TOOL_NAME) as Tool;

  const text = await callTool(runPipelineTool, { task: "implement X" });
  expect(text).toContain("approved=true");
  expect(text).toContain("rounds=1");
  expect(text).toContain("runId=");
  expect(text).toContain("stage metrics:");
  expect(text).toContain("total cost:");
});

test("resume_pipeline reopens a durable stage pause and completes it", async () => {
  const fx = fixture();
  let stageMaxModelTurns = 1;
  const buildConfig = (task: string): PipelineConfig => ({
    ...fx.buildConfig(task),
    coordinator: { runId: "orchestrator-resume" },
    stageLimits: { maxModelTurns: stageMaxModelTurns },
  });
  const core = createOrchestrator({ buildConfig, ledgerSink: fx.sink });
  fx.faux.setResponses(governedPlanTurn());
  await expect(core.runPipeline("implement X")).rejects.toMatchObject({
    code: "requirements_unresolved",
    detail: "orchestrator-resume",
  });

  stageMaxModelTurns = 8;
  approveScenario(fx, { status: "approved", issues: [], summary: "ok" });
  const resumed = await core.resumePipeline("implement X", "orchestrator-resume");
  expect(resumed.runId).toBe("orchestrator-resume");
  expect(resumed.result.approved).toBe(true);

  const resumeTool = buildBuiltInPipelineTools(core).find(
    (tool) => tool.name === RESUME_PIPELINE_TOOL_NAME,
  );
  expect(resumeTool).toBeDefined();
});

const approvedPipeline: PipelineResult = {
  outcome: "approved",
  approved: true,
  rounds: 1,
  verdicts: [{ status: "approved", issues: [], summary: "ok" }],
  runIds: [],
  stageMetrics: [],
};

test("provider exhaustion durably pauses and uses a safe hint before configured retry", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-provider-limit-"));
  let calls = 0;
  const scheduled: Array<{ id: string; delay: number; callback: () => void }> = [];
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(targetDir),
    id: () => "provider-limited-run",
    config: { retryIntervalMs: 9_000 },
    retryCoordinator: {
      schedule: (id, delay, callback) => scheduled.push({ id, delay, callback }),
      cancel: () => undefined,
    },
    execute: async () => {
      calls += 1;
      if (calls === 1) throw new ProviderLimitError(2_500);
      return { result: approvedPipeline };
    },
    resolveAutoDecision: async () => ({
      action: "accept" as const,
      rationale: "auto mandate",
      evidence: ["docs/contracts/operation-modes.md"],
    }),
  });
  const run = control.start({ requestKey: "provider-limit", task: "work", mode: "auto" });
  expect((await control.resume(run.id)).status).toBe("paused");
  expect(control.status(run.id).externalLimit).toEqual({
    source: "provider",
    state: "exhausted",
    resumable: true,
    retryAfterMs: 2_500,
  });
  expect(scheduled.map(({ id, delay }) => ({ id, delay }))).toEqual([{ id: run.id, delay: 2_500 }]);
  expect(
    control.events(run.id, 0).some((event) => event.type === "run.paused.external_limit"),
  ).toBe(true);
  await scheduled[0]?.callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(control.status(run.id).status).toBe("complete");
  expect(calls).toBe(2);
});

test("retryIntervalMs zero disables provider-hint scheduling", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-provider-no-retry-"));
  let scheduled = 0;
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(targetDir),
    id: () => "provider-no-retry",
    config: { retryIntervalMs: 0 },
    retryCoordinator: {
      schedule: () => {
        scheduled += 1;
      },
      cancel: () => undefined,
    },
    execute: async () => {
      throw new ProviderLimitError(1_000);
    },
    resolveAutoDecision: async () => ({
      action: "accept" as const,
      rationale: "auto mandate",
      evidence: ["docs/contracts/operation-modes.md"],
    }),
  });
  const run = control.start({ requestKey: "provider-no-retry", task: "work", mode: "auto" });
  expect((await control.resume(run.id)).status).toBe("paused");
  expect(scheduled).toBe(0);
});

test("reconstructed provider-limit resume keeps committed stages and reruns only the interrupted stage", async () => {
  const fx = fixture();
  const store = new ProjectStore(fx.targetDir);
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);
  let executions = 0;
  const dependencies = {
    store,
    id: () => "provider-restart-run",
    execute: async (record: { id: string }) => {
      const session = createWorkflowSession({
        ...fx.buildConfig("restart safely"),
        coordinator: { runId: record.id },
      });
      const coordinator = new RunCoordinator(session, store, { runId: record.id });
      executions += 1;
      if (executions === 1) {
        await coordinator.step();
        throw new ProviderLimitError(5_000);
      }
      const completed = await coordinator.run();
      if (completed.result === undefined) throw new Error("missing pipeline result");
      return { result: completed.result };
    },
    resolveAutoDecision: async () => ({
      action: "accept" as const,
      rationale: "auto mandate",
      evidence: ["docs/contracts/operation-modes.md"],
    }),
  };
  const initial = createOrchestratorControlPlane(dependencies);
  const run = initial.start({ requestKey: "provider-restart", task: "work", mode: "auto" });
  expect((await initial.resume(run.id)).status).toBe("paused");
  expect(initial.report(run.id).stageMetrics.map((metric) => metric.stage)).toEqual(["plan"]);
  expect(fx.faux.state.callCount).toBe(2);

  const reconstructed = createOrchestratorControlPlane({
    ...dependencies,
    store: new ProjectStore(fx.targetDir),
  });
  expect((await reconstructed.resume(run.id)).status).toBe("complete");
  expect(reconstructed.report(run.id).stageMetrics.map((metric) => metric.stage)).toEqual([
    "plan",
    "code:1",
    "review:1",
  ]);
  expect(fx.faux.state.callCount).toBe(5);
});

test("automatic provider retries back off and stop at the durable configured ceiling", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-provider-retry-ceiling-"));
  const scheduled: Array<{ delay: number; callback: () => void }> = [];
  const dependencies = {
    store: new ProjectStore(targetDir),
    id: () => "provider-retry-ceiling",
    config: { retryIntervalMs: 2_000, maxAutomaticRetryAttempts: 2 },
    retryCoordinator: {
      schedule: (_id: string, delay: number, callback: () => Promise<void>) =>
        scheduled.push({ delay, callback }),
      cancel: () => undefined,
    },
    execute: async () => {
      throw new ProviderLimitError(1_000);
    },
    resolveAutoDecision: async () => ({
      action: "accept" as const,
      rationale: "auto mandate",
      evidence: ["docs/contracts/operation-modes.md"],
    }),
  };
  const control = createOrchestratorControlPlane(dependencies);
  const run = control.start({ requestKey: "retry-ceiling", task: "work", mode: "auto" });
  expect((await control.resume(run.id)).status).toBe("paused");
  expect(scheduled[0]?.delay).toBe(1_000);
  scheduled.shift()?.callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scheduled[0]?.delay).toBe(2_000);
  scheduled.shift()?.callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scheduled).toHaveLength(0);

  const reconstructed = createOrchestratorControlPlane(dependencies);
  expect((await reconstructed.resume(run.id)).status).toBe("paused");
  expect(scheduled).toHaveLength(0);
});

test("live retry coordinator jitters delays, cancels stale timers, and bounds host admissions", async () => {
  const timers: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started: string[] = [];
  const coordinator = new LiveRetryCoordinator({
    maxConcurrentAdmissions: 1,
    jitterRatio: 0.1,
    random: () => 1,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as { cancelled: boolean }).cancelled = true;
    },
  });
  coordinator.schedule("stale", 10_000, async () => {
    started.push("stale");
  });
  coordinator.cancel("stale");
  coordinator.schedule("first", 10_000, async () => {
    started.push("first");
    await firstGate;
  });
  coordinator.schedule("second", 10_000, async () => {
    started.push("second");
  });

  expect(timers.map((timer) => timer.delay)).toEqual([11_000, 11_000, 11_000]);
  for (const timer of timers) if (!timer.cancelled) timer.callback();
  await Promise.resolve();
  expect(started).toEqual(["first"]);
  releaseFirst?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual(["first", "second"]);
});

test("control-plane start is durable, immediate, idempotent, and reconstructable", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-control-plane-"));
  const ids = ["root-one"];
  let calls = 0;
  const dependencies = {
    store: new ProjectStore(targetDir),
    id: () => ids.shift() as string,
    execute: async () => {
      calls += 1;
      return { result: approvedPipeline };
    },
    resolveAutoDecision: async () => ({
      action: "accept" as const,
      rationale: "auto mandate",
      evidence: ["docs/contracts/operation-modes.md"],
    }),
  };
  const first = createOrchestratorControlPlane(dependencies);
  const started = first.start({ requestKey: "request-one", task: "work", mode: "auto" });
  expect(started.status).toBe("queued");
  expect(calls).toBe(0);
  expect(first.start({ requestKey: "request-one", task: "ignored", mode: "manual" }).id).toBe(
    started.id,
  );

  const reconstructed = createOrchestratorControlPlane({
    ...dependencies,
    store: new ProjectStore(targetDir),
  });
  expect(reconstructed.status(started.id).status).toBe("queued");
  expect((await reconstructed.resume(started.id)).status).toBe("complete");
  expect(calls).toBe(1);
});

test("manual decisions wait for the trusted operator channel while auto records its mandate", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-decisions-"));
  const ids = ["manual-run", "auto-run"];
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(targetDir),
    id: () => ids.shift() as string,
    execute: async () => ({ result: approvedPipeline }),
    resolveAutoDecision: async () => ({
      action: "accept",
      rationale: "contracts settle the choice",
      evidence: ["docs/contracts/operation-modes.md"],
    }),
  });
  const scope = { allowedPaths: ["src"], allowedCapabilities: ["edit"], externalEffects: [] };
  const manual = control.start({ requestKey: "manual", task: "work", mode: "manual", scope });
  const pending = await control.requestDecision(manual.id, {
    action: "edit",
    evidence: ["docs/ROADMAP.md"],
    scope,
  });
  expect(pending.status).toBe("pending");
  expect(control.status(manual.id).status).toBe("awaiting_decision");
  expect(
    control.resolveDecisionFromOperator(manual.id, pending.id, "accept", "approved").status,
  ).toBe("accepted");

  const auto = control.start({ requestKey: "auto", task: "work", mode: "auto", scope });
  const resolved = await control.requestDecision(auto.id, {
    action: "edit",
    evidence: ["docs/ROADMAP.md"],
    scope,
  });
  expect(resolved.status).toBe("accepted");
  expect(resolved.mandateSource).toBe("auto_mode");
  expect(resolved.scope.allowedPaths).toEqual(["src"]);
});

test("default decomposition creates sequential children and stops siblings on a child split", async () => {
  expect(DEFAULT_CONTROL_PLANE_CONFIG.maxDecompositionDepth).toBe(1);
  expect(DEFAULT_CONTROL_PLANE_CONFIG.maxChildPipelines).toBe(0);
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-decomposition-"));
  const ids = ["root-run", "child-one", "child-two"];
  const order: string[] = [];
  const decomposition = {
    ...approvedPipeline,
    outcome: "decomposition_required" as const,
    approved: false,
    verdicts: [{ status: "changes_requested" as const, issues: [], summary: "split" }],
  };
  const scope = { allowedPaths: ["src"], allowedCapabilities: ["edit"], externalEffects: [] };
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(targetDir),
    id: () => ids.shift() as string,
    execute: async (record) => {
      order.push(record.id);
      if (record.depth === 0)
        return {
          result: decomposition,
          children: [
            { task: "one", parentDecisionId: "d", ...scope },
            { task: "two", parentDecisionId: "d", ...scope },
          ],
        };
      return {
        result: decomposition,
        children: [{ task: "nested", parentDecisionId: "d", ...scope }],
      };
    },
    resolveAutoDecision: async () => ({
      action: "accept" as const,
      rationale: "auto mandate",
      evidence: ["docs/contracts/operation-modes.md"],
    }),
  });
  const rootRun = control.start({ requestKey: "decompose", task: "root", mode: "auto", scope });
  expect((await control.resume(rootRun.id)).status).toBe("paused");
  expect(order).toEqual(["root-run", "child-one"]);
  expect(control.record(rootRun.id).remainingChildren).toHaveLength(1);
  const decision = control.record(rootRun.id).decisions.at(-1);
  expect(decision?.status).toBe("accepted");
  expect(
    control.record(control.record(rootRun.id).childRunIds[0] as string).authorizationDecisionId,
  ).toBe(decision?.id);
});

test("concurrent resume executes one provider turn and emits durable completion", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-control-lease-"));
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(targetDir),
    id: () => "leased-run",
    resolveAutoDecision: async () => ({
      action: "accept",
      rationale: "in scope",
      evidence: ["docs/ROADMAP.md"],
    }),
    execute: async () => {
      calls += 1;
      await wait;
      return { result: approvedPipeline };
    },
  });
  const run = control.start({ requestKey: "lease", task: "work", mode: "auto" });
  const first = control.resume(run.id);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect((await control.resume(run.id)).status).toBe("running");
  expect(calls).toBe(1);
  release?.();
  expect((await first).status).toBe("complete");
  expect(control.events(run.id, 0).map((event) => event.type)).toEqual(["run.completed"]);
  expect(control.events(run.id, 1)).toEqual([]);
});

test("control-plane rejects malformed collection inputs before persistence", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-control-validation-"));
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(targetDir),
    execute: async () => ({ result: approvedPipeline }),
  });
  expect(() =>
    control.start({
      requestKey: "bad",
      task: "work",
      mode: "manual",
      scope: { allowedPaths: "src" as unknown as string[] },
    }),
  ).toThrow("invalid_follow_up");
  expect(control.list()).toEqual([]);
  const run = control.start({ requestKey: "good", task: "work", mode: "manual" });
  await expect(
    control.requestDecision(run.id, { action: "", evidence: [], scope: {} }),
  ).rejects.toThrow("invalid_follow_up");
  await expect(control.resume(run.id, { runUntil: "bad" as never })).rejects.toThrow(
    "invalid_config",
  );
});

test("auto admission fails before persistence when no resolver can exercise the mandate", () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-auto-resolver-"));
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(targetDir),
    execute: async () => ({ result: approvedPipeline }),
  });
  expect(() => control.start({ requestKey: "auto", task: "work", mode: "auto" })).toThrow(
    "invalid_config: resolveAutoDecision",
  );
  expect(control.list()).toEqual([]);
});

test("control-plane cancellation is durable and model tools omit manual resolution authority", () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-control-tools-"));
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(targetDir),
    id: () => "manual-cancel",
    execute: async () => ({ result: approvedPipeline }),
  });
  const run = control.start({ requestKey: "manual-cancel", task: "work", mode: "manual" });
  expect(control.cancel(run.id).status).toBe("cancelled");
  expect(control.cancel(run.id).status).toBe("cancelled");
  expect(control.list()).toHaveLength(1);
  const names = buildControlPlaneTools(control).map((tool) => tool.name);
  expect(names).toContain("control_decisions");
  expect(names).not.toContain("control_decision_resolve");
});

test("stage metrics survive reconstruction and model reports expose counts, not read paths", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-control-metrics-"));
  const result: PipelineResult = {
    ...approvedPipeline,
    stageMetrics: [
      {
        stage: "code:1",
        provider: "faux",
        model: "faux-1",
        thinkingLevel: "low",
        durationMs: 123,
        input: 13,
        cachedInput: 5,
        freshInput: 8,
        output: 3,
        reasoning: 2,
        costUsd: 0.012,
        requestBytes: { systemPrompt: 10, prompt: 20, toolDefinitions: 30, total: 60 },
        readFiles: ["src/private-name.ts"],
        readFilesTotal: 1,
        readFilesTruncated: 0,
        diffBytes: 42,
        contextStrategy: "auto",
        pipelineContextStrategy: "full",
        pipelineContextFallbackReason: "risk_changed",
      },
    ],
  };
  const dependencies = {
    store: new ProjectStore(targetDir),
    id: () => "metrics-run",
    execute: async () => ({ result }),
    resolveAutoDecision: async () => ({
      action: "accept" as const,
      rationale: "auto mandate",
      evidence: ["docs/contracts/operation-modes.md"],
    }),
  };
  const control = createOrchestratorControlPlane(dependencies);
  const run = control.start({ requestKey: "metrics", task: "work", mode: "auto" });
  await control.resume(run.id);
  const reconstructed = createOrchestratorControlPlane({
    ...dependencies,
    store: new ProjectStore(targetDir),
  });
  expect(reconstructed.report(run.id).stageMetrics).toEqual(result.stageMetrics);
  const reportTool = buildControlPlaneTools(reconstructed).find(
    (tool) => tool.name === "control_report",
  );
  const safeReport = await callTool(reportTool as Tool, { id: run.id });
  expect(safeReport).toContain('"readFilesTotal":1');
  expect(safeReport).toContain('"model":"faux-1"');
  expect(safeReport).toContain('"durationMs":123');
  expect(safeReport).toContain('"reasoning":2');
  expect(safeReport).toContain('"costUsd":0.012');
  expect(safeReport).toContain('"pipelineContextStrategy":"full"');
  expect(safeReport).toContain('"pipelineContextFallbackReason":"risk_changed"');
  expect(safeReport).not.toContain("private-name");
});

test("mechanical triage forces contracts, elevated security, and large work through pipeline", () => {
  expect(
    triageControlPlaneTask({
      touchesContracts: true,
      securitySurface: "ordinary",
      changeSize: "local",
      reversible: true,
    }),
  ).toBe("pipeline");
  expect(
    triageControlPlaneTask({
      touchesContracts: false,
      securitySurface: "ordinary",
      changeSize: "local",
      reversible: true,
    }),
  ).toBe("inline");
});

test("approved reports bind the exact publish tree and reject a stale worktree", async () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-content-binding-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: targetDir });
    expect(result.exitCode).toBe(0);
  };
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(targetDir, "tracked.txt"), "reviewed\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "base");
  fs.writeFileSync(path.join(targetDir, "tracked.txt"), "approved\n");
  let published = false;
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(targetDir),
    id: () => "binding-run",
    resolveAutoDecision: async () => ({
      action: "accept",
      rationale: "auto mandate",
      evidence: ["docs/contracts/operation-modes.md"],
    }),
    execute: async () => ({ result: approvedPipeline, reviewedPaths: ["tracked.txt"] }),
    publishApproved: async () => {
      published = true;
      return {
        phase: "finished",
        gateStatuses: ["local:passed"],
        recoveryCategories: [],
      };
    },
  });
  const run = control.start({
    requestKey: "binding",
    task: "work",
    mode: "auto",
    scope: { externalEffects: ["publish"] },
  });
  expect((await control.resume(run.id)).status).toBe("complete");
  const report = control.report(run.id);
  expect(report.contentBinding?.publishTreeOid).toMatch(/^[0-9a-f]{40,64}$/);
  fs.writeFileSync(path.join(targetDir, "tracked.txt"), "changed after review\n");
  await expect(control.publish(run.id)).rejects.toThrow("stale_binding");
  expect(published).toBe(false);
});
