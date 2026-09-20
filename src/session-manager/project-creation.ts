/**
 * Safe project creation (docs/ROADMAP.md 2026-09-14; docs/contracts/
 * session-manager.md): a NEW, non-existing safe-slug directory under an
 * allowed root, `git init`, and only the minimal ignored runtime scaffold.
 * No shell, exclusive creation, frontier re-verified after the fact.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManagerError } from "./types";

/** The only scaffold file, with its LITERAL content — nothing is interpolated. */
const RUNTIME_GITIGNORE =
  "# ad-coder: the runtime scaffold keeps generated artifacts out of Git.\n/runtime/\n";

export interface ProjectCreationPaths {
  rootReal: string;
  dirReal: string;
  runtimeDir: string;
}

/**
 * Atomically create `<root>/<slug>`:
 * 1. refuse a symlink or non-directory already occupying the key (`lstat`,
 *    never `stat` — a stat would follow the planted link);
 * 2. EXCLUSIVE `mkdir` so a concurrent creator loses instead of maybe-wins;
 * 3. realpath the CREATED directory and verify it resolves inside the real
 *    root — the "non-existing" verification runs AFTER creation, not before.
 * The caller has already refused existing keys via resolveProjectDir.
 */
export function createProjectDirectories(rootReal: string, slug: string): ProjectCreationPaths {
  // Never a symlink follow: `mkdirSync` (no recursive) fails on EEXIST for an
  // existing entry, and the realpath-after check re-derives the frontier BELOW.
  const candidate = path.join(rootReal, slug);
  try {
    fs.mkdirSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new SessionManagerError(
        "project_exists",
        false,
        "a project with that key already exists (or appeared while creating)",
        "list existing projects first; safe creation never overwrites",
        error,
      );
    throw new SessionManagerError(
      "project_unsafe",
      true,
      "the project directory could not be created",
      "check the allowed root is writable",
      error,
    );
  }
  const dirReal = fs.realpathSync.native(candidate);
  if (path.dirname(dirReal) !== fs.realpathSync.native(rootReal))
    throw new SessionManagerError(
      "project_unsafe",
      false,
      "the created directory did not resolve immediately under the root; refusing to proceed",
      "check for unexpected filesystem state under the allowed root",
    );
  return { rootReal, dirReal, runtimeDir: path.join(dirReal, "runtime") };
}

export function createRuntimeScaffold(paths: ProjectCreationPaths): void {
  fs.mkdirSync(paths.runtimeDir);
  fs.writeFileSync(path.join(paths.dirReal, ".gitignore"), RUNTIME_GITIGNORE);
  fs.writeFileSync(path.join(paths.runtimeDir, ".gitkeep"), "");
}

/**
 * `git init` with an ARGV ARRAY, no shell, no string command: nothing user
 * controlled can split into a shell channel, because there is no shell.
 */
export function gitInit(dirReal: string): void {
  const result = spawnSync("git", ["init", "--quiet"], {
    cwd: dirReal,
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    encoding: "utf8",
  });
  if (result.error !== undefined || result.status !== 0) {
    const stderr = (result.stderr ?? "").slice(0, 400);
    throw new SessionManagerError(
      "project_unsafe",
      true,
      `git init failed (spawn ${result.error !== undefined ? "error" : `status ${result.status}`}); ${stderr}`.trim(),
      "verify git is installed and the allowed root is writable",
      result.error ?? undefined,
    );
  }
}
