import { expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  type EstimatorTool,
  estimateFullRequestTokens,
  estimateOverheadTokens,
  grantedTools,
} from "../src/context/estimate";
import {
  assertContextFitsBudget,
  assertTurnFitsBudget,
  ContextBudgetError,
  createSummarizer,
  SUMMARIZATION_PROMPT,
} from "../src/index";
import { defineRole } from "../src/role";

// ~4 chars per token in the estimator, so char counts map to rough token sizes.
const userMessage = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const localModel = { contextWindow: 16_000 } as unknown as Model<Api>;

const tools: EstimatorTool[] = [
  { name: "bash", description: "d".repeat(400), parameters: { type: "object" } },
];

test("estimateOverheadTokens counts the system prompt and tool definitions", () => {
  // ~100 tokens of prompt (~4 chars per token), ~100 per tool.
  expect(estimateOverheadTokens({ systemPrompt: "s".repeat(400) })).toBe(100);
  expect(estimateOverheadTokens({ systemPrompt: "s".repeat(400), tools })).toBe(206);
  expect(estimateOverheadTokens({ tools })).toBe(106);
  expect(estimateOverheadTokens({})).toBe(0);
});

test("estimateFullRequestTokens adds system/tools overhead only with no prior usage", () => {
  const messages = [userMessage("q".repeat(400))]; // ~100 tokens
  const estimateOnly = estimateFullRequestTokens({
    systemPrompt: "s".repeat(400),
    tools,
    messages,
  });
  expect(estimateOnly.usageBased).toBe(false);
  expect(estimateOnly.overheadTokens).toBe(206);
  expect(estimateOnly.tokens).toBe(306);

  // A provider-reported usage IS the full request: it was computed over the
  // system prompt and tools the provider was sent. Adding the 200 overhead
  // again would double-count exactly the bytes a later request reuses.
  const withUsage = estimateFullRequestTokens({
    systemPrompt: "s".repeat(400),
    tools,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "reply" }],
        stopReason: "stop",
        usage: { input: 900, output: 10, cacheRead: 0, cacheWrite: 0 },
        timestamp: 2,
      } as unknown as AgentMessage,
      userMessage("q".repeat(400)),
    ],
  });
  expect(withUsage.usageBased).toBe(true);
  expect(withUsage.overheadTokens).toBe(0);
  // usage 900+10 from the last assistant message, plus the ~100-token
  // trailing user message; NO system/tools overhead added on top of it.
  expect(withUsage.tokens).toBe(1010);
});

test("grantedTools mirrors the harness allow-list read", () => {
  expect(grantedTools(undefined, tools)).toEqual(tools); // default-open
  expect(grantedTools(["bash"], tools)).toEqual(tools);
  expect(grantedTools(["nope"], tools)).toEqual([]);
  expect(grantedTools([], tools)).toEqual([]);
});

test("assertTurnFitsBudget refuses an irreducible full request before transport", () => {
  const role = defineRole(
    {
      name: "planner",
      provider: "local",
      modelId: "qwen",
      systemPrompt: "s".repeat(400),
      activeToolNames: ["bash"],
      cacheRetention: "short",
      contextBudget: { maxTokens: 1000, reserveTokens: 100, keepRecentTokens: 200 },
    },
    localModel,
  );
  // Dialogue ~400 + overhead 200 + reserve 100 fits exactly under 1000.
  expect(() =>
    assertTurnFitsBudget(
      role,
      { systemPrompt: "s".repeat(400), tools, messages: [userMessage("q".repeat(1600))] },
      localModel,
    ),
  ).not.toThrow();
  // Dialogue ~801 tokens + overhead 206 + reserve 100 exceeds 1000: the
  // irreducible tail cannot fit.
  let caught: unknown;
  try {
    assertTurnFitsBudget(
      role,
      { systemPrompt: "s".repeat(400), tools, messages: [userMessage("q".repeat(3200))] },
      localModel,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContextBudgetError);
  const error = caught as ContextBudgetError;
  // Diagnostics are numbers and identifiers only, never request content.
  expect(error.overheadTokens ?? 0).toBe(206);
  expect(error.message).not.toContain("q".repeat(1604));
  // A later provider-reported usage IS the whole request: no overhead is
  // added again, so what the provider says fits is allowed through.
  expect(() =>
    assertTurnFitsBudget(
      role,
      {
        systemPrompt: "s".repeat(400),
        tools,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "reply" }],
            stopReason: "stop",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            timestamp: 2,
          } as unknown as AgentMessage,
          userMessage("z".repeat(16_000)),
        ],
      },
      localModel,
    ),
  ).toThrow(); // irreducible tail still refuses on its own estimate
  expect(() =>
    assertContextFitsBudget(
      role,
      {
        systemPrompt: "s".repeat(400),
        tools,
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "reply" }],
            stopReason: "stop",
            usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
            timestamp: 2,
          } as unknown as AgentMessage,
          userMessage("z".repeat(1600)),
        ],
      },
      localModel,
    ),
  ).not.toThrow(); // overhead is NOT double-counted onto provider usage
});

test("createSummarizer keeps the summarizer request free of role system prompt and tools", async () => {
  const faux = fauxProvider({ provider: "summary", models: [{ id: "cheap" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    (context) => {
      // Compaction input is the evicted DIALOGUE only: its own one-shot
      // prompt on the system slot, tools: []. No role prompt, no tool defs.
      expect(context.systemPrompt).toBe(SUMMARIZATION_PROMPT);
      expect(context.tools).toEqual([]);
      return fauxAssistantMessage([{ type: "text", text: "brief" }]);
    },
  ]);
  expect(
    await createSummarizer(models, faux.getModel() as Model<Api>)([userMessage("dialogue")]),
  ).toBe("brief");
});
