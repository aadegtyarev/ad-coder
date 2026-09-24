import {
  type AgentMessage,
  estimateContextTokens,
  estimateTokens,
} from "@earendil-works/pi-agent-core";

/**
 * The structural slice of a tool definition that reaches the provider's token
 * count: its name, its description, and its JSON-schema parameters. Structural
 * only -- `execute`, metadata and any declared-but-not-granted counterpart are
 * never read, so nothing here can carry conversation content.
 */
export interface EstimatorTool {
  name: string;
  description: string;
  parameters?: unknown;
}

/**
 * One full provider request as pi-ai's `Context` shapes it:
 * `{ systemPrompt?, messages, tools? }`. `messages` holds the dialogue
 * pi-agent-core already measures (provider usage when the last valid assistant
 * message carries it, per-message character heuristics otherwise); the system
 * prompt and the tool definitions ride OUTSIDE that list and are separately
 * estimated here.
 */
export interface FullRequestContext {
  /** The system prompt exactly as the request will carry it. */
  systemPrompt?: string;
  /** The tool definitions the request will actually grant. */
  tools?: readonly EstimatorTool[];
  /** The dialogue messages. */
  messages: AgentMessage[];
}

/** Full-request context size, in estimated provider tokens. */
export interface FullRequestEstimate {
  /**
   * Tokens for the whole request: system prompt + tools + dialogue. When
   * `usageBased` this is the provider-reported figure plus trailing estimates.
   */
  tokens: number;
  /**
   * How much of `tokens` came from the system prompt and tool definitions.
   * THIS IS ZERO whenever a usable prior assistant usage exists, because the
   * provider's reported `totalTokens` already counts the system prompt and
   * tools it was sent -- adding the overhead again would double-count them.
   */
  overheadTokens: number;
  /** True when the dialogue measure came from provider-reported usage. */
  usageBased: boolean;
}

/**
 * Estimate one message-like content blob with the same conservative character
 * heuristic pi-agent-core's `estimateTokens` applies to dialogue messages. A
 * message shape is used only because that is the estimator's input contract;
 * no message is ever built, sent, or carried in the result.
 */
function estimateBlob(text: string): number {
  return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

/** Estimate the system prompt and tool definitions of one request. */
export function estimateOverheadTokens(context: {
  systemPrompt?: string;
  tools?: readonly EstimatorTool[];
}): number {
  let overhead = 0;
  if (context.systemPrompt !== undefined && context.systemPrompt !== "") {
    overhead += estimateBlob(context.systemPrompt);
  }
  for (const tool of context.tools ?? []) {
    // Structural JSON only: name, description, parameter SCHEMA. No tool
    // output, no conversation content can pass through this string.
    overhead += estimateBlob(
      `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters ?? {})}`,
    );
  }
  return overhead;
}

/**
 * Projection of a role's tool allow-list onto registered tools. The harness
 * grants `activeToolNames` when present and every registered tool otherwise,
 * so the estimator grants the same set the request will actually carry. Never
 * throws: a tool name in the allow-list that was not registered is simply not
 * sent, so it costs nothing.
 */
export function grantedTools<Tool extends EstimatorTool>(
  activeToolNames: string[] | undefined,
  tools: readonly Tool[],
): Tool[] {
  if (activeToolNames === undefined) return [...tools];
  const allowed = new Set(activeToolNames);
  return tools.filter((tool) => allowed.has(tool.name));
}

/**
 * ONE shared estimator for the FULL request a provider will receive, in pi-ai
 * `Context` semantics. The dialogue is measured by pi-agent-core's
 * `estimateContextTokens`, which prefers the last valid assistant message's
 * provider-reported usage and only falls back to per-message character
 * heuristics when none exists.
 *
 * The system prompt and tools are added ONLY on that fallback path. When
 * provider usage IS available, its `totalTokens` was computed by the provider
 * over the complete request it received -- system prompt and tools included --
 * so the overhead is already inside the number and adding it again would
 * double-count exactly the bytes a later request reuses. From a first turn
 * (no usage yet) forward, the estimate is the full request; from the first
 * billable response onward, the provider's own number governs.
 */
export function estimateFullRequestTokens(context: FullRequestContext): FullRequestEstimate {
  const dialogue = estimateContextTokens(context.messages);
  const usageBased = dialogue.usageTokens > 0;
  if (usageBased) {
    return { tokens: dialogue.tokens, overheadTokens: 0, usageBased: true };
  }
  const overheadTokens = estimateOverheadTokens(context);
  return {
    tokens: dialogue.tokens + overheadTokens,
    overheadTokens,
    usageBased: false,
  };
}
