import { expect, test } from "bun:test";
import type { AssistantMessage, Models, TextContent, ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
  recoverNativeToolCalls,
  wrapModelsForToolCallRecovery,
} from "../src/runner/native-tool-calls";

/** The recovered block is always appended last. */
function lastBlockAsToolCall(message: AssistantMessage): ToolCall {
  const block = message.content[message.content.length - 1];
  if (block === undefined || block.type !== "toolCall") throw new Error("no recovered tool call");
  return block;
}

const GRANTED = ["submit_plan", "bash"];

const DSML_INVOKE_SERIALIZATION = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="submit_plan">',
  '<｜｜DSML｜｜ parameter name="complexity" string="true">medium</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="securitySurface" string="true">low</｜｜DSML｜｜ parameter>',
  '<｜｜DSML｜｜ parameter name="attempts" string="false">2</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n");

const MINIMAX_INVOKE_SERIALIZATION = [
  '<invoke name="submit_plan">',
  '<parameter name="complexity">"high"</parameter>',
  '<parameter name="securitySurface">low</parameter>',
  "</invoke>",
].join("\n");

function messageEndingWith(serialization: string, suffix = ""): AssistantMessage {
  return fauxAssistantMessage(
    [fauxText(`Interim analysis complete.\n\n${serialization}${suffix}`)],
    { stopReason: "stop" },
  );
}

/** Gate 1: a structured tool call anywhere means no recovery, byte for byte. */
test("a message that already carries a structured tool call is left untouched", () => {
  const message = fauxAssistantMessage(
    [
      fauxText(`Let me submit.\n\n${DSML_INVOKE_SERIALIZATION}`),
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } },
    ],
    { stopReason: "toolUse" },
  );
  const before = structuredClone(message) as unknown as AssistantMessage;
  expect(recoverNativeToolCalls(message, GRANTED)).toEqual(before);
});

/** Gate 2: only a granted name is recoverable; ungranted markup stays text. */
test("an ungranted tool name is not recovered", () => {
  const serialization = DSML_INVOKE_SERIALIZATION.replace(
    'name="submit_plan"',
    'name="rm_rf_everything"',
  );
  const message = messageEndingWith(serialization);
  const before = structuredClone(message) as unknown as AssistantMessage;
  expect(recoverNativeToolCalls(message, GRANTED)).toEqual(before);
  expect(
    message.content[0] !== undefined && "type" in message.content[0]
      ? message.content[0].type
      : "none",
  ).toBe("text");
});

/** Gate 3: the serialization must be the last thing in the text. */
test("markup followed by more text is not recovered", () => {
  const message = messageEndingWith(DSML_INVOKE_SERIALIZATION, "\n\nAnd then I will verify.");
  const before = structuredClone(message) as unknown as AssistantMessage;
  expect(recoverNativeToolCalls(message, GRANTED)).toEqual(before);
  expect(
    message.content[0] !== undefined && "type" in message.content[0]
      ? message.content[0].type
      : "none",
  ).toBe("text");
});

/** DeepSeek delimiter markup at the end is recovered into a toolCall block. */
test("trailing DeepSeek delimiter markup is recovered with a marker and parsed arguments", () => {
  const message = messageEndingWith(DSML_INVOKE_SERIALIZATION);
  const recovered = recoverNativeToolCalls(message, GRANTED);
  expect(recovered).toBe(message);
  expect(recovered.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
  const toolCall = lastBlockAsToolCall(recovered);
  expect(toolCall.id).toBe("recovered-submit_plan");
  expect(toolCall.name).toBe("submit_plan");
  expect(toolCall.arguments).toEqual({ complexity: "medium", securitySurface: "low", attempts: 2 });
  const text = recovered.content[0] as TextContent;
  expect(text.text).toContain("[recovered tool call: submit_plan]");
  expect(text.text).toContain("Interim analysis complete.");
  expect(text.text).not.toContain("DSML");
});

/** The minimax pseudo-XML invoke form is recovered the same way. */
test("a trailing minimax invoke block is recovered the same way", () => {
  const message = messageEndingWith(MINIMAX_INVOKE_SERIALIZATION);
  const recovered = recoverNativeToolCalls(message, GRANTED);
  expect(recovered.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
  const toolCall = lastBlockAsToolCall(recovered);
  expect(toolCall.name).toBe("submit_plan");
  // JSON that parses into an object is kept as an object; bare text stays text.
  expect(toolCall.arguments).toEqual({ complexity: "high", securitySurface: "low" });
  expect((recovered.content[0] as TextContent).text).toContain(
    "[recovered tool call: submit_plan]",
  );
});

/**
 * Wiring: the wrapper repairs the final assistant message at the model
 * boundary, delegating inward exactly once.
 */
test("the models wrapper repairs the final message with the granted names", async () => {
  const inner = fauxAssistantMessage(`working…\n\n${MINIMAX_INVOKE_SERIALIZATION}`);
  const models = wrapModelsForToolCallRecovery(
    {
      completeSimple: async () => inner,
    } as unknown as Models,
    GRANTED,
  );
  const result = await (
    models as unknown as { completeSimple: () => Promise<AssistantMessage> }
  ).completeSimple();
  expect(result).toBe(inner);
  expect(result.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
});

/**
 * The stream method resolves the same message through `result()`, in place, so
 * the harness executes the recovered call rather than reading it as prose. The
 * second half is the failure path: the wrapper observes the promise without
 * owning it, so a stream that rejects must not raise a second, unhandled
 * rejection -- bun reports an unhandled rejection between tests, which is the
 * proof this asserts.
 */
test("the wrapper repairs a streamed message and leaves a stream's failure to its caller", async () => {
  const inner = fauxAssistantMessage(`working…\n\n${MINIMAX_INVOKE_SERIALIZATION}`);
  const streaming = wrapModelsForToolCallRecovery(
    { stream: () => ({ result: async () => inner }) } as unknown as Models,
    GRANTED,
  );
  const stream = (
    streaming as unknown as { stream: () => { result(): Promise<AssistantMessage> } }
  ).stream();
  const result = await stream.result();
  expect(result).toBe(inner);
  expect(result.content.map((block) => block.type)).toEqual(["text", "toolCall"]);

  const failing = wrapModelsForToolCallRecovery(
    {
      stream: () => ({
        result: async () => {
          throw new Error("provider down");
        },
      }),
    } as unknown as Models,
    GRANTED,
  );
  const broken = (
    failing as unknown as { stream: () => { result(): Promise<AssistantMessage> } }
  ).stream();
  await expect(broken.result()).rejects.toThrow("provider down");
});
