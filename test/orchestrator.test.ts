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
  triageControlPlaneTask,
} from "../src/orchestration/control-plane";
import { SUBMIT_FOLLOW_UP_TOOL_NAME } from "../src/orchestration/follow-up";
import {
  buildOrchestratorTools,
  CHOOSE_TRANSITION_TOOL_NAME,
  createOrchestrator,
  RUN_PIPELINE_TOOL_NAME,
  RUN_STEP_TOOL_NAME,
  startOrchestrator,
} from "../src/orchestration/orchestrator";
import { DriveError } from "../src/orchestration/transition-guard";
import type {
  PipelineConfig,
  PipelineResult,
  RoleSpec,
  TransitionKind,
  Verdict,
} from "../src/orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import { ProjectStore } from "../src/project-store/project-store";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import type { Tool } from "../src/runner/tool";
import { SessionLimitController, SessionLimitError } from "../src/session-limits";

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

  const session = await startOrchestrator({
    targetDir,
    env: () => undefined,
    warn: () => {},
    credentials,
    orchestratorThinkingLevel: "high",
    startConversation: async (config) => {
      captured = config.role;
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
});

/** Script a plan -> code -> review(approved) run: one faux queue, in phase order. */
function approveScenario(fx: Fixture, verdict: Verdict): void {
  fx.faux.setResponses([
    fauxAssistantMessage("plan: do X"),
    fauxAssistantMessage("coded X"),
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, verdict)),
    fauxAssistantMessage("review complete"),
  ]);
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
    fauxAssistantMessage("plan: do X"),
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
  fx.faux.setResponses([fauxAssistantMessage("plan: do X")]);

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
  fx.faux.setResponses([fauxAssistantMessage("plan: do X")]);

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  core.beginStepping("implement X");
  const view = await core.stepOnce();
  const unoffered = ALL_KINDS.find((k) => !view.transitions.includes(k)) as TransitionKind;

  const tools = buildOrchestratorTools(core);
  const chooseTool = tools.find((t) => t.name === CHOOSE_TRANSITION_TOOL_NAME);
  expect(chooseTool).toBeDefined();

  const text = await callTool(chooseTool as Tool, { kind: unoffered });
  // The typed rejection is surfaced as safe text (code + kind), never swallowed.
  expect(text).toContain("transition_not_offered");
  expect(text).toContain(unoffered);
});

test("beginStepping -> stepOnce yields a StepView; chooseTransition advances the phase", async () => {
  const fx = fixture();
  fx.faux.setResponses([fauxAssistantMessage("plan: do X"), fauxAssistantMessage("coded X")]);

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
  const controller = new SessionLimitController({ maxTurns: 4 });
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);
  const core = createOrchestrator({
    buildConfig: fx.buildConfig,
    ledgerSink: fx.sink,
    sessionLimitController: controller,
  });

  await core.runPipeline("first task");
  expect(controller.snapshot().admittedTurns).toBe(4);
  core.beginStepping("second task");
  await expect(core.stepOnce()).rejects.toBeInstanceOf(SessionLimitError);
  expect(fx.faux.state.callCount).toBe(4);
  expect(core.showCost().sessionLimits?.admittedTurns).toBe(4);
});

test("run_step tool begins a run from a task and reports the offered transitions", async () => {
  const fx = fixture();
  fx.faux.setResponses([fauxAssistantMessage("plan: do X")]);

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  const tools = buildOrchestratorTools(core);
  const runStep = tools.find((t) => t.name === RUN_STEP_TOOL_NAME) as Tool;

  const text = await callTool(runStep, { task: "implement X" });
  expect(text).toContain("step plan");
  expect(text).toContain("offered transitions:");
  expect(core.isStepping()).toBe(true);
});

test("run_step tool without a task and no active run reports a safe precondition error", async () => {
  const fx = fixture();
  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  const tools = buildOrchestratorTools(core);
  const runStep = tools.find((t) => t.name === RUN_STEP_TOOL_NAME) as Tool;

  const text = await callTool(runStep, {});
  expect(text).toContain("no_active_session");
});

test("run_pipeline tool reports approval, rounds, and cost", async () => {
  const fx = fixture();
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);

  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  const tools = buildOrchestratorTools(core);
  const runPipelineTool = tools.find((t) => t.name === RUN_PIPELINE_TOOL_NAME) as Tool;

  const text = await callTool(runPipelineTool, { task: "implement X" });
  expect(text).toContain("approved=true");
  expect(text).toContain("rounds=1");
  expect(text).toContain("total cost:");
});

const approvedPipeline: PipelineResult = {
  outcome: "approved",
  approved: true,
  rounds: 1,
  verdicts: [{ status: "approved", issues: [], summary: "ok" }],
  runIds: [],
};

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
