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
import {
  formatStageCloseoutNotice,
  runReviewWithSubmissionRetry,
  runRoleStandalone,
  standaloneSystemPrompt,
} from "../src/cli";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import { StageLimitError } from "../src/orchestration/stage-limits";
import { ProjectStore } from "../src/project-store/project-store";
import { ProjectStoreError } from "../src/project-store/types";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { RunInterruptedError } from "../src/runner/errors";

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

test("an interrupted standalone role persists a resumable pause and releases its session", async () => {
  const { faux, models, model, role } = fixture();
  const runId = `interrupted-${crypto.randomUUID()}`;
  const task = "review the interrupted change";
  const abortController = new AbortController();
  abortController.abort();

  await expect(
    runRoleStandalone({
      role,
      model,
      models,
      targetDir,
      task,
      runId,
      abortSignal: abortController.signal,
    }),
  ).rejects.toBeInstanceOf(RunInterruptedError);

  const store = new ProjectStore(targetDir);
  const checkpointPath = path.join(store.layout.runs, `standalone-${runId}.json`);
  expect(
    store.readVersionedJson<{ status: string; pause?: { code: string } }>(checkpointPath).value,
  ).toMatchObject({
    status: "paused",
    pause: { code: "interrupted" },
  });

  faux.setResponses([fauxAssistantMessage("resumed after interruption")]);
  const resumed = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
  });
  expect(resumed.text).toContain("resumed after interruption");
  expect(store.readVersionedJson<{ status: string }>(checkpointPath).value.status).toBe("complete");
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

test("legacy standalone checkpoint restores conservative input prediction", async () => {
  const { faux, models, model, role } = fixture();
  fs.writeFileSync(path.join(targetDir, "legacy-resume.txt"), "safe\n");
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("read", { path: "legacy-resume.txt" }),
      fauxToolCall("read", { path: "legacy-resume.txt" }),
    ]),
  ]);
  const runId = `legacy-resume-${crypto.randomUUID()}`;
  const task = "review legacy resume";

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
  const legacy = store.readVersionedJson<Record<string, unknown>>(checkpointPath);
  const cumulativeUsage: Record<string, unknown> = {
    ...(legacy.value.cumulativeUsage as Record<string, unknown>),
    inputTokens: 100,
  };
  delete cumulativeUsage.lastInputTokens;
  store.writeVersionedJson(checkpointPath, { ...legacy.value, cumulativeUsage }, legacy.version);

  let resumedTools: number | undefined;
  faux.setResponses([
    (context) => {
      resumedTools = context.tools?.length ?? 0;
      return fauxAssistantMessage("legacy resume completed");
    },
  ]);
  const resumed = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task,
    runId,
    resumeExisting: true,
    stageLimits: {
      maxToolTurns: 4,
      maxInputTokens: 300,
      finalResponseReserveInputTokens: 100,
    },
  });

  expect(resumed.text).toContain("legacy resume completed");
  expect(resumedTools).toBe(0);
  expect(
    store.readVersionedJson<{ cumulativeUsage: { lastInputTokens: number } }>(checkpointPath).value
      .cumulativeUsage.lastInputTokens,
  ).toBeGreaterThan(0);
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

test("standalone prompt overrides a role rule that reserves the result for a submit tool", () => {
  // The Planner ends its prompt this way, and it is not decoration: without an
  // override that names the rule, a standalone Planner is told both to withhold
  // the plan from assistant text and to return it there. It then obeys whichever
  // instruction it weighs higher, which is not a thing a bench can score.
  const planner =
    "Do not emit the plan or a JSON copy in assistant text: `submit_plan` is the sole canonical handoff.";
  const amended = standaloneSystemPrompt(planner);
  expect(amended.startsWith(`${planner}\n\n`)).toBe(true);
  expect(amended).toContain("does not apply to this run");
  expect(amended).toContain("withhold the result from assistant text");
  // A task that asks for a specific shape must still win, or every
  // artifact-scored role task would be fighting this paragraph instead.
  expect(amended).toContain("that format governs");
});

test("the standalone override keeps a registered submission tool instead of denying it", () => {
  // The reviewer's prompt tells it to submit through `submit_verdict`, and the
  // standalone path now registers that tool (issue #283). Telling the model the
  // tool is absent while handing it the tool is the same contradiction the
  // planner override exists to prevent, pointed the other way -- and a reviewer
  // that believes it cannot submit answers in prose, which no stamp can be
  // derived from.
  const reviewer = "When your review is complete, submit your verdict by calling submit_verdict.";
  const amended = standaloneSystemPrompt(reviewer, "submit_verdict");
  expect(amended.startsWith(`${reviewer}\n\n`)).toBe(true);
  expect(amended).toContain("submit_verdict IS available");
  expect(amended).not.toContain("are NOT available here");
  // The roles whose tool really is absent keep the original override.
  expect(standaloneSystemPrompt(reviewer)).toContain("are NOT available here");
});

test("the standalone review retry keeps the first attempt's review and charges both", async () => {
  // The first attempt holds the review; the retry is asked only to submit
  // (issue #283). Returning the retry alone would drop the findings the
  // operator reads, and charging one attempt would understate what the run cost.
  let submitted = false;
  const tasks: string[] = [];
  const runIds: string[] = [];
  const result = await runReviewWithSubmissionRetry({
    run: async (runId, task) => {
      runIds.push(runId);
      tasks.push(task);
      if (runIds.length === 1) return { text: "the review itself", cost: 0.02 };
      submitted = true;
      return { text: "submitted", cost: 0.005 };
    },
    firstRunId: "first",
    task: "review it",
    retries: true,
    submitted: () => submitted,
    newRunId: () => "second",
  });
  expect(result.text).toBe("the review itself\n\nsubmitted");
  expect(result.cost).toBeCloseTo(0.025, 10);
  // A fresh run id per attempt: a turn is keyed by run id in the session store,
  // so re-asking under the first is rejected as an existing session.
  expect(runIds).toEqual(["first", "second"]);
  expect(tasks[1]).toContain("did not call submit_verdict");
});

test("the standalone review retry does not run when the verdict already arrived", async () => {
  let calls = 0;
  const result = await runReviewWithSubmissionRetry({
    run: async () => {
      calls += 1;
      return { text: "done", cost: 0.01 };
    },
    firstRunId: "only",
    task: "review it",
    retries: true,
    submitted: () => true,
  });
  expect(calls).toBe(1);
  expect(result.cost).toBeCloseTo(0.01, 10);
  // And a role with no verdict tool registered never retries at all.
  let bare = 0;
  await runReviewWithSubmissionRetry({
    run: async () => {
      bare += 1;
      return { text: "prose", cost: 0.01 };
    },
    firstRunId: "only",
    task: "summarise it",
    retries: false,
    submitted: () => false,
  });
  expect(bare).toBe(1);
});

test("every attempt ending in prose still charges every attempt", async () => {
  // The caller reports the missing verdict and writes no stamp; the cost of
  // having asked twice is still the cost of this run.
  let calls = 0;
  const result = await runReviewWithSubmissionRetry({
    run: async () => {
      calls += 1;
      return { text: `attempt ${calls}`, cost: 0.01 };
    },
    firstRunId: "first",
    task: "review it",
    retries: true,
    submitted: () => false,
  });
  expect(calls).toBe(2);
  expect(result.cost).toBeCloseTo(0.02, 10);
  expect(result.text).toBe("attempt 1");
});

test("an unknown role is refused before a start is announced", () => {
  // `withCliProgress` prints "started role X; waiting for provider" the moment it
  // is entered, so validating inside the command produced a success line followed
  // by a failure (issue #306). Anything reading the first line -- a person
  // glancing at output, a log tail, a wrapper script -- saw a run that had begun.
  const result = Bun.spawnSync([
    process.execPath,
    "run",
    path.join(import.meta.dir, "..", "src", "cli.ts"),
    "role",
    "nosuchrole",
    "some task",
    "--target-dir",
    targetDir,
  ]);
  const stderr = result.stderr.toString();
  expect(stderr).toContain("unknown role: nosuchrole");
  expect(stderr).not.toContain("started role");
  // The orchestrator is a configured role with its own prompt and profile row,
  // so it belongs in the accepted set rather than being reachable only through
  // an interactive console.
  expect(stderr).toContain("orchestrator");
});

test("a standalone run that settles inside the closeout reserve relays the fact", async () => {
  const { faux, models, model, role } = fixture();
  fs.writeFileSync(path.join(targetDir, "closeout.txt"), "safe\n");
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "closeout.txt" })),
    fauxAssistantMessage("partial review"),
  ]);
  const runId = `closeout-${crypto.randomUUID()}`;

  const result = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the closing change",
    runId,
    ledgerSink: new MemoryLedgerSink(),
    stageLimits: { maxToolTurns: 2, finalResponseReserveToolTurns: 1 },
  });

  expect(result.stageCloseout).toEqual({
    code: "stage_closeout",
    reason: "tool_turns",
    detail: expect.any(String),
  });
  expect(result.stageCloseout?.detail.length).toBeGreaterThan(0);
  const durable = JSON.parse(
    fs.readFileSync(path.join(targetDir, ".ad-coder", "runs", `standalone-${runId}.json`), "utf8"),
  ).value;
  expect(durable.result.stageCloseout).toEqual(result.stageCloseout);
});

test("a normal standalone run carries no stageCloseout", async () => {
  const { faux, models, model, role } = fixture();
  faux.setResponses([fauxAssistantMessage("clean pass")]);
  const result = await runRoleStandalone({
    role,
    model,
    models,
    targetDir,
    task: "review the clean change",
    runId: `normal-${crypto.randomUUID()}`,
    ledgerSink: new MemoryLedgerSink(),
  });
  expect(result.stageCloseout).toBeUndefined();
});

test("the stderr closeout notice names the reason and the detail (issue #327)", () => {
  expect(
    formatStageCloseoutNotice({
      code: "stage_closeout",
      reason: "tool_turns",
      detail: "1/2 tool turns used, 1 reserved",
    }),
  ).toBe("ad-coder: stage closeout (tool_turns): 1/2 tool turns used, 1 reserved\n");
});
