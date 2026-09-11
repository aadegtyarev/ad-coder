import * as fs from "node:fs";
import * as path from "node:path";
import { PromptError } from "./errors";

/**
 * The shipped built-in prompts dir, located package-relative so it survives a
 * global install: the package ships source with siblings intact and has no
 * `files` allow-list, so from `src/prompts` the repo-root `prompts/` is two
 * levels up. Computed once at module load.
 */
const BUILTIN_PROMPTS_DIR = path.join(import.meta.dir, "..", "..", "prompts");

/**
 * A bare prompt name that becomes a path component. Reject dots (so no `..`
 * traversal and no extension smuggling), slashes and anything else -- the same
 * validate-before-path-build discipline as `assertRunId`.
 */
const PROMPT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ResolvePromptOptions {
  /**
   * Root under which `.ad-coder/prompts/` is searched FIRST, overriding the
   * built-in of the same name. Absent = built-in only.
   */
  projectDir?: string;
  /** Overrides the shipped built-in dir (for tests). Absent = package default. */
  builtinDir?: string;
}

/**
 * Resolve a SYSTEM prompt by bare `name` to a verbatim UTF-8 string, so a role
 * can reference "coder" instead of embedding an inline `fs.readFileSync`.
 *
 * The name is validated BEFORE any path is joined. A project prompt at
 * `<projectDir>/.ad-coder/prompts/<name>.md` overrides the built-in shipped at
 * `prompts/<name>.md`. The file is returned UNCHANGED -- no trim, no normalize,
 * no templating -- because it is the cacheable verbatim cache prefix.
 *
 * @throws {PromptError} `invalid_name` if `name` is not `/^[A-Za-z0-9_-]+$/`
 *   (thrown before any fs access, with an empty `pathsTried`); `not_found` if
 *   no candidate exists, with `pathsTried` listing the absolute paths searched.
 */
export function resolvePrompt(name: string, opts?: ResolvePromptOptions): string {
  if (!PROMPT_NAME_PATTERN.test(name)) {
    throw new PromptError(
      "invalid_name",
      name,
      [],
      `prompt name must match ${String(PROMPT_NAME_PATTERN)} (it is used as a file name)`,
    );
  }

  const builtinDir = opts?.builtinDir ?? BUILTIN_PROMPTS_DIR;
  const candidates: string[] = [];
  if (opts?.projectDir !== undefined) {
    candidates.push(path.join(opts.projectDir, ".ad-coder", "prompts", `${name}.md`));
  }
  candidates.push(path.join(builtinDir, `${name}.md`));

  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch (err) {
      // A missing candidate is expected -- fall through to the next tier. Any
      // other fs error (permissions, a directory in the way) is real and must
      // not be swallowed as a not_found.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }
  }

  throw new PromptError(
    "not_found",
    name,
    candidates,
    `prompt "${name}" not found in ${candidates.length} location(s)`,
  );
}
