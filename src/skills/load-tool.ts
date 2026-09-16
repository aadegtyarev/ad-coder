import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "../runner/tool";
import { defineTool } from "../runner/tool";
import type { ResolveSkillsOptions, SkillCatalogueEntry } from "./resolver";
import { resolveSkills, SkillResolutionError, skillCatalogue } from "./resolver";

export const LOAD_SKILL_TOOL_NAME = "load_skill";

/** How many skills one role may pull into a single turn. */
const DEFAULT_MAX_LOADS_PER_TURN = 4;

/**
 * Renders the catalogue a role prompt carries: ids and one-line descriptions.
 *
 * WHY A CATALOGUE AND NOT THE INSTRUCTIONS. Selecting every skill and pasting
 * its full text into every role prompt cost the orchestrator 2106 words of
 * appendix on top of its own prompt, needed or not. `docs/contracts/skills.md`
 * draws the line: discovery "must never silently inject full instructions into
 * every role prompt". The model is better placed than the operator to know
 * which methodology a task needs -- but only after reading the task, which is
 * exactly when a tool call can still happen and a prompt can no longer change.
 */
export function formatSkillCatalogue(entries: readonly SkillCatalogueEntry[]): string {
  if (entries.length === 0) return "";
  const rows = entries
    .map((entry) => `- ${entry.id}@${entry.version} — ${entry.description}`)
    .join("\n");
  return `\n\nAvailable skills. Each is a method for a kind of work, not a summary of your role. Call ${LOAD_SKILL_TOOL_NAME} with an id when the task at hand is that kind of work; do not load one speculatively.\n${rows}`;
}

export interface SkillLoadRecord {
  id: string;
  version: string;
  source: "builtin" | "project";
  sha256: string;
}

export interface BuildLoadSkillToolOptions extends ResolveSkillsOptions {
  /** The role asking. A skill not scoped to it is refused, as at selection time. */
  role: string;
  /** Loads observed this turn, for the ledger. Identifiers only, never instructions. */
  loaded?: SkillLoadRecord[];
  maxLoadsPerTurn?: number;
}

/**
 * The tool a role calls once it has read the task and knows what it needs.
 *
 * Every constraint that governed up-front selection still governs here: the id
 * pattern, the manifest's role scope, the byte ceilings, and a typed
 * content-free error. A role cannot reach a skill that was not written for it
 * merely because it can name the file.
 */
export function buildLoadSkillTool(options: BuildLoadSkillToolOptions): Tool {
  const maxLoads = options.maxLoadsPerTurn ?? DEFAULT_MAX_LOADS_PER_TURN;
  const loaded = options.loaded ?? [];
  return defineTool({
    name: LOAD_SKILL_TOOL_NAME,
    description:
      "Load one skill's full instructions for this turn, by id from the available-skills list.",
    label: "load skill",
    parameters: Type.Object(
      { id: Type.String({ description: "Skill id exactly as listed in available skills." }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      const id = typeof params.id === "string" ? params.id : "";
      try {
        if (loaded.length >= maxLoads)
          return {
            content: [
              {
                type: "text",
                text: `skill_load_limit: at most ${maxLoads} skills per turn; work with what is loaded`,
              },
            ],
            details: undefined,
          };
        if (loaded.some((entry) => entry.id === id))
          return {
            content: [{ type: "text", text: `already loaded: ${id}` }],
            details: undefined,
          };
        // Scope is checked against the catalogue the role can see, so a refusal
        // says the same thing the listing did rather than leaking what exists
        // for other roles.
        const visible = skillCatalogue(options.role, options);
        if (!visible.some((entry) => entry.id === id))
          return {
            content: [
              {
                type: "text",
                text: `skill_not_available: ${id} is not in the available skills for this role`,
              },
            ],
            details: undefined,
          };
        const skill = resolveSkills([id], options)[0];
        if (skill === undefined)
          return { content: [{ type: "text", text: `skill_missing: ${id}` }], details: undefined };
        loaded.push({
          id: skill.id,
          version: skill.version,
          source: skill.source,
          sha256: skill.sha256,
        });
        return {
          content: [
            { type: "text", text: `## ${skill.id}@${skill.version}\n${skill.instructions}` },
          ],
          details: undefined,
        };
      } catch (error) {
        // Typed and content-free, and carrying the reason: a caller holding
        // only a code cannot repair the call (docs/contracts/errors.md).
        if (error instanceof SkillResolutionError)
          return { content: [{ type: "text", text: error.message }], details: undefined };
        throw error;
      }
    },
  });
}
