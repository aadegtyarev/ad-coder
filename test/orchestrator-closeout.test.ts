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
import { MemoryLedgerSink } from "../src/ledger/ledger";
import type { IntakeStatement } from "../src/orchestration/intake";
import {
  type BudgetCloseout,
  createOrchestrator,
  formatBudgetCloseout,
} from "../src/orchestration/orchestrator";
import { SUBMIT_PLAN_TOOL_NAME } from "../src/orchestration/plan";
import type { PipelineConfig, RoleSpec, Verdict } from "../src/orchestration/types";
import { SUBMIT_VERDICT_TOOL_NAME } from "../src/orchestration/verdict";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";

const CONTEXT_WINDOW = 200_000;
const BUDGET = { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 } as const;

interface Fixture {
  faux: ReturnType<typeof fauxProvider>;
  sink: MemoryLedgerSink;
  targetDir: string;
  buildConfig: (task: string) => PipelineConfig;
}

/** A faux provider + shared sink + a planner/coder/reviewer pipeline config. */
function fixture(): Fixture {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-closeout-")));
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

  const defaultTools = ["bash", "read", "write", "edit", "submit_follow_up"];
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
    fauxAssistantMessage("coded X"),
    fauxAssistantMessage(fauxToolCall(SUBMIT_VERDICT_TOOL_NAME, verdict)),
    fauxAssistantMessage("review complete"),
  ]);
}

const INTAKE_STATEMENT: IntakeStatement = {
  outcome: "X is implemented",
  scopeExclusions: [],
  mode: "auto",
  taskShape: { complexity: "trivial", stage: "plan->code->review", sizeClass: "local" },
  budget: { ceilingUsd: 2.5, source: "operator" },
  ceilings: [],
  resultChangingAmbiguities: [],
};

test("closeout reports ceiling, spend and remainder with the ceiling source named", async () => {
  const fx = fixture();
  const verdict: Verdict = { status: "approved", issues: [], summary: "ok" };
  approveScenario(fx, verdict);
  const core = createOrchestrator({ buildConfig: fx.buildConfig, ledgerSink: fx.sink });
  core.recordIntake("implement X", INTAKE_STATEMENT, { kind: "accepted" });
  const run = await core.runPipeline("implement X");
  const closeout = run.budgetCloseout;
  expect(closeout).toBeDefined();
  expect(closeout?.ceilingUsd).toBe(2.5);
  expect(closeout?.ceilingSource).toBe("operator");
  expect(closeout?.spendUsd).toBe(run.totalCost);
  expect(closeout?.remainderUsd).toBe(2.5 - run.totalCost);
  // The faux provider names no billed amount, so the closeout states an absence
  // (test "closeout states provider-billing absence ..."): here only the ceiling
  // half of the distinction is exercised.
  const report = formatBudgetCloseout(closeout as BudgetCloseout);
  expect(report).toContain("operator-stated budget: ceiling 2.500000 USD (source: operator)");
  expect(report).toContain(
    `ledger-derived spend across all rounds: ${run.totalCost.toFixed(6)} USD`,
  );
  expect(report).toContain("budget remainder: ");
});

test("closeout reports an overrun as an overrun, not a clamped remainder", () => {
  const report = formatBudgetCloseout({
    ceilingUsd: 2,
    ceilingSource: "estimate",
    spendUsd: 2.25,
    remainderUsd: -0.25,
    providerBillingReported: false,
  });
  expect(report).toContain("budget remainder: -0.250000 USD");
  expect(report).toContain("overrun: 0.250000 USD over the ceiling -- not within budget");
  expect(report).not.toContain("budget remainder: 0.000000 USD");
});

test("closeout names a provider-reported billing figure apart from the configured estimate", () => {
  const report = formatBudgetCloseout({
    ceilingUsd: 2.5,
    ceilingSource: "estimate",
    spendUsd: 0.6,
    remainderUsd: 1.9,
    providerBillingReported: true,
    providerBillingUsd: 0.4,
  });
  expect(report).toContain("configured estimate: ceiling 2.500000 USD (source: estimate)");
  expect(report).toContain("ledger-derived spend across all rounds: 0.600000 USD");
  expect(report).toContain("provider billing: 0.400000 USD as reported billed by the provider");
  expect(report).toContain("distinct from the ledger-derived spend");
  // The two figures are numbers that differ, so the report MUST NOT let them
  // collide into one indistinguishable figure.
  expect(report).not.toContain("provider billing: 0.600000 USD");
});

test("closeout states provider-billing absence instead of showing a zero", () => {
  const report = formatBudgetCloseout({
    ceilingUsd: 2.5,
    ceilingSource: "operator",
    spendUsd: 0.5,
    remainderUsd: 2,
    providerBillingReported: false,
  });
  expect(report).toContain("no billed amount was reported by the provider");
  expect(report).toContain("not zero");
  expect(report).not.toContain("provider billing: 0");
});
