import type { Tool } from "../runner/tool";
import {
  buildLoadSkillTool,
  formatSkillCatalogue,
  LOAD_SKILL_TOOL_NAME,
  type SkillLoadRecord,
} from "./load-tool";
import { resolveSkills, skillCatalogue } from "./resolver";

/**
 * How ONE role receives its skills, wherever that role runs.
 *
 * Skills must behave identically in every user-facing command: the console
 * session, a delegated `run_role`, the `role` subcommand, every pipeline stage
 * on `pipeline`/`drive`, and background runs. Two modes, exactly as
 * `docs/contracts/skills.md` draws them:
 *
 * - PIN. `--skills a,b` pastes exactly those skills, role-scoped, into the
 *   prompt for the operator who knows better than the model. No loader tool:
 *   it would have nothing left to fetch.
 * - CATALOGUE. No `--skills` means each role's prompt lists ids, versions and
 *   one-line descriptions, and the role pulls full instructions with
 *   `load_skill` after reading the task. The loader ships exactly when the
 *   prompt lists skills; a menu without the way to act on it is a locked
 *   kitchen.
 *
 * Every constraint governs identically in both paths: the id pattern, role
 * scope, per-turn and byte ceilings, and a typed content-free error. An
 * invalid pin fails loudly here, before any provider dispatch.
 */
export interface RoleSkillKit {
  /** "" when the role has no skills; the catalogue or the pin text otherwise. */
  readonly appendix: string;
  /** Whether this role's prompt lists skills it may load with `load_skill`. */
  readonly includeLoadTool: boolean;
  /** A fresh loader for one turn/conversation; callers own each instance. */
  readonly buildTool: () => Tool;
}

export interface RoleSkillKitOptions {
  role: string;
  /** Explicit pinned ids; absent, empty, or only whitespace-with-commas means catalogue. */
  selectedSkills?: readonly string[] | undefined;
  projectDir?: string | undefined;
}

export function roleSkillKit(options: RoleSkillKitOptions): RoleSkillKit {
  const { role, projectDir } = options;
  const resolverOptions: { projectDir?: string } = projectDir === undefined ? {} : { projectDir };
  const ids = (options.selectedSkills ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  // resolveSkills enforces every ceiling and fails loudly BEFORE dispatch;
  // this mirrors the selection-time guarantees the catalogue path inherits.
  if (ids.length > 0) {
    const pinned = resolveSkills(ids, resolverOptions);
    const applicable = pinned.filter((skill) => skill.roles.includes(role));
    if (applicable.length === 0) {
      return {
        appendix: "",
        includeLoadTool: false,
        buildTool: () => buildLoadSkillTool({ role, ...resolverOptions }),
      };
    }
    return {
      appendix: `\n\nSelected skills:\n${applicable
        .map((skill) => `## ${skill.id}@${skill.version}\n${skill.instructions}`)
        .join("\n\n")}`,
      includeLoadTool: false,
      buildTool: () => buildLoadSkillTool({ role, ...resolverOptions }),
    };
  }
  const roster = skillCatalogue(role, resolverOptions);
  return {
    appendix: roster.length === 0 ? "" : formatSkillCatalogue(roster),
    // A catalogue with no rows ships no loader: a tool that answers
    // `skill_not_available` to every call is noise, not capability.
    includeLoadTool: roster.length > 0,
    buildTool: () => buildLoadSkillTool({ role, ...resolverOptions }),
  };
}

export type { SkillLoadRecord };
export { LOAD_SKILL_TOOL_NAME };
