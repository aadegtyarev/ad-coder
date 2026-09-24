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

/**
 * Terminal tool-transport classification (issue #635).
 *
 * Recovery above repairs only the exact serialization it can prove safe to
 * execute. When it declines -- a shape it does not accept (the captured
 * `tool_calls` outer delimiters), an ungranted name, anything at all after the
 * closing token -- a message whose text still ENDS in a well-formed tool-call
 * envelope must not cross the shared message boundary as prose success: the
 * turn settles, stage closeout relays it, and the pseudo call is preserved as
 * a plausible-looking result text. The classifier below fails that closed,
 * at the outcome boundary, without parsing or executing arguments.
 *
 * Structural, provider-neutral, narrowly allow-listed: the trailing region of
 * the text must parse ENTIRELY (no stray prose, no unbalanced or mid-text
 * markup) as the same two serialization grammars recovery reads, ending in a
 * closing tag. Prose discussion or XML examples that merely CONTAIN the
 * tokens, or end in something other than a closed envelope, classify as
 * ordinary text. A message that already carries a structured tool-call block
 * is never reclassified (rule 1 of the boundary).
 */

/** How far back a terminal envelope is searched for: further back only buys prose false matches. */
const TRANSPORT_SCAN_LIMIT = 20_000;

type ToolProtoKind = "calls" | "invoke" | "parameter";

interface ToolProtoTag {
  open: boolean;
  kind: ToolProtoKind;
  /** Index just past the tag. */
  end: number;
}

/** The bare channel delimiter opens a region only when no calls region is open. */
function bareDelimiterTag(
  text: string,
  index: number,
  stack: readonly ToolProtoKind[],
  seenCallsOpen: boolean,
): ToolProtoTag | undefined {
  if (!text.startsWith(DSML, index) || text.charAt(index - 1) === "<") return undefined;
  const open = !seenCallsOpen && !stack.includes("calls");
  return { open, kind: "calls", end: index + DSML.length };
}

/** An allow-listed `<...>` tool-protocol tag at `index`, opens well-attributed, closes bare. */
function bracketedToolProtoTag(text: string, index: number): ToolProtoTag | undefined {
  const match = new RegExp(
    `^<(/?)\\s*(?:${DSML_ESCAPED}\\s*)?(tool_calls|calls|invoke|parameter)((?:\\s+[^<>]*?)?)>`,
  ).exec(text.slice(index, index + 512));
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  const close = match[1] !== "";
  const kind = match[2] as ToolProtoKind;
  const attributes = match[3] ?? "";
  if (close)
    return attributes.trim() === ""
      ? { open: false, kind, end: index + match[0].length }
      : undefined;
  if (kind === "calls" && attributes.trim() !== "") return undefined;
  if (
    (kind === "invoke" || kind === "parameter") &&
    !/^\s*name="[^"\s]+"(?:\s+string="(?:true|false)")?$/.test(attributes)
  )
    return undefined;
  return { open: true, kind, end: index + match[0].length };
}

/**
 * Whether `source` from `start` to its end parses as a balanced terminal
 * tool-call envelope: tags nest properly, at least one invoke element closes,
 * and the last non-whitespace is a close tag -- the terminal framing is a
 * tool-call serialization, not trailing prose.
 */
function parsesTerminalToolEnvelope(source: string, start: number): boolean {
  const stack: ToolProtoKind[] = [];
  let sawInvoke = false;
  let seenCallsOpen = false;
  let i = start;
  for (;;) {
    while (i < source.length && /\s/.test(source.charAt(i))) i++;
    if (i >= source.length) return sawInvoke && stack.length === 0;
    const tag =
      bracketedToolProtoTag(source, i) ?? bareDelimiterTag(source, i, stack, seenCallsOpen);
    if (tag !== undefined) {
      if (tag.open) {
        if (tag.kind === "invoke") sawInvoke = true;
        if (tag.kind === "calls") seenCallsOpen = true;
        stack.push(tag.kind);
      } else if (stack.pop() !== tag.kind) {
        return false;
      }
      i = tag.end;
      continue;
    }
    // Free text is structural only between a parameter's tags: the argument
    // VALUE is consumed, never parsed and never reflected into any projection.
    if (stack[stack.length - 1] === "parameter") {
      const next = source.indexOf("<", i);
      if (next === -1) return false;
      i = next;
      continue;
    }
    return false;
  }
}

/**
 * Whether `text` ends in terminal tool-protocol framing (issue #635). Text is
 * not typed: callers at the durable boundary read assistant text that has
 * already left the model shape, and a non-string simply carries no framing.
 */
export function textHasUnrecoveredToolTransport(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;
  const source =
    trimmed.length > TRANSPORT_SCAN_LIMIT ? trimmed.slice(-TRANSPORT_SCAN_LIMIT) : trimmed;
  const opens = new RegExp(`<(?:${DSML_ESCAPED}\\s*)?(?:tool_calls|calls|invoke)(?=>|\\s)`, "g");
  for (const match of source.matchAll(opens)) {
    if (parsesTerminalToolEnvelope(source, match.index)) return true;
  }
  let at = 0;
  for (;;) {
    const index = source.indexOf(DSML, at);
    if (index === -1) break;
    if (source.charAt(index - 1) !== "<" && parsesTerminalToolEnvelope(source, index)) return true;
    at = index + DSML.length;
  }
  return false;
}

/**
 * Message-level classification for the settled-assistant boundary, structural
 * enough to accept both a pi-ai `AssistantMessage` and the durable
 * `SettledTurnMessage` projection (field access is guarded, never trusted).
 */
export function detectUnrecoveredToolTransport(message: unknown): boolean {
  const content =
    message !== null && typeof message === "object" && "content" in message
      ? (message as { content: unknown }).content
      : undefined;
  if (!Array.isArray(content)) return false;
  let lastText: string | undefined;
  for (const block of content) {
    if (block === null || typeof block !== "object" || !("type" in block)) continue;
    const type = (block as { type: unknown }).type;
    // Rule 1: a structured tool-call block wins; recovery proved this turn.
    if (type === "toolCall") return false;
    if (type === "text" && typeof (block as { text: unknown }).text === "string")
      lastText = (block as { text: string }).text;
  }
  return lastText !== undefined && textHasUnrecoveredToolTransport(lastText);
}
