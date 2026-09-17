import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXPLORE_PROJECT_TOOL_NAME } from "../project-tools/explore";
import { READ_PROJECT_TOOL_NAME } from "../project-tools/read";
import { SEARCH_PROJECT_TOOL_NAME } from "../project-tools/search";
import { INSPECT_IMAGE_TOOL_NAME, WEB_READ_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "../web/tools";

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

/**
 * What a skill needs from the session it is being loaded into.
 *
 * `workflows` names workflow modules the run actually resolved; `plugins` names
 * built-in plugin groups whose tools are really registered. Both are checked
 * against the caller's composition -- never against a claim in the manifest,
 * because a skill is data and the composition is what is true at this dispatch.
 */
export interface SkillRequires {
  workflows?: string[];
  plugins?: string[];
}

/**
 * The manifest a skill's `skill.json` declares.
 *
 * `always` and `requires` are optional and additive: a manifest without them
 * behaves exactly as every shipped skill did before they existed (opt-in
 * through the catalogue, reachable in every role in its `roles` list).
 */
export interface SkillManifest {
  id: string;
  version: string;
  description: string;
  roles: string[];
  /** Paste the instructions into every role prompt in `roles`, unprompted. */
  always?: boolean;
  /** Loadable only where the session's composition satisfies every entry. */
  requires?: SkillRequires;
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
  /** Workflow modules this session resolved. Absent means NOTHING is available. */
  availableWorkflows?: readonly string[];
  /** Plugin groups whose tools are really registered. Absent means NONE. */
  availablePlugins?: readonly string[];
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

const MANIFEST_KEYS = ["id", "version", "description", "roles", "always", "requires"];
const REQUIRES_KEYS = ["workflows", "plugins"];

/**
 * Validates the optional `requires` object, or fails the skill's manifest.
 *
 * A key outside the two known ones is refused rather than ignored: a typo
 * (`require`, `workflow`, `plugin`) would otherwise silently disable the gate
 * the manifest author believed they had written.
 */
function parseRequires(value: unknown): SkillRequires | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("malformed");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !REQUIRES_KEYS.includes(key))) fail("malformed");
  const requires: SkillRequires = {};
  for (const key of REQUIRES_KEYS) {
    const names = record[key];
    if (names === undefined) continue;
    // An empty list is vacuously satisfied, and kept as written so the manifest
    // round-trips; only a non-array or a non-string element is malformed.
    if (
      !Array.isArray(names) ||
      names.some((name) => typeof name !== "string" || name.length === 0)
    )
      fail("malformed");
    if (key === "workflows") requires.workflows = [...names] as string[];
    else requires.plugins = [...names] as string[];
  }
  return requires;
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
  if (Object.keys(value).some((key) => !MANIFEST_KEYS.includes(key))) fail("malformed");
  if (value.always !== undefined && typeof value.always !== "boolean") fail("malformed");
  const requires = parseRequires(value.requires);
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
  const always = value.always;
  return {
    id,
    version: value.version,
    description: value.description,
    roles: [...value.roles] as string[],
    ...(typeof always === "boolean" ? { always } : {}),
    ...(requires === undefined ? {} : { requires }),
    source,
    instructions,
    sha256: digest.digest("hex"),
  };
}

/**
 * Whether a session's actual composition satisfies a skill's `requires`.
 *
 * Fail-closed by construction: an ABSENT composition is not an unknown that
 * might hold -- a caller that did not state what this session has is treated as
 * having nothing, so a composition left unwired can never silently enable a
 * skill the run cannot honour. An undefined `requires` constrains nothing.
 */
export function dependenciesMet(
  requires: SkillRequires | undefined,
  options: ResolveSkillsOptions = {},
): boolean {
  if (requires === undefined) return true;
  const workflows = options.availableWorkflows ?? [];
  const plugins = options.availablePlugins ?? [];
  return (
    (requires.workflows ?? []).every((name) => workflows.includes(name)) &&
    (requires.plugins ?? []).every((name) => plugins.includes(name))
  );
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
 *
 * Two kinds of skill never reach a row: an `always` skill, whose instructions
 * are already in the prompt (listing it would invite a `load_skill` call for
 * text the role is reading), and a skill whose `requires` this session's
 * composition does not satisfy.
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
    if (skill.always === true) continue;
    if (!dependenciesMet(skill.requires, options)) continue;
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

/**
 * The skills a role receives WITHOUT asking: those declaring `always: true`.
 *
 * The operator's reason is that the role cannot understand its own situation
 * without the text -- not that the text is useful. `docs/contracts/skills.md`
 * carries the cost rule beside it: pasting what is merely useful is how the
 * orchestrator reached 2106 words of appendix, and the session measurements
 * behind the catalogue (docs/reviews/2026-09-17-a-capable-model-on-real-work.md)
 * found 93% of input tokens came from cache precisely because a prompt is
 * re-read every turn, so an unconditional word is paid for on every turn.
 *
 * Composition is honoured exactly as in the catalogue: a skill whose `requires`
 * this session cannot satisfy is pasted nowhere. A skill that fails to resolve
 * is skipped, like a broken catalogue row, rather than taking the role down.
 */
export function unconditionalSkills(
  role: string,
  options: ResolveSkillsOptions = {},
): ResolvedSkill[] {
  const selected: ResolvedSkill[] = [];
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
    if (skill.always !== true) continue;
    if (!dependenciesMet(skill.requires, options)) continue;
    selected.push(skill);
  }
  return selected;
}

/**
 * Which built-in plugin groups a set of registered tool names proves present.
 *
 * Skills gate on plugins through real tool names rather than through a
 * configured group name: `--plugins web` with the web tools absent from this
 * model's surface must not satisfy a `requires: {plugins: ["web"]}` skill, and
 * a plugin group named in configuration is exactly the claim a skill must not
 * trust. Returns sorted unique names actually found.
 */
export function pluginNamesFromToolNames(names: readonly string[]): string[] {
  const found = new Set<string>();
  for (const name of names) {
    if (
      name === EXPLORE_PROJECT_TOOL_NAME ||
      name === SEARCH_PROJECT_TOOL_NAME ||
      name === READ_PROJECT_TOOL_NAME
    )
      found.add("explore");
    else if (name === WEB_SEARCH_TOOL_NAME || name === WEB_READ_TOOL_NAME) found.add("web");
    else if (name === INSPECT_IMAGE_TOOL_NAME) found.add("vision");
  }
  return [...found].sort();
}

/**
 * Every skill a run can reach, resolved: the visibility source for `config
 * show` (id, version, source tier, SHA-256 digest of the loaded content).
 * Catalogue semantics: an entry that fails to resolve is skipped, exactly as a
 * per-role catalogue skips it, because the default set never loads at dispatch
 * -- a pin still fails loudly through `resolveSkills` on the same paths. An
 * entry whose `requires` this session's composition cannot satisfy is skipped
 * too: `config show` must report what a run can reach, and an unreachable row
 * would be a capability the operator cannot use.
 */
export function skillInventory(options: ResolveSkillsOptions = {}): ResolvedSkill[] {
  const resolved: ResolvedSkill[] = [];
  for (const id of listSkillIds(options)) {
    try {
      const skill = resolveSkills([id], options)[0];
      if (skill === undefined) continue;
      if (!dependenciesMet(skill.requires, options)) continue;
      resolved.push(skill);
    } catch {
      // Same per-role catalogue contract: inform the operator in config show
      // that a row is unavailable rather than aborting the enumeration.
    }
  }
  return resolved;
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
