import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, CacheRetention, Model } from "@earendil-works/pi-ai";
import type { Complexity } from "../orchestration/types";

/**
 * The routing roles a profile can target.
 *
 * Pipeline workers and independently delegated specialists share this routing
 * vocabulary. `orchestrator` is one of them: it drives the conversation and
 * decides which pipeline to run, which is a routing decision like any other, so
 * it must be nameable per complexity and measurable on its own. Before it had a
 * cell it silently borrowed the coder's model -- a profile could not route it,
 * and a calibration run could not attribute its cost.
 *
 * `summarizer` is the compaction model: the cell `resolveConfig` reads when no
 * `--summarizer-model` is given. It was called `recorder` while a recorder role
 * was still planned, and the name outlived the plan -- nothing ever dispatched
 * a recorder, `ROLE_NAMES` never listed one, and the cell was always read for
 * compaction and nothing else. The name now says what the cell does.
 *
 * NO compile-time link binds this union to `PipelineConfig.roles` keys they are
 * kept in sync BY HAND. A future rename of a role key in orchestration would
 * diverge silently; that risk is accepted for this additive, unwired layer.
 */
export type ProfileRole =
  | "orchestrator"
  | "planner"
  | "researcher"
  | "coder"
  | "reviewer"
  | "auditor"
  | "security"
  | "summarizer";

/**
 * One `(role, complexity)` routing cell: which registry model NAME to use, plus
 * advisory shaping hints and an optional harness thinking level.
 *
 * `model` is a stable registry lookup key (resolved through `ResolvedRegistry`),
 * never a provider-native id and never a credential. `cacheRetention` IS
 * consumed: `resolve-config` maps it onto the role, which carries it to pi
 * `StreamOptions`. `maxOutput` remains advisory -- this module carries it to
 * `ResolvedSelection` but nothing maps it onto `StreamOptions.maxTokens` yet,
 * so a declared value is still inert. `thinkingLevel` is consumed when routed
 * roles are created.
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
 * `cacheRetention` and advisory `maxOutput` INSTEAD OF looking up a profile
 * entry so a caller can pin one spawn to a specific model without editing the
 * profile. `model` is a registry NAME, resolved the same way; `maxOutput` keeps
 * the advisory caveat (no sink today), `cacheRetention` does not.
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
 * `cacheRetention` is consumed by `resolve-config`, which maps it onto the
 * role. `maxOutput` is produced here but still has no consumer: nothing maps it
 * onto pi `StreamOptions.maxTokens` yet.
 */
export interface ResolvedSelection {
  model: Model<Api>;
  maxOutput?: number;
  cacheRetention?: CacheRetention;
  thinkingLevel?: ThinkingLevel;
}
