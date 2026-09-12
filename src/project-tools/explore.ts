import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { markTrustedToolOutcome } from "../observability/tool-activity";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";

export const EXPLORE_PROJECT_TOOL_NAME = "explore_project";

export interface ExploreProjectConfig {
  maxFiles: number;
  maxDepth: number;
  maxReportedFiles: number;
  codeLineWarning: number;
  /** Used only outside a Git worktree; Git projects use standard Git excludes. */
  fallbackExcludedDirectories: string[];
  maxGitOutputBytes: number;
  maxTextFileBytes: number;
}

export const DEFAULT_EXPLORE_PROJECT_CONFIG: Readonly<ExploreProjectConfig> = Object.freeze({
  maxFiles: 10_000,
  maxDepth: 12,
  maxReportedFiles: 20,
  codeLineWarning: 500,
  fallbackExcludedDirectories: [".git", ".ad-coder", "node_modules", "dist", "build", "coverage"],
  maxGitOutputBytes: 10_000_000,
  maxTextFileBytes: 2_000_000,
});

const execFileAsync = promisify(execFile);

interface FileMetric {
  path: string;
  bytes: number;
  lines?: number;
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`explore project config ${name} must be a positive integer`);
}

/** Build a bounded, read-only reconnaissance tool for humans, planners, and auditors. */
export function buildExploreProjectTool(
  targetDir: string,
  overrides: Partial<ExploreProjectConfig> = {},
): Tool {
  const config = { ...DEFAULT_EXPLORE_PROJECT_CONFIG, ...overrides };
  positiveInteger("maxFiles", config.maxFiles);
  positiveInteger("maxDepth", config.maxDepth);
  positiveInteger("maxReportedFiles", config.maxReportedFiles);
  positiveInteger("codeLineWarning", config.codeLineWarning);
  positiveInteger("maxGitOutputBytes", config.maxGitOutputBytes);
  positiveInteger("maxTextFileBytes", config.maxTextFileBytes);
  const fallbackExcluded = new Set(config.fallbackExcludedDirectories);

  return defineTool({
    name: EXPLORE_PROJECT_TOOL_NAME,
    description:
      "Read-only bounded project reconnaissance: structure, language mix, large modules, and code-size decomposition signals. Returns metadata, never file contents.",
    label: "explore project",
    parameters: Type.Object({ focus: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      try {
        const root = await fs.realpath(targetDir);
        const requested = path.resolve(root, params.focus?.trim() || ".");
        const start = await fs.realpath(requested);
        const relativeStart = path.relative(root, start);
        if (relativeStart.startsWith("..") || path.isAbsolute(relativeStart))
          throw new Error("focus_outside_target");
        if (!(await fs.stat(start)).isDirectory()) throw new Error("focus_not_directory");

        const files: FileMetric[] = [];
        const extensions = new Map<string, number>();
        const directories = new Map<string, number>();
        let truncated = false;
        const visit = async (directory: string, depth: number): Promise<void> => {
          if (depth > config.maxDepth || truncated) return;
          const entries = await fs.readdir(directory, { withFileTypes: true });
          entries.sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const absolute = path.join(directory, entry.name);
            const relative = path.relative(root, absolute).split(path.sep).join("/");
            if (entry.isDirectory()) {
              if (!fallbackExcluded.has(entry.name)) await visit(absolute, depth + 1);
              continue;
            }
            if (!entry.isFile()) continue;
            if (files.length >= config.maxFiles) {
              truncated = true;
              break;
            }
            const stat = await fs.stat(absolute);
            const extension = path.extname(entry.name).toLowerCase() || "[none]";
            extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
            const top = relative.split("/", 1)[0] ?? ".";
            directories.set(top, (directories.get(top) ?? 0) + 1);
            const metric: FileMetric = { path: relative, bytes: stat.size };
            if (
              /\.(?:[cm]?[jt]sx?|css|md|json|ya?ml)$/i.test(entry.name) &&
              stat.size <= config.maxTextFileBytes
            ) {
              const body = await fs.readFile(absolute, "utf8");
              metric.lines = body === "" ? 0 : body.split("\n").length;
            }
            files.push(metric);
          }
        };
        let discovery: "git-excludes" | "filesystem-fallback" = "git-excludes";
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            { encoding: "buffer", maxBuffer: config.maxGitOutputBytes },
          );
          const candidates = stdout
            .toString("utf8")
            .split("\0")
            .filter(Boolean)
            .filter((candidate) => {
              const relative = path.relative(relativeStart || ".", candidate);
              const directoryDepth = relative.split(path.sep).length - 1;
              return (
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relative) &&
                directoryDepth <= config.maxDepth
              );
            });
          for (const candidate of candidates) {
            if (files.length >= config.maxFiles) {
              truncated = true;
              break;
            }
            const absolute = path.join(root, candidate);
            const stat = await fs.stat(absolute).catch(() => undefined);
            if (stat === undefined || !stat.isFile()) continue;
            const extension = path.extname(candidate).toLowerCase() || "[none]";
            extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
            const top = candidate.split("/", 1)[0] ?? ".";
            directories.set(top, (directories.get(top) ?? 0) + 1);
            const metric: FileMetric = { path: candidate, bytes: stat.size };
            if (
              /\.(?:[cm]?[jt]sx?|css|md|json|ya?ml)$/i.test(candidate) &&
              stat.size <= config.maxTextFileBytes
            ) {
              const body = await fs.readFile(absolute, "utf8");
              metric.lines = body === "" ? 0 : body.split("\n").length;
            }
            files.push(metric);
          }
        } catch (error) {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
          if (!stderr.includes("not a git repository")) throw error;
          discovery = "filesystem-fallback";
          await visit(start, 0);
        }

        const limit = config.maxReportedFiles;
        const largest = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
        const decomposition = files
          .filter(({ lines }) => lines !== undefined && lines >= config.codeLineWarning)
          .sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))
          .slice(0, limit);
        const ranked = (entries: Array<[string, number]>) =>
          entries
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, count]) => `${name}: ${count}`)
            .join(", ");
        const fileLine = ({ path: file, bytes, lines }: FileMetric) =>
          `${file} — ${bytes} bytes${lines === undefined ? "" : `, ${lines} lines`}`;
        return {
          content: [
            {
              type: "text",
              text: [
                `focus: ${relativeStart || "."}`,
                `discovery: ${discovery}`,
                `files scanned: ${files.length}${truncated ? ` (truncated at ${config.maxFiles})` : ""}`,
                `top-level areas: ${ranked([...directories]) || "none"}`,
                `file types: ${ranked([...extensions]) || "none"}`,
                `largest files:\n${largest.map(fileLine).join("\n") || "none"}`,
                `decomposition signals (>= ${config.codeLineWarning} lines):\n${decomposition.map(fileLine).join("\n") || "none"}`,
                "These size signals are reconnaissance, not a refactoring verdict; inspect cohesion, churn, and tests before acting.",
              ].join("\n\n"),
            },
          ],
          details: { filesScanned: files.length, truncated },
        };
      } catch (error) {
        const code =
          error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "failed";
        return {
          content: [{ type: "text", text: `project exploration failed: ${code}` }],
          details: markTrustedToolOutcome({}, "failed"),
        };
      }
    },
  });
}
