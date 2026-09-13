import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { runRoleStandalone } from "../src/cli";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import { StageLimitError } from "../src/orchestration/stage-limits";
import { ProjectStore } from "../src/project-store/project-store";
import { ProjectStoreError } from "../src/project-store/types";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";

const CONTEXT_WINDOW = 200_000;
const BUDGET = { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 } as const;

let targetDir: string;

beforeAll(() => {
  targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-cli-role-")));
});

afterAll(() => {
  fs.rmSync(targetDir, { recursive: true, force: true });
});

/** A faux-backed reviewer: no network, no key, one queued assistant message. */
function fixture() {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role: Role = defineRole(
    {
      name: "reviewer",
      provider: "faux",
      modelId: model.id,
      systemPrompt: "You review.",
      activeToolNames: ["read", "bash"],
      cacheRetention: "none",
      contextBudget: { ...BUDGET },
    },
    model,
  );
  return { faux, models, model, role };
}

test("runRoleStandalone drives one faux turn and returns the assistant text plus a numeric cost", async () => {
  const { faux, models, model, role } = fixture();
  faux.setResponses([fauxAssistantMessage("looks good to me")]);
  const ledgerSink = new MemoryLedgerSink();
  const runId = `durable-result-${crypto.randomUUID()}`;

  const { text, cost } = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the change",
    runId,
    ledgerSink,
  });

  expect(text).toContain("looks good to me");
  expect(typeof cost).toBe("number");
  expect(cost).toBeGreaterThanOrEqual(0);
  const durable = JSON.parse(
    fs.readFileSync(path.join(targetDir, ".ad-coder", "runs", `standalone-${runId}.json`), "utf8"),
  ).value;
  expect(durable).toMatchObject({
    status: "complete",
    result: { text: expect.stringContaining("looks good to me"), cost },
  });
  // The ledger recorded the turn, and the cost is summed from it.
  expect(ledgerSink.records().length).toBeGreaterThan(0);
});

test("standalone roles enforce the same stage budgets as pipeline roles", async () => {
  const { faux, models, model, role } = fixture();
  const response = fauxAssistantMessage("too expensive");
  response.usage.input = 2;
  faux.setResponses([response]);
  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task: "review the change",
      ledgerSink: new MemoryLedgerSink(),
      stageLimits: { maxInputTokens: 1 },
    }),
  ).rejects.toBeInstanceOf(StageLimitError);
});

test("standalone role resumes the same durable run only after its exhausted budget changes", async () => {
  const { faux, models, model, role } = fixture();
  fs.writeFileSync(path.join(targetDir, "resume.txt"), "safe\n");
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "resume.txt" }),
      fauxToolCall("read", { path: "resume.txt" }),
    ]),
  ]);
  const runId = `resume-${crypto.randomUUID()}`;
  const task = "review the resumable change";

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      stageLimits: { maxToolTurns: 1 },
    }),
  ).rejects.toBeInstanceOf(StageLimitError);

  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  expect(store.readVersionedJson<{ status: string }>(checkpointPath).value.status).toBe("paused");

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      resumeExisting: true,
      stageLimits: { maxToolTurns: 1 },
    }),
  ).rejects.toBeInstanceOf(ProjectStoreError);

  await expect(
    runRoleStandalone({
      role,
      model: { ...model, id: "different-model" },
      models,
      targetDir,
      task,
      runId,
      resumeExisting: true,
      stageLimits: { maxToolTurns: 3 },
    }),
  ).rejects.toBeInstanceOf(ProjectStoreError);

  await expect(
    runRoleStandalone({
      role,
      model,
      models: createModels(),
      targetDir,
      task,
      runId,
      resumeExisting: true,
      stageLimits: { maxToolTurns: 3 },
    }),
  ).rejects.toThrow();
  expect(
    store.readVersionedJson<{
      status: string;
      cumulativeUsage: { toolTurns: number };
    }>(checkpointPath).value,
  ).toMatchObject({ status: "running", cumulativeUsage: { toolTurns: 1 } });

  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "resume.txt" }),
      fauxToolCall("read", { path: "resume.txt" }),
    ]),
  ]);
  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      resumeExisting: true,
      stageLimits: { maxToolTurns: 2 },
    }),
  ).rejects.toBeInstanceOf(StageLimitError);
  expect(
    store.readVersionedJson<{ cumulativeUsage: { toolTurns: number } }>(checkpointPath).value
      .cumulativeUsage.toolTurns,
  ).toBe(2);

  faux.setResponses([fauxAssistantMessage("completed review")]);
  const resumed = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
    stageLimits: { maxToolTurns: 4 },
  });

  expect(resumed.text).toContain("completed review");
  expect(store.readVersionedJson<{ status: string }>(checkpointPath).value.status).toBe("complete");
  expect(resumed.ledgerPath).toBe(path.join(store.layout.ledger, `${runId}.jsonl`));
});

test("standalone roles persist usage and emit semantic tool activity by default", async () => {
  const { faux, models, model, role } = fixture();
  fs.writeFileSync(path.join(targetDir, "observed.txt"), "hello\n");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "observed.txt" })),
    fauxAssistantMessage("reviewed"),
  ]);
  const activity: string[] = [];

  const result = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the change",
    runId: "standalone-observed",
    activityConsumer: (record) => {
      if (record.type === "tool_activity") activity.push(`${record.activity}:${record.lifecycle}`);
    },
  });

  expect(result.ledgerPath).toBe(
    path.join(targetDir, ".ad-coder", "ledger", "standalone-observed.jsonl"),
  );
  expect(fs.existsSync(result.ledgerPath as string)).toBe(true);
  expect(result.observations.input).toBeGreaterThanOrEqual(0);
  expect(activity).toContain("Read:requested");
  expect(activity).toContain("Read:completed");
});
