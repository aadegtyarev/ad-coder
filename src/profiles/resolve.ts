import type { Api, Model } from "@earendil-works/pi-ai";
import type { Complexity } from "../orchestration/types";
import { RegistryError } from "../registry/errors";
import type { ResolvedRegistry } from "../registry/types";
import { ProfileError } from "./errors";
import type { Profile, ProfileRole, ResolvedSelection, SpawnOverride } from "./types";

/**
 * Resolve a `(role, complexity)` (or a per-spawn override) into a live pi
 * `Model<Api>`, optional thinking level, and advisory shaping hints.
 *
 * The `ResolvedRegistry` is the SECOND parameter (a resolved registry, not raw
 * config) the profile layer composes ABOVE a resolved registry. Precedence:
 * when `override` is present its `model`/`thinkingLevel`/`maxOutput`/`cacheRetention` win over
 * any `(role, complexity)` cell; otherwise the matching profile entry is used,
 * and a missing cell throws `ProfileError('missing_mapping', 'role:complexity')`.
 *
 * ONE typed error surface. The chosen model NAME resolves through
 * `registry.getModel`, which throws `RegistryError('unknown_model')` on an
 * unregistered name. This function CATCHES that and rethrows
 * `ProfileError('unknown_model', name)` carrying only the stable model NAME so a
 * `RegistryError` never escapes the profile layer, and a caller sees exactly one
 * error class from `resolveProfile`. A non-`RegistryError` throw is genuinely
 * unexpected and is deliberately allowed to propagate unchanged rather than
 * being mislabelled as an unknown model.
 *
 * `maxOutput`/`cacheRetention` are surfaced here and consumed elsewhere:
 * `resolve-config` maps `cacheRetention` onto the role; `maxOutput` still has
 * no sink. See `ResolvedSelection`.
 */
export function resolveProfile(
  profile: Profile,
  registry: ResolvedRegistry,
  role: ProfileRole,
  complexity: Complexity,
  override?: SpawnOverride,
): ResolvedSelection {
  const selection: SpawnOverride =
    override !== undefined ? override : selectFromEntry(profile, role, complexity);

  let model: Model<Api>;
  try {
    model = registry.getModel(selection.model);
  } catch (err) {
    if (err instanceof RegistryError) {
      // Present one typed surface: the profile layer names the model it asked
      // for, and the underlying RegistryError never escapes to the caller.
      throw new ProfileError(
        "unknown_model",
        selection.model,
        `profile model "${selection.model}" is not registered`,
      );
    }
    throw err;
  }

  return {
    model,
    ...(selection.maxOutput !== undefined ? { maxOutput: selection.maxOutput } : {}),
    ...(selection.cacheRetention !== undefined ? { cacheRetention: selection.cacheRetention } : {}),
    ...(selection.thinkingLevel !== undefined ? { thinkingLevel: selection.thinkingLevel } : {}),
  };
}

function selectFromEntry(
  profile: Profile,
  role: ProfileRole,
  complexity: Complexity,
): SpawnOverride {
  const entry = profile.entries.find((e) => e.role === role && e.complexity === complexity);
  if (entry === undefined) {
    const key = `${role}:${complexity}`;
    throw new ProfileError(
      "missing_mapping",
      key,
      `profile has no entry for (role, complexity) "${key}"`,
    );
  }
  return {
    model: entry.model,
    ...(entry.maxOutput !== undefined ? { maxOutput: entry.maxOutput } : {}),
    ...(entry.cacheRetention !== undefined ? { cacheRetention: entry.cacheRetention } : {}),
    ...(entry.thinkingLevel !== undefined ? { thinkingLevel: entry.thinkingLevel } : {}),
  };
}
