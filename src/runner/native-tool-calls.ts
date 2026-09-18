/**
 * Recovery of tool calls a provider serialized into assistant TEXT instead of a
 * structured tool-call block (issue #292).
 *
 * Recovery exists for a transport that dropped a call, never for a model that
 * talked about one: only serialization the model itself emitted in its tool-call
 * markup and whose structured envelope got lost may be recovered into an
 * action, never a tool call merely described in prose.
 *
 * Three gates, each failing closed (the message is returned untouched):
 * 1. the assistant message must carry NO structured tool-call block at all;
 * 2. the recovered name must be one of the tools the request actually granted;
 * 3. the serialization must be the LAST thing in the text, with nothing after
 *    its closing token but whitespace.
 *
 * Two real shapes, both taken from captured runs (see issue #292):
 * - the DeepSeek channel's delimiter markup:
 *     `<｜｜DSML｜｜ calls>`
 *     `<｜｜DSML｜｜ invoke name="submit_plan">`
 *     `<｜｜DSML｜｜ parameter name="complexity" string="true">medium</｜｜DSML｜｜ parameter>`
 *     ... `</｜｜DSML｜｜ invoke>` followed by `</｜｜DSML｜｜ calls>`
 *     (run e4ccfbdb-37b1-47bd-8bc3-3d5e6ac5372f and run 88018a34, where
 *     deepseek-v4.1-flash emitted `submit_plan` this way)
 * - the minimax pseudo-XML form cited in the issue: an invoke element carrying
 *   a name and parameter children,
 *     `<invoke name="...">`
 *     `<parameter name="...">value</parameter>`
 *     ... `</invoke>`.
 */
import type { AssistantMessage, Models, TextContent, ToolCall } from "@earendil-works/pi-ai";

/** The DeepSeek channel's delimiter run. */
const DSML = "｜｜DSML｜｜";
const DSML_ESCAPED = DSML.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Plain marker left in the transcript where the recovered markup stood. */
const recoveredMarker = (name: string) => `[recovered tool call: ${name}]`;

interface RecoveredCall {
  name: string;
  args: Record<string, unknown>;
  /** Index in the block's text where the serialization begins. */
  start: number;
  /** Index just past the closing token. */
  end: number;
}

/**
 * Parses a DeepSeek delimiter-markup invoke from the END of `text`: the last
 * `<｜｜DSML｜｜ invoke name="NAME">`, its `parameter` children, its
 * `</｜｜DSML｜｜ invoke>`, and then (optionally) the `calls` closing token,
 * which may also be the channel's bare final `｜｜DSML｜｜` delimiter.
 */
function parseTrailingDsmlInvoke(text: string): RecoveredCall | undefined {
  const open = lastMatch(text, new RegExp(`<${DSML_ESCAPED}\\s*invoke\\s+name="([^"\\s]+)">`));
  if (open === undefined) return undefined;
  const name = open[1];
  if (name === undefined) return undefined;
  // The `calls` opening token belongs to the recovered region.
  let start = open.index;
  const callsOpen = new RegExp(`<${DSML_ESCAPED}\\s*calls>\\s*$`).exec(text.slice(0, start));
  if (callsOpen !== null) start = callsOpen.index;
  const bodyStart = open.index + open[0].length;
  const close = new RegExp(`</${DSML_ESCAPED}\\s*invoke>`).exec(text.slice(bodyStart));
  if (close === null) return undefined;
  const body = text.slice(bodyStart, bodyStart + close.index);
  const args = parseDsmlParameters(body);
  let end = bodyStart + close.index + close[0].length;
  const restClose = new RegExp(`^\\s*(?:</${DSML_ESCAPED}\\s*calls>|${DSML_ESCAPED})`).exec(
    text.slice(end),
  );
  if (restClose !== null) end += restClose[0].length;
  return { name, args, start, end };
}

/** The `<｜｜DSML｜｜ parameter name="k" string="true">v</... parameter>` children. */
function parseDsmlParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const pattern = new RegExp(
    `<${DSML_ESCAPED}\\s*parameter\\s+name="([^"\\s]+)"(?:\\s+string="(true|false)")?>([\\s\\S]*?)</${DSML_ESCAPED}\\s*parameter>`,
    "g",
  );
  for (const match of body.matchAll(pattern)) {
    if (match[1] === undefined || match[3] === undefined) continue;
    args[match[1]] = parseParameterValue(match[3], match[2] === "true");
  }
  return args;
}

/**
 * Parses the minimax pseudo-XML form from the END of `text`: the last
 * `<invoke name="NAME">` with `<parameter name="K">V</parameter>` children up
 * to its `</invoke>`.
 */
function parseTrailingMinimaxInvoke(text: string): RecoveredCall | undefined {
  const open = lastMatch(text, /<invoke\s+name="([^"\s]+)">/);
  if (open === undefined) return undefined;
  const name = open[1];
  if (name === undefined) return undefined;
  const bodyStart = open.index + open[0].length;
  const close = /<\/invoke>/.exec(text.slice(bodyStart));
  if (close === null) return undefined;
  const body = text.slice(bodyStart, bodyStart + close.index);
  const args: Record<string, unknown> = {};
  for (const match of body.matchAll(
    /<parameter\s+name="([^"\s]+)"(?:\s+string="(true|false)")?>([\s\S]*?)<\/parameter>/g,
  )) {
    if (match[1] === undefined || match[3] === undefined) continue;
    args[match[1]] = parseParameterValue(match[3], match[2] === "true");
  }
  return { name, args, start: open.index, end: bodyStart + close.index + close[0].length };
}

/** JSON when the text parses as JSON; otherwise the raw string. */
function parseParameterValue(raw: string, forceString: boolean): unknown {
  if (!forceString) {
    try {
      return JSON.parse(raw.trim());
    } catch {
      // Not JSON: keep the raw text.
    }
  }
  return raw;
}

/** Last match of a pattern, scanning every position. */
function lastMatch(text: string, pattern: RegExp): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
    last = match as RegExpExecArray;
  }
  return last;
}

/**
 * Take an assistant message plus the tool names the request actually granted,
 * and return the message: unchanged when no gate admits recovery, otherwise
 * with a recovered, properly-shaped tool-call content block
 * (`{type:"toolCall", id, name, arguments}` with `arguments` the parsed JSON
 * object) appended and the assistant text carrying the recovered markup
 * replaced by a short plain marker.
 */
export function recoverNativeToolCalls(
  message: AssistantMessage,
  grantedToolNames: readonly string[],
): AssistantMessage {
  // Gate 1: only a lost serialization; never touch a proper tool-call message.
  if (message.content.some((block) => block.type === "toolCall")) return message;
  const granted = new Set(grantedToolNames);
  const textBlocks = message.content.filter((block): block is TextContent => block.type === "text");
  const lastTextBlock = textBlocks[textBlocks.length - 1];
  if (lastTextBlock === undefined) return message;
  const text = lastTextBlock.text;
  // Gate 3 (outer half): any later text block with substance means something
  // follows the serialization.
  if (textBlocks.slice(0, -1).some((block) => block.text.trim() !== "")) return message;
  for (const parse of [parseTrailingDsmlInvoke, parseTrailingMinimaxInvoke]) {
    const parsed = parse(text);
    if (parsed === undefined) continue;
    // Gate 2: only names the request actually granted; never guess.
    if (!granted.has(parsed.name)) continue;
    // Gate 3 (inner half): nothing after the closing token but whitespace, and
    // the serialization must reach the last non-whitespace of the text.
    if (text.slice(parsed.end).trim() !== "") continue;
    applyRecovery(message, lastTextBlock, text, parsed);
    return message;
  }
  return message;
}

/**
 * Downgrades the recovered markup region to the plain marker and appends the
 * recovered tool-call block. The message is mutated in place and returned, so
 * every holder (the agent loop resolves the stream's final result and then
 * filters `content` for tool-call blocks) sees the repaired message.
 */
function applyRecovery(
  message: AssistantMessage,
  lastTextBlock: TextContent,
  blockText: string,
  parsed: RecoveredCall,
): void {
  const marker = recoveredMarker(parsed.name);
  const replacement: TextContent = {
    ...lastTextBlock,
    text: `${blockText.slice(0, parsed.start).trimEnd()}
${marker}`,
  };
  const toolCall: ToolCall = {
    type: "toolCall",
    id: `recovered-${parsed.name}`,
    name: parsed.name,
    arguments: parsed.args,
  };
  message.content = [
    ...message.content.filter((block) => block !== lastTextBlock),
    replacement,
    toolCall,
  ];
}

/**
 * Models wrapper applied at the model boundary: each of the six generation
 * methods has its final assistant message repaired in place before the caller
 * (the agent loop) resolves it. The proxy delegates inward to whatever
 * controllers already wrapped the models, changing nothing else.
 */
export function wrapModelsForToolCallRecovery(
  models: Models,
  grantedToolNames: readonly string[],
): Models {
  const promiseMethods = new Set(["complete", "completeSimple", "fetchDeferred"]);
  const streamMethods = new Set(["stream", "streamSimple", "streamDeferred"]);
  return new Proxy(models, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function") return value;
      if (promiseMethods.has(property))
        return (...args: unknown[]) =>
          (Reflect.apply(value, target, args) as Promise<AssistantMessage>).then((message) => {
            recoverNativeToolCalls(message, grantedToolNames);
            return message;
          });
      if (streamMethods.has(property))
        return (...args: unknown[]) => {
          const stream = Reflect.apply(value, target, args) as {
            result(): Promise<AssistantMessage>;
          };
          // The observer below is not the caller: whoever awaits `result()`
          // owns the failure, and a second, unhandled rejection raised here
          // would report one provider error as two.
          void stream.result().then(
            (message) => {
              recoverNativeToolCalls(message, grantedToolNames);
            },
            () => {},
          );
          return stream;
        };
      return value.bind(target);
    },
  });
}
