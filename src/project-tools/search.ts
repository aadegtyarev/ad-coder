import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { markTrustedToolOutcome } from "../observability/tool-activity";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";

export const SEARCH_PROJECT_TOOL_NAME = "search_project";

export interface SearchProjectConfig {
  maxTerms: number;
  maxTermBytes: number;
  maxMatches: number;
  maxExcerptBytes: number;
  maxOutputBytes: number;
  maxGitOutputBytes: number;
}

export const DEFAULT_SEARCH_PROJECT_CONFIG: Readonly<SearchProjectConfig> = Object.freeze({
  maxTerms: 8,
  maxTermBytes: 120,
  maxMatches: 40,
  maxExcerptBytes: 240,
  maxOutputBytes: 12_000,
  maxGitOutputBytes: 2_000_000,
});

const execFileAsync = promisify(execFile);

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`search project config ${name} must be a positive integer`);
}

function clipBytes(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

/** Build a bounded literal search projection for task reconnaissance. */
export function buildSearchProjectTool(
  targetDir: string,
  overrides: Partial<SearchProjectConfig> = {},
): Tool {
  const config = { ...DEFAULT_SEARCH_PROJECT_CONFIG, ...overrides };
  for (const [name, value] of Object.entries(config)) positiveInteger(name, value);

  return defineTool({
    name: SEARCH_PROJECT_TOOL_NAME,
    description:
      "Search tracked project text for task symbols or exact phrases. Returns a ranked, byte-bounded path:line projection; use read only when surrounding context is still needed.",
    label: "search project",
    parameters: Type.Object({ terms: Type.Array(Type.String()) }),
    async execute(_toolCallId, params) {
      try {
        const root = await fs.realpath(targetDir);
        const terms = [...new Set(params.terms.map((term) => term.trim()).filter(Boolean))];
        if (terms.length === 0) throw new Error("terms_empty");
        if (terms.length > config.maxTerms) throw new Error("terms_limit");
        if (terms.some((term) => Buffer.byteLength(term) > config.maxTermBytes))
          throw new Error("term_too_long");
        const args = ["-C", root, "grep", "-n", "-I", "--full-name", "--untracked"];
        for (const term of terms) args.push("-e", term);
        args.push("--", ".");
        let stdout = "";
        try {
          ({ stdout } = await execFileAsync("git", args, {
            encoding: "utf8",
            maxBuffer: config.maxGitOutputBytes,
          }));
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === 1)
            stdout = "";
          else throw error;
        }
        const rows = stdout.split("\n").filter(Boolean);
        const byFile = new Map<string, number>();
        for (const row of rows) {
          const separator = row.indexOf(":");
          if (separator > 0) {
            const file = row.slice(0, separator);
            byFile.set(file, (byFile.get(file) ?? 0) + 1);
          }
        }
        const rank = new Map(
          [...byFile]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([file], index) => [file, index]),
        );
        const matches = rows
          .sort((a, b) => {
            const af = a.slice(0, a.indexOf(":"));
            const bf = b.slice(0, b.indexOf(":"));
            return (rank.get(af) ?? 0) - (rank.get(bf) ?? 0) || a.localeCompare(b);
          })
          .slice(0, config.maxMatches)
          .map((row) => clipBytes(row, config.maxExcerptBytes));
        const header = `terms: ${terms.join(", ")}\nmatches: ${rows.length}${rows.length > matches.length ? ` (showing ${matches.length})` : ""}\n`;
        const unbounded = `${header}${matches.join("\n") || "none"}`;
        const text = clipBytes(unbounded, config.maxOutputBytes);
        return {
          content: [{ type: "text", text }],
          details: {
            matches: rows.length,
            returned: matches.length,
            truncated: Buffer.byteLength(text) < Buffer.byteLength(unbounded),
          },
        };
      } catch (error) {
        const code =
          error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "failed";
        return {
          content: [{ type: "text", text: `project search failed: ${code}` }],
          details: markTrustedToolOutcome({}, "failed"),
        };
      }
    },
  });
}
