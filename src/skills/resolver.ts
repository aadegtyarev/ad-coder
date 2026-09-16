import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const ROLES = new Set([
  "orchestrator",
  "planner",
  "researcher",
  "security",
  "coder",
  "reviewer",
  "auditor",
]);
const DEFAULT_MAX_INSTRUCTION_BYTES = 16_384;
const DEFAULT_MAX_MANIFEST_BYTES = 4_096;
const DEFAULT_MAX_REQUESTED_SKILLS = 16;
const BUILTIN_DIR = path.join(import.meta.dir, "..", "..", "prompts", "skills");

export interface SkillManifest {
  id: string;
  version: string;
  description: string;
  roles: string[];
}
export interface ResolvedSkill extends SkillManifest {
  source: "builtin" | "project";
  sha256: string;
  instructions: string;
}
export interface ResolveSkillsOptions {
  projectDir?: string;
  builtinDir?: string;
  maxInstructionBytes?: number;
  maxManifestBytes?: number;
  maxRequestedSkills?: number;
}

export type SkillResolutionErrorCode = "missing" | "malformed" | "escaping" | "oversized";

/** A stable, content-free failure for a requested trusted skill. */
export class SkillResolutionError extends Error {
  readonly nextAction: string;

  constructor(readonly code: SkillResolutionErrorCode) {
    const nextAction: Record<SkillResolutionErrorCode, string> = {
      missing: "choose an installed skill ID or remove it from --skills",
      malformed: "fix the selected skill manifest or requested skill IDs",
      escaping: "replace symlinks with files inside the configured skill directory",
      oversized: "reduce the selected skill manifest or instructions",
    };
    super(`skill resolution failed: ${code}; ${nextAction[code]}`);
    this.nextAction = nextAction[code];
    this.name = "SkillResolutionError";
  }
}

function fail(code: SkillResolutionErrorCode): never {
  throw new SkillResolutionError(code);
}

const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;

function descriptorRoot(): string {
  return fs.existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
}

function descriptorPath(directoryFd: number, name: string): string {
  return path.join(descriptorRoot(), String(directoryFd), name);
}

function resolutionError(error: unknown): never {
  if (error instanceof SkillResolutionError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") fail("missing");
  if (["ELOOP", "ENOTDIR"].includes(code ?? "")) fail("escaping");
  if (["EACCES", "EINVAL", "EISDIR", "EPERM", "ENAMETOOLONG"].includes(code ?? ""))
    fail("malformed");
  fail("malformed");
}

function openDescendantDirectory(directoryFd: number, name: string): number {
  try {
    return fs.openSync(descriptorPath(directoryFd, name), DIRECTORY_FLAGS);
  } catch (error) {
    return resolutionError(error);
  }
}

/** Walk from the filesystem root so no project-root pathname is reopened after anchoring. */
function openTrustedDirectory(directory: string): number {
  const absoluteDirectory = path.resolve(directory);
  const parsed = path.parse(absoluteDirectory);
  let directoryFd: number | undefined;
  try {
    directoryFd = fs.openSync(parsed.root, DIRECTORY_FLAGS);
    const relativeDirectory = absoluteDirectory.slice(parsed.root.length);
    for (const component of relativeDirectory.split(path.sep).filter(Boolean)) {
      const childFd = openDescendantDirectory(directoryFd, component);
      fs.closeSync(directoryFd);
      directoryFd = childFd;
    }
    return directoryFd;
  } catch (error) {
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
    return resolutionError(error);
  }
}

function readDescriptorPinnedFile(directoryFd: number, filename: string, maxBytes: number): Buffer {
  let fileFd: number | undefined;
  try {
    fileFd = fs.openSync(descriptorPath(directoryFd, filename), FILE_FLAGS);
    const stat = fs.fstatSync(fileFd);
    if (!stat.isFile()) fail("malformed");
    if (stat.size > maxBytes) fail("oversized");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fileFd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    // A pinned file can still be modified in place; do not accept content beyond its ceiling.
    if (fs.readSync(fileFd, Buffer.alloc(1), 0, 1, null) !== 0) fail("oversized");
    return bytes.subarray(0, offset);
  } catch (error) {
    return resolutionError(error);
  } finally {
    if (fileFd !== undefined) fs.closeSync(fileFd);
  }
}

function readSkill(
  root: string,
  id: string,
  source: "builtin" | "project",
  maxInstructionBytes: number,
  maxManifestBytes: number,
): ResolvedSkill | undefined {
  let rootFd: number;
  try {
    rootFd = openTrustedDirectory(root);
  } catch (error) {
    if (error instanceof SkillResolutionError && error.code === "missing") return undefined;
    throw error;
  }
  let directoryFd: number;
  try {
    directoryFd = openDescendantDirectory(rootFd, id);
  } catch (error) {
    fs.closeSync(rootFd);
    if (error instanceof SkillResolutionError && error.code === "missing") return undefined;
    throw error;
  }
  let manifestBytes: Buffer;
  let instructionBytes: Buffer;
  try {
    manifestBytes = readDescriptorPinnedFile(directoryFd, "skill.json", maxManifestBytes);
    try {
      JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      fail("malformed");
    }
    instructionBytes = readDescriptorPinnedFile(
      directoryFd,
      "instructions.md",
      maxInstructionBytes,
    );
  } finally {
    fs.closeSync(directoryFd);
    fs.closeSync(rootFd);
  }
  let raw: unknown;
  const manifestText = manifestBytes.toString("utf8");
  const instructions = instructionBytes.toString("utf8");
  try {
    raw = JSON.parse(manifestText);
  } catch {
    fail("malformed");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("malformed");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["id", "version", "description", "roles"].includes(key)))
    fail("malformed");
  if (value.id !== id || !ID.test(id)) fail("escaping");
  if (
    typeof value.version !== "string" ||
    value.version === "" ||
    typeof value.description !== "string" ||
    value.description === "" ||
    !Array.isArray(value.roles) ||
    value.roles.length === 0 ||
    value.roles.some((role) => typeof role !== "string" || !ROLES.has(role))
  )
    fail("malformed");
  if (Buffer.byteLength(instructions) === 0) fail("malformed");
  const digest = createHash("sha256");
  for (const [tag, bytes] of [
    [1, Buffer.from(source)],
    [2, manifestBytes],
    [3, instructionBytes],
  ] as const) {
    const frame = Buffer.allocUnsafe(5);
    frame.writeUInt8(tag, 0);
    frame.writeUInt32BE(bytes.length, 1);
    digest.update(frame);
    digest.update(bytes);
  }
  return {
    id,
    version: value.version,
    description: value.description,
    roles: [...value.roles] as string[],
    source,
    instructions,
    sha256: digest.digest("hex"),
  };
}

/**
 * Every skill available to a run, built-ins plus project overrides.
 *
 * WHY THIS EXISTS. Skills were opt-in through `--skills`, and a skill nobody
 * remembers to pass is a skill that never runs. But selecting them all and
 * pasting every instruction into every role prompt is the opposite mistake:
 * with the skills written out properly that reached 2106 words of appendix for
 * the orchestrator, on top of its own 166-line prompt, whether or not the task
 * needed any of it. `docs/contracts/skills.md` names that boundary directly --
 * discovery "must never silently inject full instructions into every role
 * prompt".
 *
 * So this lists what EXISTS. The catalogue built from it carries ids and
 * one-line descriptions; the instructions arrive only when a role asks for
 * them by calling `load_skill`.
 */
export function listSkillIds(options: { projectDir?: string; builtinDir?: string } = {}): string[] {
  const ids = new Set<string>();
  for (const dir of [
    options.builtinDir ?? BUILTIN_DIR,
    options.projectDir === undefined
      ? undefined
      : path.join(options.projectDir, ".ad-coder", "skills"),
  ]) {
    if (dir === undefined) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!ID.test(entry)) continue;
      // A directory without a manifest is not a skill; resolveSkills would
      // fail on it, and a listing that breaks every run is worse than one
      // that quietly skips a stray folder.
      try {
        if (fs.statSync(path.join(dir, entry, "skill.json")).isFile()) ids.add(entry);
      } catch {
        // not a skill directory
      }
    }
  }
  return [...ids].sort();
}

/** One catalogue row: what a role needs to decide whether to load a skill. */
export interface SkillCatalogueEntry {
  id: string;
  version: string;
  description: string;
  roles: string[];
  source: "builtin" | "project";
}

/**
 * The skills a role may load, as names and one-line descriptions.
 *
 * Cheap by construction: the shipped manifests' descriptions total well under
 * 500 bytes, against several kilobytes of instructions that were previously
 * all-in or all-out. A manifest that fails to parse is skipped rather than
 * taking the catalogue down -- a broken skill must not stop a run that was
 * never going to use it.
 */
export function skillCatalogue(
  role: string,
  options: ResolveSkillsOptions = {},
): SkillCatalogueEntry[] {
  const rows: SkillCatalogueEntry[] = [];
  for (const id of listSkillIds(options)) {
    let skill: ResolvedSkill;
    try {
      const resolved = resolveSkills([id], options)[0];
      if (resolved === undefined) continue;
      skill = resolved;
    } catch {
      continue;
    }
    if (!skill.roles.includes(role)) continue;
    rows.push({
      id: skill.id,
      version: skill.version,
      description: skill.description,
      roles: skill.roles,
      source: skill.source,
    });
  }
  return rows;
}

/** Project skills shadow built-ins, but every requested ID is explicit and bounded. */
export function resolveSkills(
  ids: readonly string[],
  options: ResolveSkillsOptions = {},
): ResolvedSkill[] {
  const maxInstructionBytes = options.maxInstructionBytes ?? DEFAULT_MAX_INSTRUCTION_BYTES;
  const maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
  const maxRequestedSkills = options.maxRequestedSkills ?? DEFAULT_MAX_REQUESTED_SKILLS;
  if (!Number.isSafeInteger(maxInstructionBytes) || maxInstructionBytes <= 0) fail("malformed");
  if (!Number.isSafeInteger(maxManifestBytes) || maxManifestBytes <= 0) fail("malformed");
  if (!Number.isSafeInteger(maxRequestedSkills) || maxRequestedSkills <= 0) fail("malformed");
  if (ids.length > maxRequestedSkills) fail("oversized");
  const seen = new Set<string>();
  return ids.map((id) => {
    if (!ID.test(id) || seen.has(id)) fail("malformed");
    seen.add(id);
    const projectRoot =
      options.projectDir === undefined
        ? undefined
        : path.join(options.projectDir, ".ad-coder", "skills");
    const project =
      projectRoot === undefined
        ? undefined
        : readSkill(projectRoot, id, "project", maxInstructionBytes, maxManifestBytes);
    return (
      project ??
      readSkill(
        options.builtinDir ?? BUILTIN_DIR,
        id,
        "builtin",
        maxInstructionBytes,
        maxManifestBytes,
      ) ??
      fail("missing")
    );
  });
}
