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
