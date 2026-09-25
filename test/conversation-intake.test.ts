import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type DurableIntakeRecord, ProjectStoreIntakeStore } from "../src/orchestration/intake";
import {
  buildBuiltInPipelineTools,
  RUN_PIPELINE_TOOL_NAME,
  RUN_ROLE_TOOL_NAME,
  startOrchestrator,
} from "../src/orchestration/orchestrator";
import type { PipelineResult } from "../src/orchestration/types";
import { ProjectStore } from "../src/project-store/project-store";
import type { Tool } from "../src/runner/tool";
import { BUILT_IN_PIPELINE_WORKFLOW } from "../src/workflows/builtin-pipeline";

/**
 * The conversation-intake surface (audit slice
 * docs/reviews/slices/orchestrator-g2b-conversation-intake.md, verdict
 * `violating`): a delegated `run_role` turn is provider work like any other
 * dispatch, so it starts only behind the SAME intake/budget seam the gated
 * run_pipeline/start_pipeline tools call -- ONE gate, not a second one, and
 * no refusal of an ordinary conversational start. Assertions go against the
 * durable RECORD, not the tool's prose.
 */

const TASK = "fix the flaky login test in src/auth/login.test.ts";
const OUTCOME_PLACEHOLDER =
  "run the stated task under the counter-estimated whole-task budget recorded at the pre-work gate";

const tempTarget = (label: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ad-coder-intake-${label}-`)));

const credentials = {
  read: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
  list: async () => [],
  modify: async (_providerId: string, fn: (v: undefined) => undefined) => fn(undefined),
  delete: async () => {},
};

interface FakeTurnResult {
  runId: string;
  step: string;
  status: "completed";
  assistantText: string;
  toolCalls: never[];
  droppedRecords: number;
}

interface FakeConversation {
  runId: string;
  ledgerPath: undefined;
  step: (task: string) => Promise<FakeTurnResult>;
  close: () => Promise<void>;
  whenSettled: () => Promise<void>;
}

const fakeConversation = (runId: string, onStep?: (task: string) => void): FakeConversation => ({
  runId,
  ledgerPath: undefined,
  step: async (task) => {
    onStep?.(task);
    return {
      runId,
      step: "turn:1",
      status: "completed",
      assistantText: "delegated result text",
      toolCalls: [],
      droppedRecords: 0,
    };
  },
  close: async () => {},
  whenSettled: () => Promise.resolve(undefined),
});

const callTool = async (tool: Tool, params: Record<string, unknown>): Promise<string> => {
  const execute = tool.execute as unknown as (
    id: string,
    p: unknown,
  ) => Promise<{ content: Array<{ text: string }> }>;
  const result = await execute("tc-test", params);
  return result.content.map((c) => c.text).join("");
};

const readRecord = (target: string, task: string): DurableIntakeRecord | undefined =>
  new ProjectStoreIntakeStore(new ProjectStore(target)).get(
    ProjectStoreIntakeStore.idForTask(task),
  );

let outerTools: Tool[] = [];

/**
 * Start a session with the delegated seam stubbed `onStep`-aware; every
 * startDelegatedConversation record that `onStep` observes runs BEFORE the
 * delegate turn's notional provider work.
 */
const startGatedSession = async (
  target: string,
  onDelegatedStep?: (task: string) => void,
): Promise<Tool> => {
  const delegated: string[] = [];
  await startOrchestrator({
    targetDir: target,
    env: () => undefined,
    warn: () => {},
    credentials: credentials as never,
    workflowModules: [BUILT_IN_PIPELINE_WORKFLOW],
    enabledWorkflows: [],
    startConversation: async ({ tools }: { tools?: Tool[]; role: { name: string } }) => {
      if (!tools) throw new Error("outer conversation has no tools bound");
      outerTools = tools;
      return fakeConversation("outer");
    },
    startDelegatedConversation: async ({ role }: { role: { name: string } }) => {
      delegated.push(role.name);
      return fakeConversation(`d-${role.name}`, onDelegatedStep);
    },
  });
  const runRole = outerTools.find((t) => t.name === RUN_ROLE_TOOL_NAME);
  if (runRole === undefined) throw new Error("run_role missing from the assembled session");
  return runRole;
};

// ---------------------------------------------------------------------------
// (a) + (b): a run_role start records intake and a budget decision BEFORE the
// delegate turn runs; the unstated-budget case proceeds via counter-estimate
// with its evidence on the record.
// ---------------------------------------------------------------------------

test("run_role records intake and a budget decision before the delegate turn runs, then starts", async () => {
  const target = tempTarget("before-start");
  const observed: string[] = [];
  const runRole = await startGatedSession(target, (task) => {
    // The moment the delegate turn is ABOUT to run, the intake decision for
    // THAT task must already be durable on the target's runs layout.
    observed.push(readRecord(target, task) ? "on-record" : "missing");
  });
  const text = await callTool(runRole, { role: "coder", task: TASK });

  expect(observed).toEqual(["on-record"]);
  expect(text).toContain("coder complete"); // ordinary start was NOT refused

  const rec = readRecord(target, TASK);
  expect(rec).toBeDefined();
  expect(rec?.budget.kind).toBe("counter_estimated");
  expect(rec?.budget.reason).toContain("counter-estimated at the pre-work gate");
  expect(rec?.budget.evidence?.join("\n")).toContain("recorded ceiling coder:maxCostUsd=");
  expect(rec?.statement.budget.source).toBe("estimate");
  expect(rec?.statement.budget.ceilingUsd).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// (c) The counter-estimated outcome is the task's own end state, not the old
// task-agnostic placeholder.
// ---------------------------------------------------------------------------

test("a counter-estimated intake names the task's own end state, not the gate placeholder", async () => {
  const target = tempTarget("outcome");
  const runRole = await startGatedSession(target);
  await callTool(runRole, { role: "coder", task: TASK });

  const rec = readRecord(target, TASK);
  expect(rec).toBeDefined();
  expect(rec?.statement.outcome).not.toBe(OUTCOME_PLACEHOLDER);
  expect(rec?.statement.outcome).not.toContain(OUTCOME_PLACEHOLDER);
  // The task's own words are what name the intended end state.
  expect(rec?.statement.outcome).toContain(TASK);
});

// ---------------------------------------------------------------------------
// The record bound: ONE file per distinct task (sha256(task)[:32] key),
// reused across roles, no per-delegation accumulation.
// ---------------------------------------------------------------------------

test("delegating the same task twice records into ONE bounded file; a new task gets its own", async () => {
  const target = tempTarget("bounded");
  const runRole = await startGatedSession(target);
  await callTool(runRole, { role: "coder", task: TASK });
  await callTool(runRole, { role: "reviewer", task: TASK });

  const intakeDir = path.join(target, ".ad-coder", "runs");
  const files = fs.readdirSync(intakeDir).filter((name) => name.startsWith("intake-"));
  expect(files).toEqual([`intake-${ProjectStoreIntakeStore.idForTask(TASK)}.json`]);

  const second = "audit the release budget on the finance plans";
  await callTool(runRole, { role: "auditor", task: second });
  const after = fs.readdirSync(intakeDir).filter((name) => name.startsWith("intake-"));
  expect(after).toHaveLength(2);
  expect(after).toContain(`intake-${ProjectStoreIntakeStore.idForTask(second)}.json`);
});

// ---------------------------------------------------------------------------
// (d) Regression guard: the SAME seam keeps the gated tools' refusal codes
// (buildBuiltInPipelineTools -> buildGatedIntake), and the honest no-forecast
// stop writes no record and starts nothing.
// ---------------------------------------------------------------------------

test("run_pipeline through the shared seam still blocks honestly with no record written", async () => {
  const target = tempTarget("gated-tools");
  const started: string[] = [];
  const approvedPipeline: PipelineResult = {
    outcome: "approved",
    approved: true,
    rounds: 1,
    verdicts: [{ status: "approved", issues: [], summary: "ok" }],
    runIds: [],
    stageMetrics: [],
  };
  const store = new ProjectStoreIntakeStore(new ProjectStore(target));
  const core = {
    recordIntake(
      task: string,
      statement: import("../src/orchestration/intake").IntakeStatement,
      budget: import("../src/orchestration/intake").BudgetDecision,
    ): string {
      const id = ProjectStoreIntakeStore.idForTask(task);
      store.set(id, statement, budget, new Date().toISOString());
      return id;
    },
    readIntake(id: string) {
      return store.get(id);
    },
    budgetCounterEstimate: (_task: string, _complexity?: unknown) => undefined,
    async runPipeline(task: string): Promise<false> {
      started.push(task);
      void approvedPipeline;
      throw new Error("the stub must never run past the gate");
    },
    backgroundRuns: {
      async startDetached(task: string): Promise<{ runId: string }> {
        started.push(task);
        return { runId: `bg-${started.length}` };
      },
    },
  };
  const tools = buildBuiltInPipelineTools(core as never);
  const map = new Map(tools.map((t) => [t.name, t]));
  const runTool = map.get(RUN_PIPELINE_TOOL_NAME);
  if (runTool === undefined) throw new Error("run_pipeline missing from the built-in tools");
  const text = await callTool(runTool, { task: "no basis" });
  expect(text).toContain("error: budget_blocked");
  expect(text).toContain("no_forecast_basis");
  expect(started).toEqual([]);
  expect(store.get(ProjectStoreIntakeStore.idForTask("no basis"))).toBeUndefined();
});
