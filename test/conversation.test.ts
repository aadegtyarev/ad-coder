import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BACKGROUND_CONTEXT,
  JsonlSessionRepo,
  MemorySessionRepo,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { ContextBudgetError } from "../src/context/budget";
import type { Summarizer } from "../src/context/compactor";
import {
  COMPACTION_ATTEMPT_LIMIT,
  ContextCompactionLostError,
  SUMMARIZATION_PROMPT,
} from "../src/context/compactor";
import {
  ConversationRefusedError,
  SessionNotAcquiredError,
  startConversation,
} from "../src/conversation/conversation";
import {
  CostAnomalyBlockedError,
  CostAnomalyDetector,
  MemoryCostAnomalyStore,
} from "../src/economics/cost-anomaly";
import { MemoryLedgerSink } from "../src/ledger/ledger";
import type { ToolActivityRecord } from "../src/observability/tool-activity";
import { ProjectStore } from "../src/project-store/project-store";
import type { Role } from "../src/role";
import { defineRole } from "../src/role";
import { EmptyTurnError } from "../src/runner/errors";
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

test("a message-embedded 429 quota refusal surfaces as a typed quota outcome through conversation", async () => {
  const { faux, models, model, role } = harnessFixture();
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage:
        '429: {"error":{"type":"insufficient_quota","message":"Weekly usage limit reached"}}',
    }),
  ]);
  const conversation = await startConversation({ role, targetDir, models, model, session });
  try {
    // The quota boundary is the same attribution rule as runRole: a typed quota
    // outcome with the provider token, and never the authentication wording.
    await expect(conversation.step("do it")).rejects.toMatchObject({
      code: "provider_quota",
      status: 429,
      providerCode: "insufficient_quota",
    });
  } finally {
    await conversation.close();
  }
});

test("a message-embedded non-credential provider failure keeps its bounded cause on the empty-turn error through conversation (#418)", async () => {
  const { faux, models, model, role } = harnessFixture();
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  const secretBody =
    '{"error":{"code":"insufficient_credits","message":"You have exceeded your monthly spend"}}';
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: `402: ${secretBody}`,
    }),
  ]);
  const conversation = await startConversation({ role, targetDir, models, model, session });
  try {
    // A 402 is neither rejection, quota, nor credential failure: none of the
    // allow-list classifications above the fallback owns it, so the fallback
    // must carry the bounded cause the provider actually named -- the status
    // and the strict-charset token -- and must never say "verify
    // authentication" about a billing refusal, and never echo the body.
    const error = await conversation.step("do it").catch((cause) => cause);
    expect(error).toMatchObject({
      code: "empty_turn",
      providerStatus: 402,
      providerErrorCode: "insufficient_credits",
    });
    expect(error.message).not.toContain("verify authentication");
    expect(error.message).toContain("HTTP 402");
    expect(error.message).toContain("provider error code insufficient_credits");
    expect(error.message).not.toContain("exceeded your monthly spend");
    expect(error.message).not.toContain('insufficient_credits","message"');
  } finally {
    await conversation.close();
  }
});

test("#368: a generation truncated at the output limit surfaces as a typed truncated outcome through conversation", async () => {
  const { faux, models, model, role } = harnessFixture();
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  // The incident shape through the multi-turn loop: the whole output budget
  // spent on thinking (the faux provider estimates output from content, so the
  // thinking must reach the 16384-token limit), truncated mid-reasoning, no
  // text, no tool call -- settled `completed`, which the pre-fix boundary read
  // as an empty success and returned to the caller.
  faux.setResponses([
    fauxAssistantMessage([fauxThinking("reasoning ".repeat(8000))], {
      stopReason: "length",
    }),
  ]);
  const conversation = await startConversation({ role, targetDir, models, model, session });
  try {
    await expect(conversation.step("do it")).rejects.toMatchObject({
      code: "generation_truncated",
      stopReason: "length",
    });
  } finally {
    await conversation.close();
  }
});

test("#368: a length stop retried into a second truncation is typed through conversation, never an authentication claim", async () => {
  const { faux, models, model, role } = harnessFixture();
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  // pi-agent-core's bounded compact-and-retry for a length stop: the queued
  // summary feeds the retry, the retry truncates again, and the turn settles
  // `failed` with the generic assistant_error -- which the pre-fix boundary
  // misattributed to EmptyTurnError ("verify authentication").
  faux.setResponses([
    fauxAssistantMessage([fauxThinking("first truncated reasoning")], { stopReason: "length" }),
    fauxAssistantMessage("summary of the conversation so far"),
    fauxAssistantMessage([fauxThinking("second truncated reasoning")], { stopReason: "length" }),
  ]);
  const conversation = await startConversation({ role, targetDir, models, model, session });
  try {
    const error = await conversation.step("do it").catch((cause) => cause);
    expect(error).toMatchObject({ code: "generation_truncated", stopReason: "length" });
    expect(error.message).not.toContain("authentication");
  } finally {
    await conversation.close();
  }
});

test("startConversation forwards content-free background subscriptions without a model turn", async () => {
  const { models, model, role } = harnessFixture();
  let subscriber:
    | Parameters<
        NonNullable<
          import("../src/conversation/conversation").ConversationSession["subscribeBackgroundRuns"]
        >
      >[0]
    | undefined;
  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    subscribeBackgroundRuns: (consumer) => {
      subscriber = consumer;
      return () => {
        subscriber = undefined;
      };
    },
  });
  const received: string[] = [];
  const unsubscribe = conversation.subscribeBackgroundRuns?.((notice) => {
    received.push(notice.events[0]?.lifecycle ?? "missing");
  });
  subscriber?.({
    type: "background_events",
    runId: "safe-run",
    events: [{ sequence: 1, runId: "safe-run", lifecycle: "started", timestamp: 1 }],
    nextCursor: 1,
    gap: false,
    droppedEvents: 0,
    pending: false,
  });
  unsubscribe?.();
  await conversation.close();
  expect(received).toEqual(["started"]);
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

test("a conversation settles a session's interrupted operation before it prompts", async () => {
  // The durability bug this pins: a console killed mid-turn leaves its
  // operation recorded `running` in the durable session. On `--resume` the
  // harness reinstalls that operation, and `step` used to hand the operator's
  // input straight to `lane.prompt` -- which the lane refuses with an untyped
  // `LaneBusy`, before any provider call and before any ledger row. Every turn
  // after a resume died that way, so a killed session was unresumable in
  // practice. The fix settles the installed operation first (lane.resume),
  // exactly as the single-turn runner already does for a resumed stage.
  //
  // The kill is reproduced by abandonment rather than by a signal: the first
  // conversation is left mid-tool and never closed, so its operation stays
  // installed in the durable record -- which is all the second conversation
  // reads. The tool never settles, so it is the durable snapshot that carries
  // the state across, not anything still live in memory.
  let markToolStarted: () => void = () => {};
  const toolStarted = new Promise<void>((resolve) => {
    markToolStarted = resolve;
  });
  const hang = defineTool({
    name: "hang",
    description: "Never settles: stands in for a process killed mid-tool.",
    label: "hang",
    parameters: Type.Object({ note: Type.String() }),
    execute() {
      markToolStarted();
      // Never settles: the durable snapshot, not this promise, is what carries
      // the in-flight operation to the next conversation.
      return new Promise<never>(() => {});
    },
  });

  const { faux, models, model, role } = harnessFixture(["hang"]);
  const runId = `interrupted_${Date.now()}`;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("hang", { note: "in-flight" })),
    // The interrupted operation's own turn, driven to settlement by the resume.
    fauxAssistantMessage("recovered"),
    // The operator's turn, dispatched only after that settlement.
    fauxAssistantMessage("after resume"),
  ]);

  // The abandoned side is handed a session opened WITHOUT a store lease: a
  // killed process holds none, so the resumed conversation must be able to take
  // the session through the ordinary store route while this one stays open.
  const store = new ProjectStore(targetDir);
  const orphanRepo = new JsonlSessionRepo({
    fileSystem: store.fileSystem,
    sessionsRoot: store.layout.sessions,
  });
  const orphanSession = await orphanRepo.create(
    { id: runId, cwd: store.layout.targetDir },
    BACKGROUND_CONTEXT,
  );
  const killed = await startConversation({
    role,
    targetDir,
    models,
    model,
    runId,
    session: orphanSession,
    tools: [hang],
  });
  const abandoned = killed.step("work that outlives the process");
  abandoned.catch(() => {});
  await toolStarted;

  // Evidence for the assertion below is read straight off the session file,
  // because the durable file -- not the live process -- is what the resumed
  // conversation has to work from.
  const sessionsRoot = path.join(targetDir, ".ad-coder", "sessions");
  const sessionFile = fs
    .readdirSync(sessionsRoot, { recursive: true, encoding: "utf8" })
    .map((name) => path.join(sessionsRoot, name))
    .find((candidate) => candidate.endsWith(`_${runId}.jsonl`));
  expect(sessionFile).toBeDefined();
  const durableText = (): string => fs.readFileSync(sessionFile as string, "utf8");
  // `pi.op.state` is the durable operation record. If it is absent the session
  // reopened with nothing installed, and every assertion below would pass for
  // the wrong reason (the faux responses would simply be consumed in order).
  expect(durableText()).toContain("pi.op.state");

  const resumed = await startConversation({ role, targetDir, models, model, runId, tools: [hang] });
  try {
    expect((await resumed.step("what happened")).assistantText).toBe("after resume");
  } finally {
    await resumed.close();
  }

  // The recovered turn really ran: its answer reached the durable history, so
  // the step settled the interrupted operation instead of stepping over it.
  expect(durableText()).toContain("recovered");
  expect(durableText()).toContain("after resume");
});

test("#428: a session killed mid-assistant-effect replays safely and its resumed turn settles as a typed empty-turn failure (measured pin)", async () => {
  // MEASUREMENT NOTE (filled after the red run).
  const { faux, models, model, role } = harnessFixture();
  // The kill happens while the ASSISTANT effect is pending: pi-agent-core
  // commits the durable operation state at "assistant.effect_pending"
  // BEFORE the provider call is made (drive/generation.js:
  // publishGenerationIntent -> performGeneration), so a model whose
  // streamSimple never settles leaves exactly the state measured in the
  // ticket — control.status "running", at "assistant.effect_pending",
  // installed as the lane's currentOperationId.
  const frozenModels = new Proxy(models, {
    get(target, property, receiver) {
      if (property === "streamSimple") {
        return () => new Promise<never>(() => {});
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const responseReady = new Promise<never>(() => {});
  void responseReady;
  faux.setResponses([fauxAssistantMessage("never settles")]);

  const runId = `effect_pending_${Date.now()}`;
  const store = new ProjectStore(targetDir);
  const orphanRepo = new JsonlSessionRepo({
    fileSystem: store.fileSystem,
    sessionsRoot: store.layout.sessions,
  });
  const orphanSession = await orphanRepo.create(
    { id: runId, cwd: store.layout.targetDir },
    BACKGROUND_CONTEXT,
  );
  const killed = await startConversation({
    role,
    targetDir,
    models: frozenModels,
    model,
    runId,
    session: orphanSession,
  });
  void killed.step("work killed mid-stream").catch(() => {});

  const sessionsRoot = path.join(targetDir, ".ad-coder", "sessions");
  const sessionFile = fs
    .readdirSync(sessionsRoot, { recursive: true, encoding: "utf8" })
    .map((name) => path.join(sessionsRoot, name))
    .find((candidate) => candidate.endsWith(`_${runId}.jsonl`));
  expect(sessionFile).toBeDefined();
  const durableText = (): string => fs.readFileSync(sessionFile as string, "utf8");
  // Wait until the durable file shows the same state the ticket measured.
  const deadline = Date.now() + 10_000;
  while (!durableText().includes("assistant.effect_pending")) {
    if (Date.now() > deadline) throw new Error("operation never reached assistant.effect_pending");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const linesBefore = durableText().split("\n").length;

  const resumed = await startConversation({ role, targetDir, models, model, runId });
  try {
    const started = Date.now();
    const cause = await resumed.step("hello after restart").catch((error) => error);
    const elapsedMs = Date.now() - started;
    // MEASURED CURRENT BEHAVIOR (2026-09-19, issue #428), pinned as the red
    // run found it. The vendor replays the orphaned operation recorded at
    // `assistant.effect_pending` with no provider call (synthetic settle),
    // so the resumed turn proceeds normally into the harness -- and then the
    // recovery settles the replayed generation as EmptyTurnError -- a typed
    // outcome, not a plain Error, and NOT a stuck lane:
    expect(cause).toBeInstanceOf(EmptyTurnError);
    expect((cause as { code: string }).code).toBe("empty_turn");
    // The typed message pins the OPEN QUESTION from the ticket verbatim: its
    // "verify authentication and retry" advice fits a declined provider
    // credential, not a previous turn that was killed mid-stream and replayed
    // as an interrupted marker. The operator asked whether that advice should
    // change; that question is deliberately NOT fixed in this PR -- this
    // assertion documents the measured state as-is.
    expect((cause as Error).message).toBe(
      "the provider returned a failed empty turn; verify authentication and retry (provider code assistant_error)",
    );
    // The typed error still locates the run for programmatic callers.
    expect((cause as { runId: string }).runId).toBe(runId);
    // And it fails immediately, before any provider call the same way the
    // two-process diagnosis (/tmp/fx428) measured it:
    expect(elapsedMs).toBeLessThan(5000);
    // DURABLE RESULT: the replayed orphan operation is still recorded
    // (`assistant.effect_pending` stays as history), the resumed run gains
    // records (the synthetic settle writes -- so the earlier "no records at
    // all" reading was wrong), and the last settled status is `failed`, not
    // the kill's `running` -- the lane does not STICK on the killed state.
    expect(durableText()).toContain("assistant.effect_pending");
    expect(durableText().split("\n").length).toBeGreaterThan(linesBefore);
    const settledStatuses = durableText().match(/"status":"[a-z_]+"/g) ?? [];
    expect(settledStatuses.at(-1)).toBe('"status":"failed"');
  } finally {
    await resumed.close();
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
  await expect(conversation.step("overlap")).rejects.toThrow(ConversationRefusedError);
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

test("the summarizer is attached once and does not run under budget across turns", async () => {
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

    // Registered once at startConversation, never per turn, and the harness only
    // asks for a summary at its own threshold -- which two small turns do not
    // reach. No per-turn cost from having compaction enabled.
    expect(summarizerCalls).toBe(0);
    expect(faux.state.callCount).toBe(2);
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

/** The harness's own summarization prompt, as `pi-agent-core` sends it. */
const HARNESS_SUMMARY_PROMPT = "context summarization assistant";

/** A role whose budget makes the harness threshold 1000 tokens on a 200k window. */
function tightRole(model: Model<Api>) {
  return defineRole(
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
}

test("a dead summarizer falls back to the role's own model instead of ending the run", async () => {
  const { faux, models, model } = harnessFixture();
  const role = tightRole(model);
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  const secret = `compaction-secret:${"z".repeat(4000)}`;
  const prompts: string[] = [];
  let asked = 0;
  const summarizer: Summarizer = async () => {
    asked += 1;
    throw new Error(secret);
  };
  faux.setResponses(
    Array.from({ length: 24 }, () => (request: { systemPrompt?: string }) => {
      prompts.push(request.systemPrompt ?? "");
      return fauxAssistantMessage("reply");
    }),
  );

  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    session,
    summarizer,
  });
  try {
    // A dead cheap summarizer is a degraded route, not the end of the session:
    // the harness summarizes with the role's model and the run continues (#444).
    for (let turn = 0; turn < 6; turn++) await conversation.step(`${turn}:${"x".repeat(900)}`);

    // Ours was asked first -- the fallback is a fallback, not the default path.
    expect(asked).toBeGreaterThan(0);
    // And the fallback really happened, with the harness's own prompt and model.
    expect(prompts.some((prompt) => prompt.includes(HARNESS_SUMMARY_PROMPT))).toBe(true);

    const compactions = (
      await session.findEntries({ type: "compaction" }, BACKGROUND_CONTEXT)
    ).filter((entry) => entry.type === "compaction");
    expect(compactions.length).toBeGreaterThan(0);
    // `fromHook: false` is the durable record of WHO summarized: the harness,
    // because our handler declined.
    expect(compactions.every((entry) => entry.fromHook === false)).toBe(true);
    // Leak invariant: the thrown text can carry the evicted conversation, and
    // the compaction entry is durable.
    expect(JSON.stringify(compactions)).not.toContain(secret);
  } finally {
    await conversation.close();
  }
});

test("a harness compaction that fails outright ends the session with a reopen, not a retry", async () => {
  const { faux, models, model } = harnessFixture();
  const role = tightRole(model);
  const session = await new MemorySessionRepo().create({}, BACKGROUND_CONTEXT);
  // Our summarizer declines (so the harness takes over) and the harness's own
  // summary request is refused with a NON-retryable cause, so the operation
  // settles as `summarization_failed` after one attempt.
  const summarizer: Summarizer = async () => {
    throw new Error("declined");
  };
  faux.setResponses(
    Array.from(
      { length: 24 },
      () => (request: { systemPrompt?: string }) =>
        request.systemPrompt?.includes(HARNESS_SUMMARY_PROMPT) === true
          ? fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: "summary request rejected",
            })
          : fauxAssistantMessage("reply"),
    ),
  );

  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    session,
    summarizer,
  });
  try {
    let caught: unknown;
    for (let turn = 0; turn < 6; turn++) {
      try {
        await conversation.step(`${turn}:${"x".repeat(900)}`);
      } catch (error) {
        caught = error;
        break;
      }
    }
    // Typed as what it is: the session's context can no longer be summarized,
    // which is a stop rather than an over-budget turn (issue #391).
    expect(caught).toBeInstanceOf(ContextBudgetError);
    expect(caught).toBeInstanceOf(ContextCompactionLostError);
    const error = caught as ContextCompactionLostError;
    expect(error.effectiveCeiling).toBe(CONTEXT_WINDOW);
    expect(error.lastFailure?.stopReason).toBe("summarization_failed");
    expect(error.message).toContain("this session can no longer compact");
    // Reopening the session, not retrying the turn, is the way out.
    expect(error.message).toContain("--resume");
    expect(error.message).not.toContain("summary request rejected");

    // The stop is durable: no further provider dispatch happens on this session.
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

test("an operator block refuses a conversation turn, so the console cannot bypass it", async () => {
  const { faux, models, model, role } = harnessFixture([]);
  faux.setResponses([
    fauxAssistantMessage("this turn must never reach the provider"),
    fauxAssistantMessage("released"),
  ]);
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-console-block-"));
  const detector = new CostAnomalyDetector({}, new MemoryCostAnomalyStore());
  const observation = { provider: "faux", model: "faux-1", expectedUsd: 0.002 };
  for (let index = 0; index < 5; index += 1)
    detector.observe({ ...observation, chargedUsd: 0.002 });
  detector.observe({ ...observation, chargedUsd: 0.008 });
  detector.observe({ ...observation, chargedUsd: 0.008 });
  expect(detector.blocked()).toHaveLength(1);

  const blockedConversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    costAnomalyDetector: detector,
  });
  // The typed refusal, not the harness's generic fault: the refusal carries the
  // price evidence and the release command, and the operator has to be able to
  // tell a blocked scope from a crash.
  await expect(blockedConversation.step("hello")).rejects.toBeInstanceOf(CostAnomalyBlockedError);
  await blockedConversation.close();

  // A SECOND conversation, not another turn on the first: a throw at the Models
  // boundary makes pi-agent-core seal that harness permanently (`fault()` latches
  // `faultError` and seals every lane), so the refused conversation stays dead by
  // design and the operator resumes by starting a new one. Asserted here because
  // it proves the gate is the BLOCK rather than a conversation that refuses
  // everything -- the same fixture runs once the scope is released.
  detector.release("faux", "faux-1");
  const releasedConversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    costAnomalyDetector: detector,
  });
  const released = await releasedConversation.step("hello");
  expect(released.status).toBe("completed");
  await releasedConversation.close();
  fs.rmSync(targetDir, { recursive: true, force: true });
});

test("a refused turn leaves exactly one ledger row with the refusal field and zero usage (issue #422)", async () => {
  const { faux, models, model, role } = harnessFixture(["blocking_tool"]);
  const sink = new MemoryLedgerSink();
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
    description: "Keep the step active until the test reads the refusal row.",
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
    ledgerSink: sink,
  });
  try {
    expect(sink.records()).toHaveLength(0);
    // The active step keeps `stepping` true, so the concurrent step is refused
    // before any provider call and before the turn counter moves.
    const active = conversation.step("hold the step");
    void active.catch(() => undefined);
    await started;
    await expect(conversation.step("overlap")).rejects.toThrow(ConversationRefusedError);
    // The refusal happened before the provider: the turn had no after_response
    // hook to fire, so the sink holds the refusal trace ALONE.
    const rows = sink.records();
    // The held turn itself emitted its own provider row when the tool call
    // response settled. The Refusal row is its OWN single line, appended after
    // it, zero-usage and carrying the refusal field.
    expect(rows).toHaveLength(2);
    const row = rows[1]!;
    expect(row.stopReason).toBe("refusal");
    expect(row.step).toBe("turn:2");
    expect(row.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(row.provider).toBe("faux");
    expect(row.model).toBe("faux-1");
    expect(row.refusal).toEqual({
      code: "conversation_refused",
      reason: "step_active",
      message: "conversation step already active",
    });
    // Identifiers and numbers only: the prompt text never reaches the ledger.
    expect(JSON.stringify(row)).not.toContain("overlap");
    expect(JSON.stringify(row)).not.toContain("hold the step");
    // The refusal never advanced the counter: a SECOND refusal while the same
    // turn is still held names the same number again -- the number the refused
    // turn would have had.
    await expect(conversation.step("overlap again")).rejects.toThrow(ConversationRefusedError);
    const rowsAfter = sink.records();
    expect(rowsAfter).toHaveLength(3);
    expect(rowsAfter[2]!.refusal).toEqual({
      code: "conversation_refused",
      reason: "step_active",
      message: "conversation step already active",
    });
    expect(rowsAfter[2]!.step).toBe("turn:2");
    expect(rowsAfter[2]!.usage.totalTokens).toBe(0);
  } finally {
    releaseTool?.();
    await conversation.close();
  }
});

test("a closed conversation refuses with the authored sentence and one ledger row", async () => {
  const { faux, models, model, role } = harnessFixture();
  const sink = new MemoryLedgerSink();
  faux.setResponses([fauxAssistantMessage("never reached")]);

  const conversation = await startConversation({
    role,
    targetDir,
    models,
    model,
    ledgerSink: sink,
  });
  await conversation.close();
  expect(sink.records()).toHaveLength(0);
  await expect(conversation.step("after close")).rejects.toThrow(ConversationRefusedError);
  const rows = sink.records();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.refusal).toEqual({
    code: "conversation_refused",
    reason: "closed",
    message: "conversation is closed",
  });
  expect(rows[0]!.usage.totalTokens).toBe(0);
});
