import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { startConversation as startConversationImpl } from "../src/conversation/conversation";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import type { LedgerRecord } from "../src/ledger/types";
import { ToolActivityChannel } from "../src/observability/tool-activity";
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
  DELEGATABLE_ROLE_NAMES,
  PIPELINE_EVENTS_TOOL_NAME,
  PIPELINE_RESULT_TOOL_NAME,
  PIPELINE_STATUS_TOOL_NAME,
  type RaisedStageLimits,
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
  Complexity,
  PipelineConfig,
  PipelineResult,
  RoleSpec,
  TransitionKind,
  Verdict,
} from "../src/orchestration/types";
import { OrchestrationError } from "../src/orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { buildDefaultProfile } from "../src/profiles/default-profile";
import { RunCoordinator } from "../src/project-operations/run-coordinator";
import { ProjectStore } from "../src/project-store/project-store";
import { EXPLORE_PROJECT_TOOL_NAME } from "../src/project-tools/explore";
import { READ_PROJECT_TOOL_NAME } from "../src/project-tools/read";
import { SEARCH_PROJECT_TOOL_NAME } from "../src/project-tools/search";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { EmptyTurnError, ProviderLimitError } from "../src/runner/errors";
import type { Tool } from "../src/runner/tool";
import { SessionLimitController, SessionLimitError } from "../src/session-limits";
import { LOAD_SKILL_TOOL_NAME } from "../src/skills/load-tool";
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
  let detachedLaunch:
    | import("../src/orchestration/background-runs").BackgroundDetachedLaunch
    | undefined;

  const session = await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    orchestratorThinkingLevel: "high",
    workflowModules: [BUILT_IN_PIPELINE_WORKFLOW],
    enabledWorkflows: [BUILT_IN_PIPELINE_WORKFLOW_NAME],
    backgroundOwnerId: "console-owner",
    backgroundHostLauncher: (launch) => {
      detachedLaunch = launch;
    },
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
    LOAD_SKILL_TOOL_NAME,
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
  const run = await backgroundRuns.backgroundRuns.startDetached("safe background task");
  expect(detachedLaunch).toMatchObject({ runId: run.runId, task: "safe background task" });
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

test("selected skills are delegated only to compatible roles and retain project overrides", async () => {
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-skills-role-")),
  );
  const skillDir = path.join(targetDir, ".ad-coder", "skills", "task-slicing");
  const instruction = "PROJECT TASK-SLICING INSTRUCTION";
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "skill.json"),
    JSON.stringify({ id: "task-slicing", version: "2", description: "local", roles: ["planner"] }),
  );
  fs.writeFileSync(path.join(skillDir, "instructions.md"), instruction);
  const orchestratorSkillDir = path.join(targetDir, ".ad-coder", "skills", "delivery-calibration");
  const orchestratorInstruction = "PROJECT DELIVERY-CALIBRATION INSTRUCTION";
  fs.mkdirSync(orchestratorSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(orchestratorSkillDir, "skill.json"),
    JSON.stringify({
      id: "delivery-calibration",
      version: "2",
      description: "local",
      roles: ["orchestrator", "planner"],
    }),
  );
  fs.writeFileSync(path.join(orchestratorSkillDir, "instructions.md"), orchestratorInstruction);
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  let orchestrator: Role | undefined;
  let outerTools: Tool[] = [];
  const delegated: Role[] = [];

  await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    selectedSkills: ["task-slicing", "delivery-calibration"],
    enabledWorkflows: [],
    startConversation: async (config) => {
      orchestrator = config.role;
      outerTools = config.tools ?? [];
      return fakeConversation("outer");
    },
    startDelegatedConversation: async (config) => {
      delegated.push(config.role);
      return fakeConversation(config.role.name);
    },
  });
  const runRole = outerTools.find(({ name }) => name === RUN_ROLE_TOOL_NAME) as Tool;
  await callTool(runRole, { role: "planner", task: "make a plan" });
  await callTool(runRole, { role: "reviewer", task: "review the plan" });

  const planner = delegated.find(({ name }) => name === "planner");
  const reviewer = delegated.find(({ name }) => name === "reviewer");
  expect(orchestrator?.systemPrompt).not.toContain(instruction);
  expect(orchestrator?.systemPrompt.match(new RegExp(orchestratorInstruction, "g"))?.length).toBe(
    1,
  );
  expect(planner?.systemPrompt.match(new RegExp(instruction, "g"))?.length).toBe(1);
  expect(planner?.systemPrompt).toContain("## task-slicing@2");
  expect(planner?.systemPrompt).toContain(orchestratorInstruction);
  expect(reviewer?.systemPrompt).not.toContain(instruction);
});

test("run_role projects its thrown errors with reason kept and leak withheld", async () => {
  const tool = buildRunRoleTool(async () => {
    throw new EmptyTurnError("run-abc", "assistant_error");
  });
  expect(await callTool(tool, { role: "auditor", task: "x" })).toBe(
    "error: empty_turn (the provider returned a failed empty turn; verify authentication and retry (provider code assistant_error); run run-abc)",
  );
  // Nothing uncontrolled in an unrecognised error -- message, stack -- may
  // reach the projection; the inert constructor name is the diagnosable part.
  const leak = buildRunRoleTool(async () => {
    throw new Error("boom: /absolute/path and bearer sk_live_123");
  });
  expect(await callTool(leak, { role: "auditor", task: "x" })).toBe(
    "error: an unexpected internal error occurred (Error)",
  );
  // code+detail passthrough keeps its compat shape (also asserted above for
  // invalid_role).
  const typed = buildRunRoleTool(async () => {
    throw new OrchestrationError("empty_task", "or_detail", "authored");
  });
  expect(await callTool(typed, { role: "auditor", task: "x" })).toBe(
    "error: empty_task (or_detail)",
  );
});

test("run_role delegates independently and rejects unknown role names safely", async () => {
  const calls: Array<{ role: string; task: string; complexity?: string | undefined }> = [];
  const tool = buildRunRoleTool(async (role, task, complexity) => {
    calls.push({ role, task, complexity });
    return { role, text: "focused result", cost: 0.25 };
  });

  expect(await callTool(tool, { role: "auditor", task: "inspect health" })).toContain(
    "auditor complete (cost 0.25)\nfocused result",
  );
  expect(calls).toEqual([{ role: "auditor", task: "inspect health", complexity: undefined }]);
  expect(await callTool(tool, { role: "coder", task: "fix it", complexity: "trivial" })).toContain(
    "coder complete",
  );
  expect(calls[1]).toEqual({ role: "coder", task: "fix it", complexity: "trivial" });
  expect(await callTool(tool, { role: "publisher", task: "publish" })).toBe(
    "error: invalid_role (publisher)",
  );
  expect(calls).toHaveLength(2);
});

test('run_role renders a closed-out stage without claiming "complete" (issue #327)', async () => {
  const tool = buildRunRoleTool(async (role) => ({
    role,
    text: "partial result",
    cost: 0.4,
    stageCloseout: {
      code: "stage_closeout",
      reason: "tool_turns",
      detail: "1/2 tool turns used, 1 reserved",
    },
  }));
  const text = await callTool(tool, { role: "auditor", task: "inspect health" });
  expect(text).toContain("auditor closed out early (cost 0.4) stage_closeout reason=tool_turns");
  expect(text).toContain("detail=1/2 tool turns used, 1 reserved");
  expect(text).toContain("partial result");
  expect(text).not.toContain("complete");
});

test("run_role routes the delegate on the orchestrator's classified tier (issues #263/#264)", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-classified-")));
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  // The coder row varies per complexity, so the delegated model id shows which
  // cell the tier chose: without a tier the CONSTANT default (medium) applies;
  // with one, the assessment does.
  const profile = buildDefaultProfile({
    strong: "codex-astra",
    mid: "codex-terra",
    cheap: "codex-luna",
  });
  let outerTools: Tool[] = [];
  const delegated: Array<{ role: string; modelId: string }> = [];
  await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    profile,
    enabledWorkflows: [],
    startConversation: async (config) => {
      outerTools = config.tools ?? [];
      return fakeConversation("outer");
    },
    startDelegatedConversation: async (config) => {
      delegated.push({ role: config.role.name, modelId: config.model.id });
      return fakeConversation(config.role.name);
    },
  });
  const runRole = outerTools.find(({ name }) => name === RUN_ROLE_TOOL_NAME) as Tool;
  await callTool(runRole, { role: "coder", task: "fix", complexity: "complex" });
  await callTool(runRole, { role: "coder", task: "fix" });
  await callTool(runRole, { role: "coder", task: "fix", complexity: "trivial" });

  expect(delegated.map(({ modelId }) => modelId)).toEqual([
    // Registry aliases map the codex names to registered models -- the cells
    // themselves are what the tier changes.
    "gpt-6-astra",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]);
}, 20000);

async function classificationFauxCore(fx: Fixture) {
  const seen: Array<{
    task: string;
    complexity?: Complexity | undefined;
    raised?: RaisedStageLimits | undefined;
  }> = [];
  const core = createOrchestrator({
    buildConfig: (task, complexity, raised) => {
      seen.push({ task, complexity, raised });
      return fx.buildConfig(task);
    },
    ledgerSink: fx.sink,
  });
  return { core, seen };
}

test("the orchestrator core dispatches the classified tier into the per-run config (issues #263/#264)", async () => {
  const fx = fixture();
  fx.faux.setResponses(governedPlanTurn());
  const { core, seen } = await classificationFauxCore(fx);

  await core.decomposeTask("split this task", "trivial");
  expect(seen[0]).toEqual({ task: "split this task", complexity: "trivial" });

  // Manual stepping carries the tier too, up front, with no provider turn.
  fx.faux.setResponses(governedPlanTurn());
  core.beginStepping("step the run", "complex");
  expect(seen[1]).toEqual({ task: "step the run", complexity: "complex" });
});

test("the run_pipeline tool carries the classified tier into the run (issues #263/#264)", async () => {
  const fx = fixture();
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);
  const { core, seen } = await classificationFauxCore(fx);
  const runPipelineTool = buildOrchestratorTools(core, [], [BUILT_IN_PIPELINE_WORKFLOW]).find(
    ({ name }) => name === RUN_PIPELINE_TOOL_NAME,
  ) as Tool;

  await callTool(runPipelineTool, { task: "implement X", complexity: "complex" });
  expect(seen).toEqual([{ task: "implement X", complexity: "complex" }]);
});

test("resume_pipeline carries a raised ceiling into the run, and refuses a malformed one (#208)", async () => {
  const fx = fixture();
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);
  const { core, seen } = await classificationFauxCore(fx);
  const resumeTool = buildOrchestratorTools(core, [], [BUILT_IN_PIPELINE_WORKFLOW]).find(
    ({ name }) => name === RESUME_PIPELINE_TOOL_NAME,
  ) as Tool;

  // The correction operator-flow.md requires: a stage that exhausted its
  // ceiling on progressing work resumes at a LARGER one. The coordinator
  // refuses an unchanged number ("unchanged <reason> stage limit"), so without
  // this path the contract's own rule was unreachable from inside a run.
  await callTool(resumeTool, {
    task: "finish the work",
    runId: "run-1",
    raiseRole: "coder",
    raiseReason: "input",
    raiseLimit: 800_000,
  });
  expect(seen[0]?.raised).toEqual({ role: "coder", reason: "input", limit: 800_000 });

  // A resume with no raise still works: not every pause is a ceiling.
  await callTool(resumeTool, { task: "finish the work", runId: "run-1" });
  expect(seen[1]?.raised).toBeUndefined();

  // Each field is checked against the shipped unions rather than trusted, and
  // a refusal names what was wrong instead of silently dropping the parameter.
  const unknownRole = await callTool(resumeTool, {
    task: "t",
    runId: "run-1",
    raiseRole: "typist",
    raiseReason: "input",
    raiseLimit: 1,
  });
  expect(unknownRole).toContain("typist");
  const unknownReason = await callTool(resumeTool, {
    task: "t",
    runId: "run-1",
    raiseRole: "coder",
    raiseReason: "vibes",
    raiseLimit: 1,
  });
  expect(unknownReason).toContain("vibes");
  const partial = await callTool(resumeTool, {
    task: "t",
    runId: "run-1",
    raiseRole: "coder",
  });
  expect(partial).toContain("together or not at all");

  // A raise of 0 would DISABLE the ceiling, and the coordinator's guard
  // short-circuits on a resolved zero -- so zero would slip past the
  // unchanged-ceiling protection this path exists to satisfy. Raising is not
  // disabling (found in review of d933625).
  const zero = await callTool(resumeTool, {
    task: "t",
    runId: "run-1",
    raiseRole: "coder",
    raiseReason: "input",
    raiseLimit: 0,
  });
  expect(zero).toContain("greater than 0");
});

test("a raise is validated at the core boundary, not only at the tool (#208)", async () => {
  const fx = fixture();
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);
  const { core, seen } = await classificationFauxCore(fx);

  // `resumePipeline` is exported: a library caller never passes the tool's
  // parameter parsing, so validation living only there would let an unmatched
  // overlay through and fail later on the coordinator's "unchanged ceiling"
  // guard -- a message about the wrong thing entirely.
  // The offending value rides in `detail` -- the field safeErrorText surfaces
  // to a model -- while `message` carries the authored guidance.
  await expect(
    core.resumePipeline("t", "run-1", {
      role: "typist" as never,
      reason: "input",
      limit: 1,
    }),
  ).rejects.toMatchObject({ code: "invalid_raise", detail: expect.stringContaining("typist") });
  await expect(
    core.resumePipeline("t", "run-1", { role: "coder", reason: "input", limit: 0 }),
  ).rejects.toMatchObject({
    code: "invalid_raise",
    detail: expect.stringContaining("greater than 0"),
  });
  expect(seen).toEqual([]);
});

test("run_role description states the session's live delegates, models, and world when facts exist", async () => {
  const tool = buildRunRoleTool(async () => ({ role: "coder", text: "", cost: 0 }), {
    route: {
      source: 'inventory "test-go"',
      complexity: "medium",
      groups: [
        { model: "flash", roles: ["planner", "researcher"] },
        { model: "ds41", roles: ["coder", "reviewer"] },
      ],
      unreachable: ["auditor"],
    },
    workflows: [],
  });
  const live = tool.description;
  expect(live).toContain(
    'inventory "test-go" | complexity "medium" | flash: planner, researcher | ds41: coder, reviewer | not configured: auditor',
  );
  expect(live).toContain("roles-only mode");
  expect(live).toContain("role-selection");
  // Security is only absent when the profile leaves it unrouted; here it is
  // mapped, so the description cannot call it unconfigured.
  expect(live).toContain("coder, reviewer");

  const pipelineWorld = buildRunRoleTool(
    async () => ({
      role: "coder",
      text: "",
      cost: 0,
    }),
    {
      route: {
        source: 'provider "test"',
        complexity: "low",
        groups: [{ model: "m1", roles: ["coder"] }],
        unreachable: [],
      },
      workflows: ["pipeline"],
    },
  ).description;
  expect(pipelineWorld).toContain("roles plus workflow mode (pipeline)");
  // Without session facts, the tool keeps the plain role list it always had.
  expect(
    buildRunRoleTool(async () => ({ role: "coder", text: "", cost: 0 })).description,
  ).toContain("Available roles: planner, researcher, security, coder, reviewer, auditor");
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

test("startOrchestrator renders the delegated tool description from the resolved session, not prose", async () => {
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-runrole-live-")),
  );
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  let outerTools: Tool[] = [];
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
  });
  const description = (outerTools.find(({ name }) => name === RUN_ROLE_TOOL_NAME) as Tool)
    .description;
  // Live facts come from the resolved config, matching what the startup banner
  // prints -- model names and the roles routed to them, not a memorized list.
  expect(description).toContain('provider "openai-codex" | complexity "medium"');
  expect(description).toContain("Sol: planner, researcher, coder, security");
  expect(description).toContain("Terra: reviewer, auditor");
  expect(description).toContain("roles-only mode");
}, 20000);

test("every delegated role's activeToolNames names a tool the conversation registers", async () => {
  // #236: a delegated role's tool list was assembled from resolver output. The
  // reviewer inherited `submit_verdict` / `submit_follow_up` by name without
  // any registered object behind them, so the provider rejected the whole
  // request (`configured_tools_unavailable`) and the turn settled empty --
  // invisibly to every gate, because none of the seven exercises a live
  // provider. The harness registers bash/read/write/edit plus the custom
  // tools passed to the conversation, so the invariant is: every name in a
  // delegated role's `activeToolNames` must be in that set.
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-delegated-")));
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  let outerTools: Tool[] = [];
  const delegated: Array<{ role: Role; toolNames: string[] }> = [];
  await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    enabledWorkflows: [],
    startConversation: async (config) => {
      outerTools = config.tools ?? [];
      return fakeConversation("outer");
    },
    startDelegatedConversation: async (config) => {
      delegated.push({
        role: config.role,
        toolNames: (config.tools ?? []).map(({ name }) => name),
      });
      return fakeConversation(config.role.name);
    },
  });
  const runRole = outerTools.find(({ name }) => name === RUN_ROLE_TOOL_NAME) as Tool;
  for (const name of DELEGATABLE_ROLE_NAMES) {
    await callTool(runRole, { role: name, task: "say ok" });
  }

  expect(delegated.map(({ role }) => role.name)).toEqual([...DELEGATABLE_ROLE_NAMES]);
  for (const { role, toolNames } of delegated) {
    // Registered tool objects exactly as `startConversation` builds them: its
    // built-in bash/read/write/edit plus every custom tool the delegate gets.
    const registered = new Set(["bash", "read", "write", "edit", ...toolNames]);
    for (const activeToolName of role.activeToolNames ?? []) {
      expect(registered.has(activeToolName)).toBe(true);
    }
  }
});

test("a declared cacheRetention survives into the orchestrator's own conversation role", async () => {
  // `resolve-config` resolves this correctly, so the only way it can fail is by
  // being discarded again when `startOrchestrator` builds the conversation role
  // -- which is a DIFFERENT construction path from the routed roles, and one no
  // test reached. It hardcoded "short" while reading every neighbouring field
  // off the same spec, so a declared "long" was silently dropped for the role
  // the operator actually talks to.
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-orchestrator-cache-")),
  );
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  const profile = buildDefaultProfile({
    strong: "codex-astra",
    mid: "codex-terra",
    cheap: "codex-luna",
  });
  // Declared on the orchestrator's OWN cell, which is what it routes from.
  profile.entries = profile.entries.map((entry) =>
    entry.role === "orchestrator" ? { ...entry, cacheRetention: "long" as const } : entry,
  );
  let captured: Role | undefined;
  const session = await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    profile,
    enabledWorkflows: [],
    startConversation: async (config) => {
      captured = config.role;
      return fakeConversation("cache-session");
    },
  });
  expect(captured?.cacheRetention).toBe("long");
  await session.close();
});

test("delegated role activity reaches one session-wide subscriber", async () => {
  // Every conversation that is handed no channel builds its own, so before this
  // the `run_role` worker published where nobody could subscribe: a console
  // watching the session saw only the orchestrator's own tool calls while a
  // delegated role ran for minutes. The seam below stands in for that worker
  // and publishes exactly as the real runner does.
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-shared-activity-")),
  );
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  let outerTools: Tool[] = [];
  let outerChannel: ToolActivityChannel | undefined;
  let delegatedChannel: ToolActivityChannel | undefined;
  const session = await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    enabledWorkflows: [],
    startConversation: async (config) => {
      outerTools = config.tools ?? [];
      outerChannel = config.activityChannel;
      return fakeConversation("outer");
    },
    startDelegatedConversation: async (config) => {
      delegatedChannel = config.activityChannel;
      return {
        ...fakeConversation(config.role.name),
        step: async () => {
          config.activityChannel?.publish({
            lifecycle: "completed",
            activity: "Read",
            role: config.role.name,
            runId: "delegated-run",
            operationId: "op",
            turnId: "turn",
            toolCallId: "call",
            parentOperation: "step",
            toolName: "read",
          });
          return {
            runId: config.role.name,
            step: "turn:1",
            status: "completed",
            assistantText: "focused result",
            toolCalls: [],
            droppedRecords: 0,
          };
        },
      };
    },
  });
  const seen: string[] = [];
  const unsubscribe = session.subscribeToolActivity?.((event) => {
    if (event.type === "tool_activity") seen.push(`${event.role}:${event.toolName}`);
  });

  const runRole = outerTools.find(({ name }) => name === RUN_ROLE_TOOL_NAME) as Tool;
  await callTool(runRole, { role: "planner", task: "make a plan" });

  expect(outerChannel).toBeDefined();
  // One channel, not two: the delegated worker publishes where the session's
  // subscriber is listening.
  expect(delegatedChannel).toBe(outerChannel as ToolActivityChannel);
  expect(seen).toEqual(["planner:read"]);
  unsubscribe?.();
  await session.close();
});

test("a caller-supplied activity channel outlives the orchestrated session", async () => {
  // The console constructs a renderer before the session and may keep it after:
  // closing a channel the orchestrator did not create would break that, and
  // re-subscribing a supplied consumer per conversation would double-render.
  const targetDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-supplied-activity-")),
  );
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  const activityChannel = new ToolActivityChannel();
  const rendered: string[] = [];
  const session = await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    enabledWorkflows: [],
    activityChannel,
    activityConsumer: (event) => {
      if (event.type === "tool_activity") rendered.push(event.role);
    },
    startConversation: async () => fakeConversation("outer"),
  });
  const event = {
    lifecycle: "completed",
    activity: "Read",
    role: "coder",
    runId: "run",
    operationId: "op",
    turnId: "turn",
    toolCallId: "call",
    parentOperation: "step",
    toolName: "read",
  } as const;

  activityChannel.publish(event);
  // Subscribed exactly once against the supplied channel: a consumer attached
  // per conversation instead would render the same event more than once.
  expect(rendered).toEqual(["coder"]);

  await session.close();
  expect(activityChannel.snapshot().closed).toBe(false);
  activityChannel.publish(event);
  // Closing the session detached the consumer, so no stray render arrives, and
  // the channel itself stays usable for whoever built it.
  expect(rendered).toEqual(["coder"]);
  await activityChannel.close();
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
    code: "pipeline_paused",
    detail: "orchestrator-resume",
    pause: { code: "stage_limit", limitReason: "model_turns", limit: 1 },
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

test("resume_pipeline clears a plan_not_submitted pause and re-runs the plan stage", async () => {
  // The missing half of issue #315: the coordinator records a planner that
  // produced no submission as an explicitly resumable pause, but the resume act
  // cleared only the stage codes, so a live resume returned the same pause
  // instantly with zero planner invocations (run e4ccfbdb-37b1-47bd-8bc3-3d5e6ac5372f).
  const fx = fixture();
  const runId = "orchestrator-plan-resume";
  const buildConfig = (task: string): PipelineConfig => ({
    ...fx.buildConfig(task),
    coordinator: { runId },
  });
  const core = createOrchestrator({ buildConfig, ledgerSink: fx.sink });

  // One prose planner response: no submit_plan call -> durable pause.
  fx.faux.setResponses([fauxAssistantMessage("prose plan, no tool call")]);
  await expect(core.runPipeline("implement X")).rejects.toMatchObject({
    code: "pipeline_paused",
    detail: runId,
    pause: { phase: "plan", code: "plan_not_submitted" },
  });
  const callsBeforeResume = fx.faux.state.callCount;
  expect(callsBeforeResume).toBe(2);

  approveScenario(fx, { status: "approved", issues: [], summary: "ok" });
  const resumed = await core.resumePipeline("implement X", runId);

  // Same runId, the run completed, and the plan stage re-ran for real: the
  // coordinator appended it now, before the pause there was no plan stage row.
  expect(resumed.runId).toBe(runId);
  expect(resumed.result.approved).toBe(true);
  const planStages = resumed.result.stageMetrics.filter((s) => s.stage === "plan");
  expect(planStages).toHaveLength(1);
  expect(fx.faux.state.callCount).toBeGreaterThan(callsBeforeResume);
  // The resume reused the existing checkpoint rather than starting a new run.
  expect(
    fs
      .readdirSync(path.join(fx.targetDir, ".ad-coder", "runs"))
      .filter((f) => f.startsWith("coordinator-")),
  ).toEqual([`coordinator-${runId}.json`]);
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

test("an orchestrated session names its ledger file and delegated rows land in it", async () => {
  // Regression. `startOrchestrator` installs a READABLE MemoryLedgerSink so
  // `show_cost` and the per-step cost arithmetic can read the session back, and
  // that sink REPLACED the durable file sink a headless `ad-coder role` gets. A
  // whole conversational session -- every delegated `run_role` turn included --
  // therefore left nothing under `.ad-coder/ledger`. Nothing else on the wire
  // can stand in for it either: `ConversationToolCall` carries tool NAMES only,
  // so after the fact only a ledger row stepped `role:<name>` proves which role
  // was actually delegated.
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-evidence-")));
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  /** One row shaped exactly as the real per-turn Ledger emits it. */
  const row = (role: string, step: string) => ({
    ts: 1_757_000_000_000,
    runId: "evidence-run",
    lane: "main",
    role,
    step,
    provider: "faux",
    model: "faux-1",
    stopReason: "stop",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
    },
  });
  let outerTools: Tool[] = [];
  const session = await startOrchestrator({
    targetDir,
    runId: "evidence-run",
    env: () => undefined,
    warn: () => {},
    credentials,
    enabledWorkflows: [],
    startConversation: async (config) => {
      outerTools = config.tools ?? [];
      config.ledgerSink?.write(row("orchestrator", "turn:1"));
      return fakeConversation("outer");
    },
    // Stands in for the delegated worker, which writes through the sink it is
    // handed; `run_role` supplies the `role:<name>` step around it.
    startDelegatedConversation: async (config) => {
      config.ledgerSink?.write(row(config.role.name, "role:planner"));
      return fakeConversation("planner");
    },
  });

  const expected = path.join(targetDir, ".ad-coder", "ledger", "evidence-run.jsonl");
  // The conversation itself reports `undefined` because it was handed a sink;
  // a front that cannot name the file cannot point an operator at the evidence.
  expect(session.ledgerPath).toBe(expected);

  const runRole = outerTools.find(({ name }) => name === RUN_ROLE_TOOL_NAME) as Tool;
  await callTool(runRole, { role: "planner", task: "make a plan" });
  await session.close();

  const rows = fs
    .readFileSync(expected, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { role: string; step: string });
  expect(rows.map(({ step }) => step)).toEqual(["turn:1", "role:planner"]);
  // What the bench asserts on: the delegation is provable from disk alone.
  expect(rows.some(({ role, step }) => role === "planner" && step === "role:planner")).toBe(true);
});

test("without --resume the orchestrator still mints a fresh session per start", async () => {
  // The default flow is byte-identical: no run id reaches the front, so every
  // start mints its own id, its own durable session and its own ledger file.
  // This is the shape `--resume` must never disturb.
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-fresh-")));
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  const common = {
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    enabledWorkflows: [],
    // The REAL conversation, turn-free: minting a durable session is the
    // behavior a second start must not disturb, so the fake that only returns
    // a session object cannot stand in here.
    startConversation: async (
      config: import("../src/conversation/conversation").ConversationConfig,
    ) => startConversationImpl(config),
  };
  const first = await startOrchestrator({ ...common });
  const second = await startOrchestrator({ ...common });
  await first.close();
  await second.close();

  // The orchestrator reports the ledger paths it minted; the durable sessions
  // carry the same ids (conversation.ts reuses the run id for the session). A
  // turn-free start writes no rows, and the sink creates its file lazily, so
  // the ledger directory may not exist -- the MINTED path is the observable.
  expect(first.ledgerPath).toBeDefined();
  expect(second.ledgerPath).toBeDefined();
  expect(first.ledgerPath).not.toBe(second.ledgerPath);
  const mintedIds = [first.ledgerPath, second.ledgerPath].map((p) =>
    path.basename(p as string).replace(".jsonl", ""),
  );
  const store = new ProjectStore(targetDir);
  const sessions = (await store.listSessions()).map(({ id }) => id).sort();
  expect(sessions).toEqual([...mintedIds].sort());
  await store.close();
});

test("--resume's run id reopens the durable session with prior history visible", async () => {
  // Process one (a previous console): a conversation over the run's durable
  // session wrote history. Built with a faux model exactly the way
  // test/conversation.test.ts drives a real front, so the prior entries are
  // genuine session entries, not fixture data.
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-reopen-")));
  const priorFaux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const priorModels = createModels();
  priorModels.setProvider(priorFaux.provider);
  const priorModel = priorFaux.getModel() as Model<Api>;
  const priorRole = defineRole(
    {
      name: "orchestrator",
      provider: "faux",
      modelId: priorModel.id,
      systemPrompt: "You orchestrate.",
      cacheRetention: "none",
      contextBudget: { ...BUDGET },
    },
    priorModel,
  );
  priorFaux.setResponses([fauxAssistantMessage("prior answer")]);
  const previous = await startConversationImpl({
    role: priorRole,
    targetDir,
    models: priorModels,
    model: priorModel,
    runId: "resumable-run",
  });
  await previous.step("prior question");
  await previous.close();

  // Process two (the resumed console): the SAME run id reaches the front's
  // real startConversation, whose openOrCreateSession opens the existing
  // durable session -- never a duplicate.
  let frontRunId: string | undefined;
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  const session = await startOrchestrator({
    targetDir,
    runId: "resumable-run",
    env: () => undefined,
    warn: () => {},
    credentials,
    enabledWorkflows: [],
    startConversation: async (config) => {
      frontRunId = config.runId;
      return startConversationImpl(config);
    },
  });
  await session.close();

  expect(frontRunId).toBe("resumable-run");
  const store = new ProjectStore(targetDir);
  expect((await store.listSessions()).map(({ id }) => id)).toEqual(["resumable-run"]);
  // The prior conversation's entries are in the REOPENED session -- history a
  // post-restart turn would see.
  const durable = await store.resumeSession("resumable-run");
  const entries = await durable.findEntries({ type: "message" }, BACKGROUND_CONTEXT);
  expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
  await durable.close(BACKGROUND_CONTEXT);
  await store.close();
});

test("a resumed session's show_cost is cumulative over the seeded prior rows", async () => {
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cost-")));
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  const row = (role: string, step: string, total: number): LedgerRecord => ({
    ts: 1_757_000_000_000,
    runId: "costed-run",
    lane: "main",
    role,
    step,
    provider: "faux",
    model: "faux-1",
    stopReason: "stop",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    },
  });
  let outerTools: Tool[] = [];
  const session = await startOrchestrator({
    targetDir,
    runId: "costed-run",
    env: () => undefined,
    warn: () => {},
    credentials,
    // The core is what show_cost reads through: built exactly when the console
    // enables the pipeline workflow.
    workflowModules: [BUILT_IN_PIPELINE_WORKFLOW],
    enabledWorkflows: [BUILT_IN_PIPELINE_WORKFLOW_NAME],
    seedLedgerRecords: [row("orchestrator", "turn:1", 0.25), row("coder", "role:coder", 0.5)],
    startConversation: async (config) => {
      outerTools = config.tools ?? [];
      return fakeConversation("outer");
    },
  });
  const showCost = outerTools.find(({ name }) => name === SHOW_COST_TOOL_NAME) as Tool;
  const text = await callTool(showCost, {});
  await session.close();

  // The restarted cost view sums the PRE-RESTART rows (0.25 + 0.5); no step
  // ran through the pipeline, so the total is the seeds alone.
  expect(text.startsWith("total cost: 0.75")).toBe(true);
});

test("a seeded readable sink replays prior rows without rewriting the mirror", async () => {
  // The resume path reads the ledger a previous process wrote durably and
  // hands the rows back so the restarted session's cost view starts where
  // that run left off. Seeding must fill ONLY the in-memory view: the mirror
  // file is append-only and already holds those rows, so seeding through
  // write() would duplicate history on disk. Pinned here by byte-compare.
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-seed-")));
  const credentials: CredentialStore = {
    read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => {},
  };
  const row = (role: string, step: string, total: number): LedgerRecord => ({
    ts: 1_757_000_000_000,
    runId: "seeded-run",
    lane: "main",
    role,
    step,
    provider: "faux",
    model: "faux-1",
    stopReason: "stop",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    },
  });
  const seeded: LedgerRecord[] = [
    row("orchestrator", "turn:1", 0.25),
    row("coder", "role:coder", 0.5),
  ];
  let readBack: readonly LedgerRecord[] | undefined;
  const ledgerPath = path.join(targetDir, ".ad-coder", "ledger", "seeded-run.jsonl");
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
  // The real writer creates ledger files 0600; the sink refuses to append to
  // anything looser, so the fixture does the same.
  fs.writeFileSync(ledgerPath, `${seeded.map((r) => JSON.stringify(r)).join("\n")}\n`, {
    mode: 0o600,
  });
  const before = fs.readFileSync(ledgerPath, "utf8");

  const session = await startOrchestrator({
    targetDir,
    runId: "seeded-run",
    env: () => undefined,
    warn: () => {},
    credentials,
    enabledWorkflows: [],
    seedLedgerRecords: seeded,
    startConversation: async (config) => {
      // startOrchestrator always hands the front a MemoryLedgerSink; the
      // LedgerSink interface itself is write-only, so read back through the
      // concrete type the orchestrator guarantees.
      readBack = (config.ledgerSink as MemoryLedgerSink).records();
      config.ledgerSink?.write(row("orchestrator", "turn:2", 0.25));
      return fakeConversation("outer");
    },
  });
  await session.close();

  // The front's view is cumulative: both seeded rows plus its own new row.
  expect(readBack?.length).toBe(3);
  // The mirror gained only the genuinely new row: the seeded rows are on it
  // exactly ONCE (they were there before the restart) and never replayed.
  const after = fs.readFileSync(ledgerPath, "utf8");
  const lines = after.split("\n").filter(Boolean);
  expect(lines).toHaveLength(3);
  expect(lines.map((l) => (JSON.parse(l) as { step: string }).step)).toEqual([
    "turn:1",
    "role:coder",
    "turn:2",
  ]);
  // Byte-exact: the file is precisely what the previous run left plus the new
  // row -- no duplicated seed, no rewrite.
  expect(after).toBe(`${before}${JSON.stringify(row("orchestrator", "turn:2", 0.25))}\n`);
});
