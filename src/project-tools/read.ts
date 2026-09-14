import { dlopen, ptr } from "bun:ffi";
import { promises as fs, constants as fsConstants, read as fsRead, fstat } from "node:fs";
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

interface ReadProjectAccessHooks {
  afterOpenDirectory?(relativePath: string): void | Promise<void>;
  afterOpenFile?(relativePath: string): void | Promise<void>;
  afterStat?(relativePath: string): void | Promise<void>;
}

const native =
  process.platform === "linux" || process.platform === "darwin"
    ? dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
        openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
        close: { args: ["i32"], returns: "i32" },
      })
    : undefined;

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

function safeSegments(requestedPath: string): string[] {
  if (requestedPath === "" || requestedPath.includes("\0") || path.isAbsolute(requestedPath))
    throw new Error("path_outside_target");
  const segments = requestedPath.split(/[\\/]/u);
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new Error("path_outside_target");
  return segments;
}

function readFromFd(fd: number, buffer: Buffer, offset: number, length: number): Promise<number> {
  return new Promise((resolve, reject) => {
    fsRead(fd, buffer, offset, length, null, (error, bytesRead) => {
      if (error !== null) reject(error);
      else resolve(bytesRead);
    });
  });
}

function statFd(fd: number): Promise<import("node:fs").Stats> {
  return new Promise((resolve, reject) => {
    fstat(fd, (error, stat) => {
      if (error !== null) reject(error);
      else resolve(stat);
    });
  });
}

function openAt(parentFd: number, segment: string, flags: number): number {
  if (native === undefined) return -1;
  const encoded = Buffer.from(`${segment}\0`);
  return native.symbols.openat(parentFd, ptr(encoded), flags, 0);
}

async function readBoundedFile(
  root: string,
  requestedPath: string,
  maxFileBytes: number,
  hooks: ReadProjectAccessHooks,
): Promise<{ relative: string; body: string }> {
  if (native === undefined) throw new Error("unsupported_platform");
  const segments = safeSegments(requestedPath);
  const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  const fileFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const rootHandle = await fs.open(root, directoryFlags);
  let parentFd = rootHandle.fd;
  const openedDirectoryFds: number[] = [];
  let fileFd: number | undefined;
  try {
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index] as string;
      const fd = openAt(parentFd, segment, directoryFlags);
      if (fd < 0) throw new Error("path_access_failed");
      openedDirectoryFds.push(fd);
      parentFd = fd;
      await hooks.afterOpenDirectory?.(segments.slice(0, index + 1).join("/"));
    }
    fileFd = openAt(parentFd, segments.at(-1) as string, fileFlags);
    if (fileFd < 0) throw new Error("path_access_failed");
    const relative = segments.join("/");
    await hooks.afterOpenFile?.(relative);
    const stat = await statFd(fileFd);
    if (!stat.isFile()) throw new Error("path_not_file");
    if (stat.size > maxFileBytes) throw new Error("file_too_large");
    await hooks.afterStat?.(relative);

    const buffer = Buffer.allocUnsafe(maxFileBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = await readFromFd(fileFd, buffer, bytesRead, buffer.length - bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maxFileBytes) throw new Error("file_too_large");
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new Error("binary_file");
    return { relative, body: bytes.toString("utf8") };
  } finally {
    if (fileFd !== undefined) native.symbols.close(fileFd);
    for (const fd of openedDirectoryFds.reverse()) native.symbols.close(fd);
    await rootHandle.close();
  }
}

/** Read several explicit project slices through one aggregate output ceiling. */
export function buildReadProjectTool(
  targetDir: string,
  overrides: Partial<ReadProjectConfig> = {},
  hooks: ReadProjectAccessHooks = {},
): Tool {
  const config = { ...DEFAULT_READ_PROJECT_CONFIG, ...overrides };
  for (const [name, value] of Object.entries(config)) positiveInteger(name, value);
  return defineTool({
    name: READ_PROJECT_TOOL_NAME,
    description: `Read up to ${config.maxItems} exact project file slices, each at most ${config.maxLinesPerItem} lines, under one aggregate byte ceiling. Prefer this after search_project; use read only for a visible fallback when more context is required.`,
    label: "read project slices",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          path: Type.String({
            description: "Relative UTF-8 text file path inside the target project.",
          }),
          offset: Type.Optional(
            Type.Integer({
              minimum: 1,
              description: "One-based first line to return; defaults to 1.",
            }),
          ),
          limit: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: config.maxLinesPerItem,
              description: `Maximum lines to return from this file, from 1 to ${config.maxLinesPerItem}.`,
            }),
          ),
        }),
        { minItems: 1, maxItems: config.maxItems },
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
          const { relative, body } = await readBoundedFile(
            root,
            item.path,
            config.maxFileBytes,
            hooks,
          );
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
        const boundedMarker = clip(marker, config.maxOutputBytes);
        const text = truncated
          ? `${clip(unbounded, config.maxOutputBytes - Buffer.byteLength(boundedMarker))}${boundedMarker}`
          : unbounded;
        return {
          content: [{ type: "text", text }],
          details: {
            returned: sections.length,
            truncated,
            code: undefined as string | undefined,
            retryable: undefined as boolean | undefined,
            nextAction: undefined as string | undefined,
          },
        };
      } catch (error) {
        const known =
          error instanceof Error &&
          [
            "items_empty",
            "items_limit",
            "offset_invalid",
            "limit_invalid",
            "path_outside_target",
            "file_too_large",
            "binary_file",
          ].includes(error.message)
            ? error.message
            : undefined;
        const nodeCode =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code).toLowerCase()
            : undefined;
        const code =
          known ??
          (nodeCode === "enoent"
            ? "file_not_found"
            : nodeCode === "eacces" || nodeCode === "eperm"
              ? "permission_denied"
              : "filesystem_failed");
        const nextAction =
          code === "items_empty"
            ? "request at least one project file slice"
            : code === "items_limit"
              ? `retry with at most ${config.maxItems} file slices`
              : code === "offset_invalid"
                ? "use a positive one-based line offset"
                : code === "limit_invalid"
                  ? `retry with a line limit from 1 to ${config.maxLinesPerItem}`
                  : code === "path_outside_target"
                    ? "choose a relative file path inside the target project"
                    : code === "file_too_large"
                      ? "request a smaller project file"
                      : code === "binary_file"
                        ? "request a UTF-8 text project file"
                        : code === "file_not_found"
                          ? "verify the relative project file path, then retry"
                          : code === "permission_denied"
                            ? "grant read access to the requested project file, then retry"
                            : "verify the requested project file and retry";
        const details = markTrustedToolOutcome(
          {
            returned: 0,
            truncated: false,
            code,
            retryable: code === "filesystem_failed",
            nextAction,
          },
          "failed",
        );
        return {
          content: [{ type: "text", text: `project read failed: ${code}; ${nextAction}` }],
          details,
        };
      }
    },
  });
}
