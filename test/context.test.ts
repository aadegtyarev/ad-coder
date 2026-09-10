import { expect, test } from "bun:test";
import type { AgentMessage, Hooks } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  assertTurnFitsBudget,
  ContextBudgetError,
  ContextCompactor,
  defineRole,
  SUMMARIZATION_PROMPT,
} from "../src/index";
import type { ContextBudget, Role, Summarizer } from "../src/index";
import { selectRecentTail } from "../src/context/compactor";

// ~4 chars per token in the estimator, so char counts map to rough token sizes.
function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}
const big = () => userMessage("x".repeat(4000)); // ~1000 tokens
const small = (tag: string) => userMessage(`${tag}:${"y".repeat(400)}`); // ~100 tokens

// A caller-supplied model absent from the builtin catalog: a plain object with
// only the field the code reads. No network, no catalog lookup.
const localModel = { contextWindow: 16_000 } as unknown as Model<Api>;

/** Capture the handler a ContextCompactor registers, so we can drive it directly. */
function captureTransform(compactor: ContextCompactor): (messages: AgentMessage[]) => unknown {
  let handler: ((event: { messages: AgentMessage[]; systemPrompt: string }) => unknown) | undefined;
  const hooks = {
    on(_name: string, fn: (event: { messages: AgentMessage[]; systemPrompt: string }) => unknown) {
      handler = fn;
      return () => {};
    },
  } as unknown as Hooks;
  compactor.attach(hooks);
  if (handler === undefined) throw new Error("compactor did not register a handler");
  const registered = handler;
  return (messages) => registered({ messages, systemPrompt: "" });
}

test("SUMMARIZATION_PROMPT is ad-coder's own named constant, not empty", () => {
  expect(typeof SUMMARIZATION_PROMPT).toBe("string");
  expect(SUMMARIZATION_PROMPT.length).toBeGreaterThan(0);
});

test("selectRecentTail keeps the whole conversation when it fits keepRecentTokens", () => {
  const messages = [small("a"), small("b")];
  const { head, tail } = selectRecentTail(messages, 1000);
  expect(head).toEqual([]);
  expect(tail).toEqual(messages);
});

test("selectRecentTail splits off the older head when over keepRecentTokens", () => {
  const messages = [big(), small("a"), small("b")];
  const { head, tail } = selectRecentTail(messages, 300);
  expect(head).toEqual([messages[0] as AgentMessage]);
  expect(tail).toEqual([messages[1] as AgentMessage, messages[2] as AgentMessage]);
});

test("selectRecentTail never returns an empty tail for a non-empty input", () => {
  const messages = [big()];
  const { head, tail } = selectRecentTail(messages, 10);
  expect(head).toEqual([]);
  expect(tail).toEqual(messages);
});

test("under-budget context passes through untouched and the summarizer is not called", async () => {
  let calls = 0;
  const summarizer: Summarizer = async () => {
    calls += 1;
    return "SUMMARY";
  };
  const budget: ContextBudget = { maxTokens: 2000, reserveTokens: 200, keepRecentTokens: 300 };
  const transform = captureTransform(new ContextCompactor({ budget, summarizer }));

  const result = await transform([small("a"), small("b"), small("c")]);
  expect(result).toBeUndefined();
  expect(calls).toBe(0);
});

test("over-budget context is summarized once with only the evicted head, tail verbatim", async () => {
  const seen: AgentMessage[][] = [];
  const summarizer: Summarizer = async (messages) => {
    seen.push(messages);
    return "SUMMARY";
  };
  const budget: ContextBudget = { maxTokens: 2000, reserveTokens: 200, keepRecentTokens: 300 };
  const transform = captureTransform(new ContextCompactor({ budget, summarizer }));

  const messages = [big(), big(), big(), small("tail1"), small("tail2")];
  const head = messages.slice(0, 3);
  const tail = messages.slice(3);

  const result = (await transform(messages)) as { messages: AgentMessage[] };
  expect(seen.length).toBe(1);
  expect(seen[0]).toEqual(head); // only the evicted head, never the tail
  expect(result.messages.length).toBe(1 + tail.length);
  expect((result.messages[0] as { role: string; content: string }).content).toBe("SUMMARY");
  expect((result.messages[0] as { role: string }).role).toBe("user");
  expect(result.messages.slice(1)).toEqual(tail); // recent tail preserved verbatim
});

test("a summarizer that throws leaves messages untransformed and bumps compactionFailures", async () => {
  const secret = "z".repeat(4000);
  const summarizer: Summarizer = async () => {
    throw new Error(`boom ${secret}`);
  };
  const budget: ContextBudget = { maxTokens: 2000, reserveTokens: 200, keepRecentTokens: 300 };
  const compactor = new ContextCompactor({ budget, summarizer });
  const transform = captureTransform(compactor);

  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
    writes.push(chunk.toString());
    return true;
  };
  try {
    const result = await transform([big(), big(), big(), small("t1"), small("t2")]);
    expect(result).toBeUndefined();
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  expect(compactor.compactionFailures).toBe(1);
  // Leak invariant: the warning carries numbers only, never the evicted content.
  const warning = writes.join("");
  expect(warning).toContain("compaction failed");
  expect(warning).not.toContain(secret);
  expect(warning).not.toContain("boom");
});

test("assertTurnFitsBudget returns void when the irreducible tail plus reserve fits", () => {
  const role = defineRole(
    {
      name: "planner",
      provider: "local",
      modelId: "qwen",
      systemPrompt: "You plan.",
      activeToolNames: [],
      cacheRetention: "short",
      contextBudget: { maxTokens: 8000, reserveTokens: 500, keepRecentTokens: 2000 },
    },
    localModel,
  );
  expect(() =>
    assertTurnFitsBudget(role, [small("a"), small("b")], localModel),
  ).not.toThrow();
});

test("assertTurnFitsBudget throws a typed ContextBudgetError on an impossible turn", () => {
  const role = defineRole(
    {
      name: "planner",
      provider: "local",
      modelId: "qwen",
      systemPrompt: "You plan.",
      activeToolNames: [],
      cacheRetention: "short",
      contextBudget: { maxTokens: 1000, reserveTokens: 100, keepRecentTokens: 200 },
    },
    localModel,
  );
  // The final message alone (~1000 tokens) is the irreducible tail floor.
  let caught: unknown;
  try {
    assertTurnFitsBudget(role, [small("a"), big()], localModel);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ContextBudgetError);
  const err = caught as ContextBudgetError;
  expect(err.name).toBe("ContextBudgetError");
  expect(err.role).toBe("planner");
  expect(err.maxTokens).toBe(1000);
  // Message carries identifiers and numbers only, no message content.
  expect(err.message).toContain("planner");
  expect(err.message).toContain("1000");
  expect(err.message).not.toContain("y".repeat(400));
});
