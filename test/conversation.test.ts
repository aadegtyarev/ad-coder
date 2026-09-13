import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { ContextBudgetError } from "../src/context/budget";
import type { Summarizer } from "../src/context/compactor";
import { SUMMARIZATION_PROMPT } from "../src/context/compactor";
import { startConversation } from "../src/conversation/conversation";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import type { ToolActivityRecord } from "../src/observability/tool-activity";
import { ProjectStore } from "../src/project-store/project-store";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { defineTool } from "../src/runner/tool";
import { SessionLimitController, SessionLimitError } from "../src/session-limits";

const CONTEXT_WINDOW = 200_000;

/** A faux provider + models pair and the role validated against its window. */
function harnessFixture(activeToolNames = ["bash", "read", "write", "edit"]) {
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const role: Role = defineRole(
    {
      name: "coder",
      provider: "faux",
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames,
      cacheRetention: "none",
      contextBudget: { maxTokens: 100_000, reserveTokens: 10_000, keepRecentTokens: 20_000 },
    },
    model,
  );
  return { faux, models, model, role };
}

/** A custom tool that records every invocation's note, built via defineTool. */
function recordingTool(name: string, calls: string[]) {
  return defineTool({
    name,
    description: "Record a note for the test to observe.",
    label: "record note",
    parameters: Type.Object({ note: Type.String() }),
    async execute(_toolCallId, params) {
      calls.push(params.note);
      return { content: [{ type: "text", text: "recorded" }], details: undefined };
    },
  });
}

let targetDir: string;

beforeAll(() => {
  targetDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-conversation-")));
});

afterAll(() => {
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test("a two-turn conversation retains history on the live session branch", async () => {
  const { faux, models, model, role } = harnessFixture();
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

  const conversation = await startConversation({ role, targetDir, models, model, session });
  try {
    const first = await conversation.step("first question");
    const second = await conversation.step("second question");

    expect(first.assistantText).toBe("first reply");
    expect(second.assistantText).toBe("second reply");

    // History is retained on the branch tip, not replayed: both turns' user and
    // assistant messages are present on the one live session.
    const entries = await session.findEntries({ type: "message" }, BACKGROUND_CONTEXT);
    const messages = entries.filter((e) => e.type === "message");
    const users = messages.filter((e) => e.message.role === "user");
    const assistants = messages.filter((e) => e.message.role === "assistant");
    expect(users.length).toBeGreaterThanOrEqual(2);
    expect(assistants.length).toBeGreaterThanOrEqual(2);
  } finally {
    await conversation.close();
  }
});

test("a default conversation resumes durable history after reconstruction", async () => {
  const { faux, models, model, role } = harnessFixture();
  const runId = `resume_${Date.now()}`;
  faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);

  const first = await startConversation({ role, targetDir, models, model, runId });
  expect((await first.step("first question")).assistantText).toBe("first reply");
  await first.close();

  const second = await startConversation({ role, targetDir, models, model, runId });
  expect((await second.step("second question")).assistantText).toBe("second reply");
  await second.close();

  const store = new ProjectStore(targetDir);
  const durable = await store.resumeSession(runId);
  const messages = await durable.findEntries({ type: "message" }, BACKGROUND_CONTEXT);
  expect(messages.filter((entry) => entry.type === "message")).toHaveLength(4);
  await durable.close(BACKGROUND_CONTEXT);
});

test("exactly one ledger row per turn (per-turn attach/unsubscribe, no duplication)", async () => {
  const { faux, models, model, role } = harnessFixture();
  const sink = new MemoryLedgerSink();
  faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    ledgerSink: sink,
  });
  try {
    await conversation.step("turn one");
    await conversation.step("turn two");

    // Two turns => exactly two after_response rows. A leaked listener would
    // record 3+ (turn one's ledger firing again on turn two).
    expect(sink.records()).toHaveLength(2);
    expect(conversation.ledgerPath).toBeUndefined();
  } finally {
    await conversation.close();
  }
});

test("a tool invoked in a turn appears in that turn's result.toolCalls", async () => {
  const calls: string[] = [];
  const { faux, models, model, role } = harnessFixture([
    "bash",
    "read",
    "write",
    "edit",
    "record_note",
  ]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("record_note", { note: "from-model" })),
    fauxAssistantMessage("done"),
  ]);

  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    tools: [recordingTool("record_note", calls)],
  });
  try {
    const result = await conversation.step("use the tool");

    expect(calls).toEqual(["from-model"]);
    const recorded = result.toolCalls.find((c) => c.toolName === "record_note");
    expect(recorded).toBeDefined();
    expect(typeof recorded?.toolCallId).toBe("string");
  } finally {
    await conversation.close();
  }
});

test("conversation activity listeners are turn-scoped and retain step correlation", async () => {
  const calls: string[] = [];
  const records: ToolActivityRecord[] = [];
  const { faux, models, model, role } = harnessFixture(["record_note"]);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("record_note", { note: "secret-one" })),
    fauxAssistantMessage("one done"),
    fauxAssistantMessage(fauxToolCall("record_note", { note: "secret-two" })),
    fauxAssistantMessage("two done"),
  ]);
  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    tools: [recordingTool("record_note", calls)],
  });
  const unsubscribe = conversation.subscribeToolActivity?.((record) => {
    records.push(record);
  });
  try {
    await conversation.step("one", { step: "first" });
    await conversation.step("two", { step: "second" });
  } finally {
    unsubscribe?.();
    await conversation.close();
    await conversation.close();
  }

  const events = records.filter((record) => record.type === "tool_activity");
  expect(events).toHaveLength(6);
  expect(events.slice(0, 3).every(({ parentOperation }) => parentOperation === "first")).toBe(true);
  expect(events.slice(3).every(({ parentOperation }) => parentOperation === "second")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("secret-one");
  expect(JSON.stringify(events)).not.toContain("secret-two");
});

test("close during a tool is idempotent, cancels once, rejects overlap, and bounds slow subscribers", async () => {
  const records: ToolActivityRecord[] = [];
  const { faux, models, model, role } = harnessFixture(["blocking_tool"]);
  let signalStarted: (() => void) | undefined;
  let releaseTool: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const tool = defineTool({
    name: "blocking_tool",
    description: "Wait until the conversation closes.",
    label: "blocking",
    parameters: Type.Object({}),
    async execute() {
      signalStarted?.();
      await released;
      return { content: [{ type: "text", text: "released" }], details: undefined };
    },
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("blocking_tool", {})),
    fauxAssistantMessage("settled"),
  ]);
  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    tools: [tool],
    toolActivity: { closeDrainMs: 5 },
  });
  conversation.subscribeToolActivity?.((record) => {
    records.push(record);
  });
  conversation.subscribeToolActivity?.(() => new Promise<void>(() => undefined));
  const active = conversation.step("block");
  void active.catch(() => undefined);
  await started;
  await expect(conversation.step("overlap")).rejects.toThrow("conversation step already active");
  const firstClose = conversation.close();
  const secondClose = conversation.close();
  expect(firstClose).toBe(secondClose);
  releaseTool?.();
  await firstClose;
  const terminal = records.filter(
    (record) => record.type === "tool_activity" && record.lifecycle === "cancelled",
  );
  expect(terminal).toHaveLength(1);
});

test("conversation counts tool follow-ups and rethrows a Models-boundary limit", async () => {
  const { faux, models, model, role } = harnessFixture();
  const controller = new SessionLimitController({ maxTurns: 1 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf followed-up" })),
    fauxAssistantMessage("must not dispatch"),
  ]);

  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    sessionLimitController: controller,
  });
  try {
    await expect(conversation.step("use the tool")).rejects.toBeInstanceOf(SessionLimitError);
    expect(faux.state.callCount).toBe(1);
    expect(controller.snapshot().admittedTurns).toBe(1);
  } finally {
    await conversation.close();
  }
});

test("the ContextCompactor is attached once and does not run under budget across turns", async () => {
  const { faux, models, model, role } = harnessFixture();
  let summarizerCalls = 0;
  const summarizer: Summarizer = async () => {
    summarizerCalls += 1;
    return "summary";
  };
  faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);

  const conversation = await startConversation({ role, targetDir, models, model, summarizer });
  try {
    await conversation.step("turn one");
    await conversation.step("turn two");

    // Attached once at startConversation, never per turn: under budget it never
    // fires, so the count does not scale with turns.
    expect(summarizerCalls).toBe(0);
  } finally {
    await conversation.close();
  }
});

test("auto compaction consumes a distinct provider summary before the normal response", async () => {
  const { faux, models, model } = harnessFixture();
  const role = defineRole(
    {
      name: "coder",
      provider: model.provider,
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames: [],
      cacheRetention: "none",
      contextBudget: { maxTokens: 1100, reserveTokens: 100, keepRecentTokens: 250 },
    },
    model,
  );
  const calls: Array<"summary" | "role"> = [];
  const controller = new SessionLimitController();
  faux.setResponses(
    Array.from({ length: 12 }, () => (request: { systemPrompt?: string }) => {
      const kind = request.systemPrompt === SUMMARIZATION_PROMPT ? "summary" : "role";
      calls.push(kind);
      return fauxAssistantMessage(kind === "summary" ? "safe historical briefing" : "reply");
    }),
  );
  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    sessionLimitController: controller,
  });
  try {
    for (let i = 0; i < 6; i++) await conversation.step(`${i}:${"x".repeat(900)}`);
    const summaryAt = calls.indexOf("summary");
    expect(summaryAt).toBeGreaterThan(0);
    expect(calls[summaryAt + 1]).toBe("role");
    expect(calls.filter((kind) => kind === "role")).toHaveLength(6);
    expect(controller.snapshot().admittedTurns).toBe(calls.length);
    expect(calls.filter((kind) => kind === "summary")).toHaveLength(1);
  } finally {
    await conversation.close();
  }
});

test("failed compaction reports the smaller runtime window and blocks later provider dispatch", async () => {
  const { faux, models, model } = harnessFixture();
  const role = defineRole(
    {
      name: "coder",
      provider: model.provider,
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames: [],
      cacheRetention: "none",
      contextBudget: { maxTokens: 1100, reserveTokens: 100, keepRecentTokens: 250 },
    },
    model,
  );
  const smallerRuntimeModel = { ...model, contextWindow: 500 } as Model<Api>;
  const secret = `compaction-secret:${"z".repeat(4000)}`;
  const summarizer: Summarizer = async () => {
    throw new Error(secret);
  };
  faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("reply")));
  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model: smallerRuntimeModel,
    summarizer,
  });
  try {
    let caught: unknown;
    for (let turn = 0; turn < 8; turn++) {
      try {
        await conversation.step(`${turn}:${"x".repeat(900)}`);
      } catch (error) {
        caught = error;
        break;
      }
    }
    expect(caught).toBeInstanceOf(ContextBudgetError);
    const error = caught as ContextBudgetError;
    expect(error.effectiveCeiling).toBe(500);
    expect(error.message).toContain("summarization failed previously");
    expect(error.message).toContain("effective ceiling 500");
    expect(error.message).not.toContain(secret);

    const providerDispatches = faux.state.callCount;
    await expect(conversation.step(`retry:${"x".repeat(900)}`)).rejects.toBeInstanceOf(
      ContextBudgetError,
    );
    expect(faux.state.callCount).toBe(providerDispatches);
  } finally {
    await conversation.close();
  }
});

test("disabled conversation halts an oversized later turn without summarizing and remains closable", async () => {
  const { faux, models, model } = harnessFixture();
  const role = defineRole(
    {
      name: "coder",
      provider: model.provider,
      modelId: model.id,
      systemPrompt: "You code.",
      activeToolNames: [],
      cacheRetention: "none",
      contextBudget: { maxTokens: 1000, reserveTokens: 100, keepRecentTokens: 200 },
    },
    model,
  );
  faux.setResponses(Array.from({ length: 8 }, (_, i) => fauxAssistantMessage(`reply ${i}`)));
  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    compaction: { mode: "disabled-then-halt" },
  });
  try {
    await conversation.step("x".repeat(900));
    await conversation.step("x".repeat(900));
    await expect(conversation.step("x".repeat(1800))).rejects.toBeInstanceOf(ContextBudgetError);
    expect(faux.state.callCount).toBe(2);
  } finally {
    await conversation.close();
    await conversation.close();
  }
});
