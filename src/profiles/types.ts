import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, CacheRetention, Model } from "@earendil-works/pi-ai";
import type { Complexity } from "../orchestration/types";

/**
 * The routing roles a profile can target.
 *
 * Pipeline workers and independently delegated specialists share this routing
 * vocabulary. `recorder` is included as
 * a forward-looking routing target the ledger/recorder follow-on will consume
 * runPipeline does NOT read it today, but the project routes the recorder per
 * tier, so the profile layer must be able to name a model for it now.
 *
 * NO compile-time link binds this union to `PipelineConfig.roles` keys they are
 * kept in sync BY HAND. A future rename of a role key in orchestration would
 * diverge silently; that risk is accepted for this additive, unwired layer.
 */
export type ProfileRole =
  | "planner"
  | "researcher"
  | "coder"
  | "reviewer"
  | "auditor"
  | "security"
  | "recorder";

/**
 * One `(role, complexity)` routing cell: which registry model NAME to use, plus
 * advisory shaping hints and an optional harness thinking level.
 *
 * `model` is a stable registry lookup key (resolved through `ResolvedRegistry`),
 * never a provider-native id and never a credential. `maxOutput` and
 * `cacheRetention` are ADVISORY: this module carries them through to
 * `ResolvedSelection` but has NO sink for them today. The wiring follow-on maps
 * `maxOutput` onto pi `StreamOptions.maxTokens` and `cacheRetention` onto the
 * role's stream options; until then they are inert declared data.
 * `thinkingLevel` is consumed when routed roles are created.
 *
 * `cacheRetention` reuses pi-ai's `CacheRetention` verbatim (`none|short|long`)
 * the same type `Role` uses never redefined here.
 */
export interface ProfileEntry {
  role: ProfileRole;
  complexity: Complexity;
  model: string;
  maxOutput?: number;
  cacheRetention?: CacheRetention;
  thinkingLevel?: ThinkingLevel;
}

/** A whole profile: the set of `(role, complexity)` routing cells. Keyed uniquely on `role:complexity`. */
export interface Profile {
  entries: ProfileEntry[];
}

/**
 * A per-spawn override that takes precedence over the `(role, complexity)` cell.
 *
 * When present, `resolveProfile` uses this override's `model`, `thinkingLevel`,
 * and advisory `maxOutput`/`cacheRetention` INSTEAD OF looking up a profile entry so a
 * caller can pin one spawn to a specific model without editing the profile.
 * `model` is a registry NAME, resolved the same way; the same advisory caveat
 * applies to `maxOutput`/`cacheRetention` (no sink today).
 */
export interface SpawnOverride {
  model: string;
  maxOutput?: number;
  cacheRetention?: CacheRetention;
  thinkingLevel?: ThinkingLevel;
}

/**
 * The result of resolving a `(role, complexity)` (or an override) against a
 * `ResolvedRegistry`: the live pi `Model<Api>`, optional thinking level, and
 * advisory shaping hints.
 *
 * `maxOutput`/`cacheRetention` are produced here but have NO consumer in this
 * unit the wiring follow-on maps `maxOutput` onto pi `StreamOptions.maxTokens`.
 * They are surfaced now so the consuming layer needs no signature change later.
 */
export interface ResolvedSelection {
  model: Model<Api>;
  maxOutput?: number;
  cacheRetention?: CacheRetention;
  thinkingLevel?: ThinkingLevel;
}
