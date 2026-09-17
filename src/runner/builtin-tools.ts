/**
 * The built-in tool set with its boundaries attached and its failure
 * diagnostics, in one narrow seam.
 *
 * WHY THIS MODULE EXISTS (issue #231). Two behaviors measured across real
 * orchestrator sessions, both traced to the built-in tool surface rather than
 * to the model:
 *
 * 1. `bash` reached the model as the tool with no stated limits, so it read as
 *    the tool without limits -- `sed -n` became the reader and `sed -i` the
 *    editor. A boundary description is attached to the built-in object here:
 *    the name must be attached, not wrapped, because a custom tool named
 *    `bash` collides with the built-in (`tool_name_collision`).
 *
 * 2. 16 of 96 edit-tool calls failed on real work (17%), and after a failure
 *    the model usually fell back to `sed -i`, which hides the edit from the
 *    operator. The fallback was rational self-service: the not-found error
 *    says the text must match exactly but not WHERE the file's equivalent
 *    region is, so a full re-read was the visible cost. The wrapper below
 *    turns a not-found or non-unique failure into actionable evidence INSIDE
 *    the failing call: line numbers, the closest matching region, and one
 *    advice sentence pointing back to `read` + `edit`. It never prints
 *    recovered file content -- the errors contract forbids file contents in
 *    errors, and line numbers are the actionable part.
 */
import {
  type AgentHarnessTool,
  TODO_CONTEXT as CONTEXT,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ExecutionEnv,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";

/** `bash` boundary text, attached to the built-in tool (its name stays `bash`). */
export const BASH_TOOL_DESCRIPTION = `Run a shell command, starting in the target directory. bash runs with the user's FULL authority: it can cd anywhere, read and write anything the user can, and follow any tool that takes a path -- --target-dir bounds only this project's file tools, not bash (docs/contracts/security.md). The escape hatch for what no specialised tool covers: builds, installs, git history and state, processes, status checks, npx/bun tasks. NOT a general-purpose interface: read files with read (offset/limit for extents), create files only with write, EDIT FILES ONLY WITH EDIT -- a sed -i edit moves no line counts, files no diff, and bypasses the tool's failure diagnostics -- and search project content with search_project when active. If edit fails, retry with edit first: its failure output names the file region to re-read; reach for sed only when edit cannot express the change at all.`;

/** One candidate region the locator reports for a failed not-found edit. */
export interface EditDiagnosticRegion {
  /** One-based line number in the file where the best-matching window starts. */
  line: number;
  /** 0..1 Jaccard similarity between the file window and the edit text. */
  similarity: number;
  /** `close` -- a whitespace-neighborhood mismatch; `far` -- the text is absent. */
  verdict: "close" | "far";
}

/**
 * Largest file the edit diagnostics read before they give up on evidence and
 * pass the upstream error through unchanged. A positive DoS ceiling, like
 * every capture that can enter a tool result.
 */
export const DEFAULT_EDIT_DIAGNOSTIC_MAX_BYTES = 2 * 1024 * 1024;

/** Occurrence line numbers reported at most for a non-unique oldText. */
export const MAX_REPORTED_OCCURRENCES = 10;

/** Where the not-found locator switches from "you are near" to "you are stale". */
const CLOSE_SIMILARITY = 0.3;

const TOKEN_PATTERN = /[a-z0-9_]+/g;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_PATTERN) ?? [];
}

function jaccard(query: Set<string>, window: Set<string>): number {
  if (query.size === 0 || window.size === 0) return 0;
  let shared = 0;
  for (const token of query) if (window.has(token)) shared += 1;
  return shared / (query.size + window.size - shared);
}

const normalizeToLF = (text: string): string => text.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");

/**
 * Locate the region of `content` most similar to `oldText`, so recovery advice
 * names where to re-read instead of "somewhere in the file".
 *
 * Pure and deterministic. Slides a window whose line count equals the edit's
 * own over the LF-normalized content, scoring bag-of-token Jaccard similarity.
 * `close` means a nearby-but-mismatched region exists (indented differently,
 * stale by a few lines); `far` means even the best window shares too little,
 * which is the signal that the expected text is simply absent -- the model
 * must re-read the file rather than hunt whitespace. A window longer than the
 * file or a token-free edit yields a far match at line 1.
 */
export function locateNearestEditRegion(content: string, oldText: string): EditDiagnosticRegion {
  const lines = normalizeToLF(content).split("\n");
  const editLines = normalizeToLF(oldText)
    .replace(/[\n $.]+$/, "")
    .split("\n");
  const queryTokens = new Set(tokenize(normalizeToLF(oldText)));
  let best: EditDiagnosticRegion = { line: 1, similarity: 0, verdict: "far" };
  for (let start = 0; start + editLines.length <= lines.length; start += 1) {
    const windowTokens = new Set(tokenize(lines.slice(start, start + editLines.length).join(" ")));
    const similarity = jaccard(queryTokens, windowTokens);
    if (similarity > best.similarity) {
      best = { line: start + 1, similarity, verdict: "close" };
    }
  }
  if (best.similarity < CLOSE_SIMILARITY) return { ...best, verdict: "far" };
  return best;
}

/**
 * Line numbers (one-based, bounded) of every occurrence of `needle` in an
 * LF-normalized file text. Bounded so a runaway oldText of repeating text
 * cannot flood the next model turn.
 */
export function locateEditOccurrences(
  content: string,
  needle: string,
  max = MAX_REPORTED_OCCURRENCES,
): number[] {
  if (needle.length === 0 || max <= 0) return [];
  const normalized = normalizeToLF(content);
  const found: number[] = [];
  for (let index = normalized.indexOf(needle); index !== -1 && found.length < max; ) {
    found.push(1 + normalized.slice(0, index).split("\n").length - 1);
    index = normalized.indexOf(needle, index + Math.max(1, needle.length));
  }
  return found;
}

function formatRecoveryAdvice(
  verdict: EditDiagnosticRegion["verdict"],
  region: EditDiagnosticRegion,
): string {
  if (verdict === "close") {
    return (
      `Recovery: the closest matching region starts at line ${region.line} (similarity ` +
      `${region.similarity.toFixed(2)}) -- the file differs slightly from what you assumed. ` +
      `Read the file around that line and rebuild oldText from what it actually contains, then retry the edit.`
    );
  }
  return (
    `Recovery: no close match exists anywhere in the file (best similarity ` +
    `${region.similarity.toFixed(2)}) -- your oldText is stale, not miswhitespaced. ` +
    `Read the file around where you expected the text and rebuild oldText from what it contains, then retry the edit.`
  );
}

function formatOccurrenceAdvice(lineNumbers: number[]): string {
  return (
    `Recovery: Exactly matching text may be found at line(s) ${lineNumbers.join(", ")}. ` +
    `Rebuild oldText so it is unique -- include one or two of the surrounding lines shown as context anchors -- then retry the edit.`
  );
}

/**
 * Build one recovery sentence for an edit-tool failure message. Pure over its
 * inputs; unclassified messages return unchanged. NEVER includes file content.
 */
export function enrichEditErrorMessage(message: string, fileText: string, oldText: string): string {
  const normalizedNeedle = normalizeToLF(oldText);
  if (message.includes("Could not find")) {
    const region = locateNearestEditRegion(fileText, oldText);
    return `${message}\n${formatRecoveryAdvice(region.verdict, region)}`;
  }
  if (message.includes("Found") && message.includes("occurrence")) {
    const lineNumbers = locateEditOccurrences(fileText, normalizedNeedle);
    if (lineNumbers.length > 0) {
      return `${message}\n${formatOccurrenceAdvice(lineNumbers)}`;
    }
  }
  return message;
}

/**
 * Enrich a failed `edit` call with recovery evidence resolved from the file
 * (issue #231, thread 2): where the intended text actually sits, so the same
 * call tells the model how to succeed rather than pushing it toward `sed -i`.
 *
 * Resolve the called path against the runner's target root, read it once,
 * bound the read, and never report recovered content -- only line numbers and
 * similarity. Diagnostics skipped on: unreachable or unresolvable paths, files
 * over the byte ceiling, or an unrecognised failure message. Errors during the
 * DIAGNOSIS never replace the real edit failure.
 */
async function readDiagnosticFile(
  env: ExecutionEnv,
  path: string | undefined,
  context: Parameters<ExecutionEnv["readTextFile"]>[1],
  maxBytes: number,
): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    const resolved = await env.absolutePath(path, context);
    if (!resolved.ok) return undefined;
    const read = await env.readTextFile(resolved.value, context);
    if (!read.ok) return undefined;
    const fileText = read.value;
    if (fileText.length > maxBytes) return undefined;
    return fileText;
  } catch {
    return undefined;
  }
}

export interface EditDiagnosticsOptions {
  /** Positive read ceiling for recovery-file reads. */
  maxDiagnosticBytes?: number;
}

/**
 * Wrap the built-in `edit` tool with failure diagnostics. Identical OBJECT
 * identity semantics downstream: same `name`, `description`, parameters, and
 * `prepareArguments`; failures that pi reports are passed through unchanged
 * unless diagnostics add line-of-recovery evidence.
 */
export function wrapEditToolWithDiagnostics(
  edit: AgentHarnessTool<ExecutionToolContext>,
  env: ExecutionEnv,
  options: EditDiagnosticsOptions = {},
): AgentHarnessTool<ExecutionToolContext> {
  const maxBytes = options.maxDiagnosticBytes ?? DEFAULT_EDIT_DIAGNOSTIC_MAX_BYTES;
  return {
    ...edit,
    async execute(toolCallId, input, onUpdate, toolContext, invocation, context) {
      try {
        return await edit.execute(toolCallId, input, onUpdate, toolContext, invocation, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          !message.includes("Could not find") &&
          !(message.includes("Found") && message.includes("occurrence"))
        ) {
          throw error;
        }
        const source = input as { path?: unknown; edits?: { oldText?: unknown }[] };
        const path = typeof source?.path === "string" && source.path ? source.path : undefined;
        const edits = Array.isArray(source?.edits) ? (source.edits as { oldText?: unknown }[]) : [];
        const editIndexResult = /\bedits\[(\d+)\]/.exec(message);
        const editIndex = editIndexResult ? Number(editIndexResult[1]) : 0;
        const rawOldText = edits[editIndex]?.oldText;
        const oldText = typeof rawOldText === "string" ? rawOldText : undefined;
        if (message.includes("Could not find") && (path === undefined || oldText === undefined)) {
          throw error;
        }
        if (oldText === undefined) throw error;
        const fileText = await readDiagnosticFile(
          env,
          path,
          (context ?? CONTEXT) as Parameters<ExecutionEnv["readTextFile"]>[1],
          maxBytes,
        );
        // A file we cannot read for evidence yields the UNENRICHED upstream
        // failure: advice invented without evidence would misdirect the retry.
        if (fileText === undefined) throw error;
        const enriched = enrichEditErrorMessage(message, fileText, oldText);
        if (enriched === message) throw error;
        throw new Error(enriched, { cause: error });
      }
    },
  };
}

/**
 * The four built-in tools with their boundaries attached: `bash` gets the
 * boundary description above (attached, not wrapped -- the name must survive
 * for `tool_name_collision`), `read` and `write` keep their upstream
 * descriptions, and `edit` is wrapped with failure diagnostics.
 */
export function createBuiltinTools(
  env: ExecutionEnv,
  options: EditDiagnosticsOptions = {},
): readonly AgentHarnessTool<ExecutionToolContext>[] {
  return Object.freeze([
    { ...createBashTool(), description: BASH_TOOL_DESCRIPTION },
    createReadTool(),
    createWriteTool(),
    wrapEditToolWithDiagnostics(createEditTool(), env, options),
  ]);
}
