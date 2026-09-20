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
 *
 * WHY THE HEADER CARRIES A RULE. A menu is advice: the orchestrator held
 * `delivery-calibration`, never loaded it, and dispatched the decomposed ticket
 * ten seconds later. The obligation is therefore stated here, in general words
 * and without naming a skill -- this text reaches every role that has a
 * catalogue, and the descriptions below it say which situation each one is for
 * (2026-09-18, docs/contracts/skills.md).
 */
export function formatSkillCatalogue(entries: readonly SkillCatalogueEntry[]): string {
  if (entries.length === 0) return "";
  const rows = entries
    .map((entry) => `- ${entry.id}@${entry.version} — ${entry.description}`)
    .join("\n");
  return `\n\nAvailable skills. Each is a method for a kind of work, and its description says when it applies. Where one matches the work in front of you, following it is mandatory rather than optional. Call ${LOAD_SKILL_TOOL_NAME} with an id to load the full text.\n${rows}`;
}

export interface SkillLoadRecord {
  id: string;
  version: string;
  source: "builtin" | "project";
  sha256: string;
}

/** What an address names: a row, an unknown id, or a known id at an unlisted version. */
type CatalogueMatch =
  | { kind: "row"; row: SkillCatalogueEntry }
  | { kind: "version_mismatch"; row: SkillCatalogueEntry }
  | { kind: "unknown" };

/**
 * The two spellings a caller may use: the bare id, or the row the catalogue
 * advertised, `<id>@<version>`.
 *
 * WHY BOTH, AND WHY COMPARED WHOLE. The catalogue renders every row as
 * `- ${id}@${version} — ${description}` and the parameter says "exactly as
 * listed in available skills", so the string the model is shown has to be a
 * string the tool accepts. It was not: the executor compared the request
 * against the bare id, so every copied row was refused as
 * `skill_not_available` -- a message that accuses the caller's role scope,
 * which was false, and that reads as "this skill does not exist here".
 * Measured 2026-09-20 (issue #524): 22 distinct ids refused across one
 * checkout's sessions while the bare ids loaded in the same runs, so no role
 * in any console ever followed a skill.
 *
 * The row is therefore matched against what the catalogue PRINTED, not
 * re-parsed into an id and a version: a version is any non-empty string
 * (src/skills/resolver.ts), so `@` inside one is legal, and splitting the
 * rendered row would refuse a row this very catalogue shows (measured in review
 * of #524: version `v@2` renders `row-address@v@2`, and splitting at the last
 * `@` answers `row-address@v is not in the available skills`). Splitting is
 * still how an unlisted version is ATTRIBUTED -- that answer names the version
 * the session does have, and the ids it compares cannot be ambiguous, since the
 * id pattern forbids `@`.
 */
function matchCatalogueRow(visible: readonly SkillCatalogueEntry[], asked: string): CatalogueMatch {
  for (const entry of visible)
    if (entry.id === asked || `${entry.id}@${entry.version}` === asked)
      return { kind: "row", row: entry };
  // The suffix must be non-empty: `id@` names no version, so it stays an id the
  // catalogue does not have rather than being reported as a version mismatch.
  let best: SkillCatalogueEntry | undefined;
  for (const entry of visible) {
    if (asked.length <= entry.id.length + 1) continue;
    if (!asked.startsWith(`${entry.id}@`)) continue;
    if (best === undefined || entry.id.length > best.id.length) best = entry;
  }
  return best === undefined ? { kind: "unknown" } : { kind: "version_mismatch", row: best };
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
      "Load one skill's full instructions for this turn, by id from the available-skills list. Load one only when its description matches the work at hand, never speculatively.",
    label: "load skill",
    parameters: Type.Object(
      {
        id: Type.String({
          description:
            "Skill id: the id from the available-skills list, or that row exactly as listed (`id@version`). Both name the same skill.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      // Trimmed: a caller copying a row out of a prompt can carry the
      // whitespace around it, and the address is the row itself.
      const asked = typeof params.id === "string" ? params.id.trim() : "";
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
        // Scope is checked against the catalogue the role can see, so a refusal
        // says the same thing the listing did rather than leaking what exists
        // for other roles.
        const match = matchCatalogueRow(skillCatalogue(options.role, options), asked);
        if (match.kind === "unknown")
          return {
            content: [
              {
                type: "text",
                text: `skill_not_available: ${asked} is not in the available skills for this role`,
              },
            ],
            details: undefined,
          };
        // A version the session does not list is refused by name. Answering
        // with a different revision would make the version in the row a
        // decoration; the caller asked for one and is told which one exists.
        if (match.kind === "version_mismatch")
          return {
            content: [
              {
                type: "text",
                text: `skill_version_mismatch: ${asked} was asked for; this session lists ${match.row.id}@${match.row.version}`,
              },
            ],
            details: undefined,
          };
        const { row } = match;
        // Keyed on the resolved id, so both spellings of one skill are the same
        // request: otherwise a role could reach its per-turn ceiling by asking
        // for the row and then for the id.
        if (loaded.some((entry) => entry.id === row.id))
          return {
            content: [{ type: "text", text: `already loaded: ${row.id}` }],
            details: undefined,
          };
        const skill = resolveSkills([row.id], options)[0];
        if (skill === undefined)
          return {
            content: [{ type: "text", text: `skill_missing: ${row.id}` }],
            details: undefined,
          };
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
