import type { Complexity } from "../orchestration/types";
import type { Profile, ProfileEntry, ProfileRole } from "./types";

/** The three registry model NAMES a default profile routes to, by relative strength. */
export interface DefaultProfileModels {
  strong: string;
  mid: string;
  cheap: string;
}

const ALL_COMPLEXITIES: readonly Complexity[] = ["trivial", "medium", "complex"];

/**
 * Build a provider-agnostic default `Profile` from three registry model NAMES.
 *
 * Takes NAMES only (no hardcoded provider ids), so the same builder works over
 * any registry. It emits exactly one entry for every `(role x complexity)` pair
 * (5 roles x 3 complexities = 15) because the profile is keyed on
 * `(role, complexity)` and `resolveProfile` throws `missing_mapping` on any gap
 * even the complexity-invariant roles get an entry at every complexity.
 *
 * Routing: `planner` and `security` -> `strong` at every complexity (planning
 * and threat-modelling are where the strong model earns its cost); `reviewer`
 * -> `mid`; `recorder` -> `cheap`; `coder` scales with the task
 * (`trivial -> cheap`, `medium -> mid`, `complex -> strong`), since a weak coder
 * on a hard task just buys extra review rounds.
 *
 * The result is self-consistent (no duplicate keys) so `parseProfile` accepts it
 * unchanged.
 */
export function buildDefaultProfile(models: DefaultProfileModels): Profile {
  const { strong, mid, cheap } = models;

  const modelFor = (role: ProfileRole, complexity: Complexity): string => {
    switch (role) {
      case "planner":
      case "security":
        return strong;
      case "reviewer":
        return mid;
      case "recorder":
        return cheap;
      case "coder":
        return coderModel(complexity, models);
    }
  };

  const entries: ProfileEntry[] = [];
  const roles: readonly ProfileRole[] = ["planner", "coder", "reviewer", "security", "recorder"];
  for (const role of roles) {
    for (const complexity of ALL_COMPLEXITIES) {
      entries.push({ role, complexity, model: modelFor(role, complexity) });
    }
  }

  return { entries };
}

function coderModel(complexity: Complexity, models: DefaultProfileModels): string {
  switch (complexity) {
    case "trivial":
      return models.cheap;
    case "medium":
      return models.mid;
    case "complex":
      return models.strong;
  }
}
