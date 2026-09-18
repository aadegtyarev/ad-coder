import type { Tool } from "../runner/tool";
import {
  buildLoadSkillTool,
  formatSkillCatalogue,
  LOAD_SKILL_TOOL_NAME,
  type SkillLoadRecord,
} from "./load-tool";
import type { ResolveSkillsOptions } from "./resolver";
import { dependenciesMet, resolveSkills, skillCatalogue, unconditionalSkills } from "./resolver";

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
 * Both paths carry an `always: true` skill's instructions unprompted -- that is
 * what the declaration is for -- and neither offers a skill whose `requires`
 * this session's composition does not satisfy. In PIN mode an unmet pinned id is
 * dropped silently rather than failing the run: the pin says which skills to
 * use, and a dependency this session lacks is the session's fact, not a
 * malformed request. Composition reaches every mode through `resolverOptions`,
 * so all three agree on what exists.
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
  /** `--no-skills`: no catalogue, no loader, no prompt appendix. */
  disabled?: boolean | undefined;
  projectDir?: string | undefined;
  /** Workflow modules this session resolved, for `requires.workflows`. */
  availableWorkflows?: readonly string[] | undefined;
  /** Plugin groups whose tools are really registered, for `requires.plugins`. */
  availablePlugins?: readonly string[] | undefined;
}

export function roleSkillKit(options: RoleSkillKitOptions): RoleSkillKit {
  const { role, projectDir } = options;
  // Composition rides in one options object, so the catalogue, the paste and the
  // loader cannot disagree about which skills this session can reach.
  const resolverOptions: ResolveSkillsOptions = {
    ...(projectDir === undefined ? {} : { projectDir }),
    ...(options.availableWorkflows === undefined
      ? {}
      : { availableWorkflows: options.availableWorkflows }),
    ...(options.availablePlugins === undefined
      ? {}
      : { availablePlugins: options.availablePlugins }),
  };
  const ids = (options.selectedSkills ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
  // An explicit off beats everything: nothing is pasted and no loader ships.
  if (options.disabled === true) {
    return {
      appendix: "",
      includeLoadTool: false,
      buildTool: () => buildLoadSkillTool({ role, ...resolverOptions }),
    };
  }
  // resolveSkills enforces every ceiling and fails loudly BEFORE dispatch;
  // this mirrors the selection-time guarantees the catalogue path inherits.
  if (ids.length > 0) {
    const pinned = resolveSkills(ids, resolverOptions);
    const applicable = pinned.filter(
      (skill) => skill.roles.includes(role) && dependenciesMet(skill.requires, resolverOptions),
    );
    const pinnedIds = new Set(pinned.map((skill) => skill.id));
    // An always skill the operator did not pin rides along: the pin chooses what
    // to add, it does not un-declare a skill that declares itself unconditional.
    const pasted = [
      ...unconditionalSkills(role, resolverOptions).filter((skill) => !pinnedIds.has(skill.id)),
      ...applicable,
    ];
    if (pasted.length === 0) {
      return {
        appendix: "",
        includeLoadTool: false,
        buildTool: () => buildLoadSkillTool({ role, ...resolverOptions }),
      };
    }
    return {
      appendix: `\n\nSelected skills. These are pinned for this task, so they apply: follow them, and where one contradicts your own habit the skill wins.\n${pasted
        .map((skill) => `## ${skill.id}@${skill.version}\n${skill.instructions}`)
        .join("\n\n")}`,
      includeLoadTool: false,
      buildTool: () => buildLoadSkillTool({ role, ...resolverOptions }),
    };
  }
  const roster = skillCatalogue(role, resolverOptions);
  const always = unconditionalSkills(role, resolverOptions);
  const alwaysText = always
    .map((skill) => `## ${skill.id}@${skill.version}\n${skill.instructions}`)
    .join("\n\n");
  return {
    // The always paste leads, then the menu of what remains loadable on demand.
    appendix: `${alwaysText.length === 0 ? "" : `\n\n${alwaysText}`}${
      roster.length === 0 ? "" : formatSkillCatalogue(roster)
    }`,
    // A catalogue with no rows ships no loader: a tool that answers
    // `skill_not_available` to every call is noise, not capability. An
    // always-pasted skill is already in the prompt, so it is not a row and
    // must never be the reason a loader ships.
    includeLoadTool: roster.length > 0,
    buildTool: () => buildLoadSkillTool({ role, ...resolverOptions }),
  };
}

export type { SkillLoadRecord };
export { LOAD_SKILL_TOOL_NAME };
