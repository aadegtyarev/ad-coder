import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { markTrustedToolOutcome } from "../observability/tool-activity";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";

export const READ_PROJECT_TOOL_NAME = "read_project";

export interface ReadProjectConfig {
  maxItems: number;
  maxLinesPerItem: number;
  maxFileBytes: number;
  maxOutputBytes: number;
}

export const DEFAULT_READ_PROJECT_CONFIG: Readonly<ReadProjectConfig> = Object.freeze({
  maxItems: 8,
  maxLinesPerItem: 160,
  maxFileBytes: 1_000_000,
  maxOutputBytes: 16_000,
});

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`read project config ${name} must be a positive integer`);
}

function clip(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

/** Read several explicit project slices through one aggregate output ceiling. */
export function buildReadProjectTool(
  targetDir: string,
  overrides: Partial<ReadProjectConfig> = {},
): Tool {
  const config = { ...DEFAULT_READ_PROJECT_CONFIG, ...overrides };
  for (const [name, value] of Object.entries(config)) positiveInteger(name, value);
  return defineTool({
    name: READ_PROJECT_TOOL_NAME,
    description:
      "Read up to eight exact project file slices in one call under one aggregate byte ceiling. Prefer this after search_project; use read only for a visible fallback when more context is required.",
    label: "read project slices",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          path: Type.String(),
          offset: Type.Optional(Type.Integer()),
          limit: Type.Optional(Type.Integer()),
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        if (params.items.length === 0) throw new Error("items_empty");
        if (params.items.length > config.maxItems) throw new Error("items_limit");
        const root = await fs.realpath(targetDir);
        const sections: string[] = [];
        for (const item of params.items) {
          const offset = item.offset ?? 1;
          const limit = item.limit ?? config.maxLinesPerItem;
          if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("offset_invalid");
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.maxLinesPerItem)
            throw new Error("limit_invalid");
          const requested = path.resolve(root, item.path);
          const absolute = await fs.realpath(requested);
          const relative = path.relative(root, absolute);
          if (relative.startsWith("..") || path.isAbsolute(relative))
            throw new Error("path_outside_target");
          const stat = await fs.stat(absolute);
          if (!stat.isFile()) throw new Error("path_not_file");
          if (stat.size > config.maxFileBytes) throw new Error("file_too_large");
          const body = await fs.readFile(absolute, "utf8");
          if (body.includes("\0")) throw new Error("binary_file");
          const lines = body.split("\n");
          const selected = lines.slice(offset - 1, offset - 1 + limit);
          const numbered = selected.map((line, index) => `${offset + index}: ${line}`).join("\n");
          sections.push(
            `## ${relative}:${offset}-${offset + Math.max(0, selected.length - 1)}\n${numbered}`,
          );
        }
        const unbounded = sections.join("\n\n");
        const marker = "\n\n[read_project output truncated; narrow the requested slices]";
        const truncated = Buffer.byteLength(unbounded) > config.maxOutputBytes;
        const text = truncated
          ? `${clip(unbounded, Math.max(1, config.maxOutputBytes - Buffer.byteLength(marker)))}${marker}`
          : unbounded;
        return {
          content: [{ type: "text", text }],
          details: { returned: sections.length, truncated },
        };
      } catch (error) {
        const code =
          error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "failed";
        return {
          content: [{ type: "text", text: `project read failed: ${code}` }],
          details: markTrustedToolOutcome({}, "failed"),
        };
      }
    },
  });
}
