/**
 * Project-key path safety (docs/ROADMAP.md 2026-09-14; docs/contracts/
 * session-manager.md): a project key is a slug, an immediate child directory
 * of a configured allowed root, and the frontier is enforced against REAL
 * paths so a planted symlink cannot carry a key across it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManagerError } from "./types";

/**
 * Slug-only: lowercase alphanumerics with dashes, 1..63 chars, leading
 * alphanumeric. Refuses by construction: absolute paths, `.`/`..`, every
 * path separator, control characters, whitespace keys, and Unicode
 * lookalikes (non-ASCII never matches).
 */
export const PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validateProjectKey(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 63)
    throw new SessionManagerError(
      "invalid_project_key",
      false,
      "project key must be 1..63 characters: lowercase letters, digits, and dashes, starting alphanumeric",
      "use a slug like `notes-site`",
    );
  const traversal = input.includes("/") || input.includes("\\") || input.includes("..");
  if (input === "git" || input === "ad-coder")
    throw new SessionManagerError(
      "invalid_key",
      false,
      "the project keys `git` and `ad-coder` are reserved",
      "choose another slug",
    );
  if (!PROJECT_KEY_PATTERN.test(input))
    throw new SessionManagerError(
      traversal ? "project_unsafe" : "invalid_project_key",
      false,
      traversal
        ? "project key contains a path separator or traversal; refused before any filesystem access"
        : "project key must be 1..63 characters: lowercase letters, digits, and dashes, starting alphanumeric",
      "use a slug like `notes-site`",
    );
  return input;
}

/** Roots are fixed to their real paths at manager start; each must exist. */
export function resolveAllowedRoot(dir: string): string {
  if (typeof dir !== "string" || dir.length === 0 || !path.isAbsolute(dir))
    throw new SessionManagerError(
      "invalid_config",
      false,
      "allowed-roots entries must be absolute directory paths",
      "write absolute directory paths in settings.yaml session-manager.allowed-roots",
    );
  let real: string;
  try {
    real = fs.realpathSync.native(dir);
  } catch (error) {
    throw new SessionManagerError(
      "invalid_config",
      true,
      "an allowed root could not be resolved to a real directory",
      "create the directory or correct the path in settings.yaml session-manager.allowed-roots",
      error,
    );
  }
  if (!fs.statSync(real).isDirectory())
    throw new SessionManagerError(
      "invalid_config",
      false,
      "an allowed root is not a directory",
      "correct the path in settings.yaml session-manager.allowed-roots",
    );
  return real;
}

export class AllowedRoots {
  private readonly roots: readonly string[];
  constructor(entries: readonly string[]) {
    if (entries.length === 0)
      throw new SessionManagerError(
        "invalid_config",
        false,
        "the manager refuses to serve without at least one allowed root",
        "configure session-manager.allowed-roots in settings.yaml",
      );
    this.roots = entries.map(resolveAllowedRoot);
  }

  get values(): readonly string[] {
    return this.roots;
  }
}

/** Segment-aware containment: `path.relative` equality, never a prefix test
 * (`root=/home/u/proj` must not admit `/home/u/proj-x`). */
export function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface ResolvedProject {
  rootReal: string;
  dirReal: string;
  exists: boolean;
}

/**
 * Resolve a validated key across the REAL roots. An EXISTING candidate must
 * resolve (realpath) to a directory immediately under its real root, or the
 * key is reported not-found under that root — a symlink planted at
 * `root/<key>` pointing outside never resolves to a project here. A symlink
 * pointing INSIDE the root is still refused for opening: only a real
 * directory created by the operator (or by safe creation) may host a project.
 */
export function resolveProjectDir(roots: AllowedRoots, key: string): ResolvedProject | undefined {
  validateProjectKey(key);
  for (const rootReal of roots.values) {
    const candidate = path.join(rootReal, key);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (st.isSymbolicLink())
      throw new SessionManagerError(
        "project_unsafe",
        false,
        "a symlink occupies the project key; refusing to follow it",
        "remove the symlink or choose another key",
      );
    if (!st.isDirectory())
      throw new SessionManagerError(
        "project_unsafe",
        false,
        "the project key is occupied by a non-directory",
        "choose another key or move the existing entry",
      );
    const real = fs.realpathSync.native(candidate);
    if (!isInsideRoot(rootReal, real) || path.relative(rootReal, real) !== key)
      throw new SessionManagerError(
        "project_unsafe",
        false,
        "the project directory resolves outside every allowed root; refusing to open it",
        "move the directory under a configured root, or choose another key",
      );
    return { rootReal, dirReal: real, exists: true };
  }
  return undefined;
}

/** Gate before every adoption and creation: real path immediately under a root. */
export function assertRealPathInsideRoot(dirReal: string, roots: AllowedRoots): void {
  const root = roots.values.find((r) => isInsideRoot(r, dirReal));
  if (root === undefined)
    throw new SessionManagerError(
      "project_unsafe",
      false,
      "the resolved project directory sits outside every allowed root; refusing to open it",
      "choose a project key whose directory lies directly under a configured root",
    );
}
