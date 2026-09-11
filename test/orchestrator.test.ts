import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import {
  buildOrchestratorTools,
  CHOOSE_TRANSITION_TOOL_NAME,
  createOrchestrator,
  RUN_PIPELINE_TOOL_NAME,
  RUN_STEP_TOOL_NAME,
} from "../src/orchestration/orchestrator";
import { DriveError } from "../src/orchestration/transition-guard";
import type { PipelineConfig, RoleSpec, TransitionKind, Verdict } from "../src/orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import type { Tool } from "../src/runner/tool";

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

  const defaultTools = ["bash", "read", "write", "edit"];
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
