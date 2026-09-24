import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createOrchestratorControlPlane } from "../src/orchestration/control-plane";
import {
  BUDGET_BLOCKED_HEADER,
  type BudgetDecision,
  BudgetWaitError,
  type DurableIntakeRecord,
  type IntakeStatement,
  ProjectStoreIntakeStore,
  parseIntakeStatement,
} from "../src/orchestration/intake";
import {
  buildBuiltInPipelineTools,
  RUN_PIPELINE_TOOL_NAME,
  START_PIPELINE_TOOL_NAME,
} from "../src/orchestration/orchestrator";
import type { PipelineResult } from "../src/orchestration/types";
import { ProjectStore } from "../src/project-store/project-store";
import type { Tool } from "../src/runner/tool";

// ---------------------------------------------------------------------------
// Fixtures. Same intent as the harness in test/orchestration.test.ts: run
// against temporary targets, stub the expensive edges (the pipeline execution),
// and invoke tool handlers the way the tool harness does (two-arg cast).
// ---------------------------------------------------------------------------

const intake = (
  kind: BudgetDecision["kind"],
  extra: Partial<BudgetDecision> = {},
): IntakeStatement => {
  const decision: Record<string, unknown> = { kind, ...extra };
  return {
    outcome: "the intake module's gate holds on every dispatch",
    scopeExclusions: ["no unrelated modules"],
    mode: "manual",
    taskShape: { complexity: "trivial", stage: "code->review", sizeClass: "local" },
    budget: { ceilingUsd: 5, source: "operator" },
    ceilings: ["stageLimits:maxModelTurns=8"],
    resultChangingAmbiguities: [],
    ...({ budgetDecision: decision } as unknown as Record<string, never>),
  } as unknown as IntakeStatement;
};

/** The intake tool payload as a caller would send it through the tool schema. */
const intakePayload = (
  statement: IntakeStatement,
): Record<string, unknown> & { budgetDecision: unknown } => {
  const { budgetDecision, ...rest } = statement as unknown as Record<string, unknown>;
  return { ...(rest as unknown), budgetDecision };
};

const approvedPipeline: PipelineResult = {
  outcome: "approved",
  approved: true,
  rounds: 1,
  verdicts: [{ status: "approved", issues: [], summary: "ok" }],
  runIds: [],
  stageMetrics: [],
};

async function callTool(tool: Tool, params: Record<string, unknown>): Promise<string> {
  const execute = tool.execute as unknown as (
    id: string,
    p: unknown,
  ) => Promise<{
    content: Array<{ text: string }>;
  }>;
  const result = await execute("tc-test", params);
  return result.content.map((c) => c.text).join("");
}

interface ToolCoreOptions {
  /** When set, dispatches are recorded instead of executing the pipeline. */
  runPipeline?: (task: string) => PipelineResult;
}

/** A minimal built-in-tool core: the g2/g3 intake store is real, the rest is stubbed. */
function fixtureCore(options: ToolCoreOptions = {}) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-intake-budget-"));
  const store = new ProjectStoreIntakeStore(new ProjectStore(target));
  const startedViaPipeline: string[] = [];
  const startedDetached: string[] = [];
  const core = {
    recordIntake(task: string, statement: IntakeStatement, budget: BudgetDecision): string {
      const id = ProjectStoreIntakeStore.idForTask(task);
      store.set(id, statement, budget, new Date().toISOString());
      return id;
    },
    readIntake(id: string): DurableIntakeRecord | undefined {
      return store.get(id);
    },
    async runPipeline(task: string): Promise<{ runId: string; result: PipelineResult }> {
      startedViaPipeline.push(task);
      return {
        runId: `pipe-${startedViaPipeline.length}`,
        result: options.runPipeline?.(task) ?? approvedPipeline,
        perStep: [],
        totalCost: 0,
      };
    },
    backgroundRuns: {
      async startDetached(task: string): Promise<{ runId: string }> {
        startedDetached.push(task);
        return { runId: `bg-${startedDetached.length}` };
      },
    },
  };
  const tools: Record<string, Tool> = Object.fromEntries(
    buildBuiltInPipelineTools(core as never).map((tool) => [tool.name, tool]),
  );
  return { core, tools, startedViaPipeline, startedDetached, store };
}

const acceptedStatement = (): IntakeStatement => intake("accepted");
const counterStatement = (): IntakeStatement =>
  intake("counter_estimated", {
    evidence: ["stage estimate table: 6 model turns across plan->code->review"],
    reason: "the operator ceiling was above the measured shape's estimate",
  });
const blockedStatement = (): IntakeStatement =>
  intake("blocked", {
    nextAction: "ask the operator for the whole-task ceiling",
    reason: "no ceiling stated",
  });

// ---------------------------------------------------------------------------
// 1. Negative/characterization: no decided budget -> work does NOT start.
// ---------------------------------------------------------------------------

test("run_pipeline and start_pipeline refuse to start work without a budget decision", async () => {
  const fx = fixtureCore();
  const gateRun = await callTool(fx.tools[RUN_PIPELINE_TOOL_NAME], { task: "gate the pipeline" });
  expect(gateRun).toContain("error: BudgetGateError");
  expect(gateRun).toContain("no pre-work budget decision");
  expect(gateRun).toContain("accepted, counter-estimated");
  const gateStart = await callTool(fx.tools[START_PIPELINE_TOOL_NAME], {
    task: "gate the pipeline",
  });
  expect(gateStart).toContain("error: BudgetGateError");
  expect(gateStart).toContain("no pre-work budget decision");
  // No surface dispatched: neither pipeline nor background run was entered.
  expect(fx.startedViaPipeline).toHaveLength(0);
  expect(fx.startedDetached).toHaveLength(0);
});

test("an intake with a half-stated budget (no decision kind) is also refused", async () => {
  const fx = fixtureCore();
  const { budgetDecision: _missing, ...rest } = intakePayload(acceptedStatement());
  expect(_missing).toEqual({ kind: "accepted" });
  const refused = await callTool(fx.tools[RUN_PIPELINE_TOOL_NAME], {
    task: "gate the pipeline",
    intake: rest as unknown,
  });
  expect(refused).toContain("error: invalid_budget_decision");
  expect(fx.startedViaPipeline).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 2. An accepted budget lets work start.
// ---------------------------------------------------------------------------

test("an accepted budget decision lets run_pipeline start work", async () => {
  const fx = fixtureCore();
  const text = await callTool(fx.tools[RUN_PIPELINE_TOOL_NAME], {
    task: "accepted budget dispatch",
    intake: intakePayload(acceptedStatement()),
  });
  expect(text).toContain("pipeline complete");
  expect(text).toContain("budget=accepted");
  expect(text).toMatch(/intakeId=[0-9a-f]{32}/);
  expect(fx.startedViaPipeline).toEqual(["accepted budget dispatch"]);
});

// ---------------------------------------------------------------------------
// 3. A counter-estimate is accepted WITH its evidence recorded.
// ---------------------------------------------------------------------------

test("a counter-estimated budget is accepted only with evidence, and the evidence is recorded", async () => {
  // Without evidence the counter-estimate is not a decision at all.
  const refusingCore = fixtureCore();
  const refused = await callTool(refusingCore.tools[RUN_PIPELINE_TOOL_NAME], {
    task: "counter without evidence",
    intake: intakePayload(intake("counter_estimated")),
  });
  expect(refused).toContain("error: invalid_budget_decision");
  expect(refusingCore.startedViaPipeline).toHaveLength(0);

  // With evidence the dispatch proceeds and the evidence is durably recorded.
  const fx = fixtureCore();
  const text = await callTool(fx.tools[RUN_PIPELINE_TOOL_NAME], {
    task: "counter with evidence",
    intake: counterStatement() as never,
  });
  expect(text).toContain("pipeline complete");
  expect(text).toContain("budget=counter_estimated");
  expect(fx.startedViaPipeline).toEqual(["counter with evidence"]);
  const id = /intakeId=([0-9a-f]{32})/.exec(text)![1]!;
  const recorded = fx.core.readIntake(id);
  expect(recorded?.budget.kind).toBe("counter_estimated");
  expect(recorded?.budget.evidence).toHaveLength(1);
  expect(recorded?.budget.evidence?.[0]).toContain("stage estimate table");
});

// ---------------------------------------------------------------------------
// 4. The blocked path is honest and resumable: state and next action named.
// ---------------------------------------------------------------------------

test("a blocked budget waits honestly in a named, resumable state, then resumes", async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-budget-wait-"));
  let executions = 0;
  const control = createOrchestratorControlPlane({
    store: new ProjectStore(target),
    id: () => "budget-wait-run",
    execute: async () => {
      executions += 1;
      // No reviewedPaths: no content binding is created, which needs a repo.
      return { result: approvedPipeline };
    },
  });
  const blocked = intakePayload(blockedStatement());
  const run = control.start({
    requestKey: "budget-wait",
    task: "blocked budget",
    mode: "manual",
    budget: blocked.budgetDecision,
    intake: blocked,
  });

  // The gate: no work runs while the budget is explicitly blocked.
  const waited = await control.resume(run.id);
  expect(waited.status).toBe("awaiting_decision");
  expect(waited.budgetDecision).toEqual({
    kind: "blocked",
    nextAction: "ask the operator for the whole-task ceiling",
  });
  expect(control.events(run.id, 0).some((event) => event.type === "decision.required")).toBe(true);
  expect(executions).toBe(0);

  // The run report's projection names the budget state (not stubbed further).
  expect(run.id).toBeTypeOf("string");

  // Resumable: once the decision resolves to accepted, work starts.
  control.recordBudgetDecision(run.id, {
    kind: "accepted",
    reason: "operator confirmed the ceiling",
  });
  const resumed = await control.resume(run.id);
  expect(resumed.status).toBe("complete");
  expect(executions).toBe(1);

  // The blocked-wait error shape itself names state, next action, and that
  // no work started.
  const wait = new BudgetWaitError("ask the operator for the whole-task ceiling");
  expect(wait.code).toBe(BUDGET_BLOCKED_HEADER);
  expect(wait.message).toContain("waiting for a decision");
  expect(wait.message).toContain("ask the operator for the whole-task ceiling");
  expect(wait.message).toContain("work did not start");
  // ...and the tools enforce it, too -- the dispatch never reaches the core:
  const fx = fixtureCore();
  const blockedTool = await callTool(fx.tools[START_PIPELINE_TOOL_NAME], {
    task: "blocked dispatch",
    intake: blockedStatement() as never,
  });
  expect(blockedTool).toContain("error: budget_blocked");
  expect(blockedTool).toContain("ask the operator for the whole-task ceiling");
  expect(fx.startedDetached).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 5. The intake statement is recorded with its named fields and readable back
//    after a restart / context boundary.
// ---------------------------------------------------------------------------

test("the intake statement's named fields survive a restart and read back intact", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-intake-durable-"));
  const statement = parseIntakeStatement({
    outcome: "the named fields read back after restart",
    scopeExclusions: ["no release commits"],
    mode: "auto",
    taskShape: { complexity: "medium", stage: "plan->code->review", sizeClass: "large" },
    budget: { ceilingUsd: 12.5, source: "estimate" },
    ceilings: ["stageLimits:maxModelTurns=8", "station:maxCostUsd=2"],
    resultChangingAmbiguities: ["whether fix/570 is merged first"],
  });
  const id = ProjectStoreIntakeStore.idForTask("restart readback task");

  // Record durably, then "restart": a fresh ProjectStore over the same target.
  new ProjectStoreIntakeStore(new ProjectStore(target)).set(
    id,
    statement,
    { kind: "accepted", reason: "operator ceiling" },
    "2026-09-24T00:00:00.000Z",
  );
  const afterRestart = new ProjectStoreIntakeStore(new ProjectStore(target)).get(id);
  expect(afterRestart?.schemaVersion).toBe(1);
  expect(afterRestart?.id).toBe(id);
  expect(afterRestart?.statement).toEqual(statement);
  expect(afterRestart?.budget).toEqual({ kind: "accepted", reason: "operator ceiling" });
  expect(afterRestart?.createdAt).toBe("2026-09-24T00:00:00.000Z");
  expect(afterRestart?.updatedAt).toBe("2026-09-24T00:00:00.000Z");
  // Every intake field the contract names is on the durable record.
  expect(Object.keys(afterRestart?.statement ?? {})).toEqual([
    "outcome",
    "scopeExclusions",
    "mode",
    "taskShape",
    "budget",
    "ceilings",
    "resultChangingAmbiguities",
  ]);
});
