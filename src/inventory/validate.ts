import { parseProfile } from "../profiles/validate";
import { parseRegistryConfig } from "../registry/validate";
import { ModelInventoryError } from "./errors";
import type { ModelInventoryConfig, ModelInventoryProfile } from "./types";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate every atomic pair and every profile model reference without reading credentials. */
export function parseModelInventoryConfig(value: unknown): ModelInventoryConfig {
  if (!isObject(value))
    throw new ModelInventoryError("invalid_config", "config", "inventory config must be an object");
  if (!Array.isArray(value.profiles) || value.profiles.length === 0)
    throw new ModelInventoryError(
      "invalid_config",
      "profiles",
      "inventory profiles must be a non-empty array",
    );

  const seen = new Set<string>();
  const profiles: ModelInventoryProfile[] = value.profiles.map((entry) => {
    if (!isObject(entry))
      throw new ModelInventoryError(
        "invalid_config",
        "profile",
        "each inventory profile must be an object",
      );
    if (typeof entry.name !== "string" || !PROFILE_NAME.test(entry.name))
      throw new ModelInventoryError(
        "invalid_config",
        "profile.name",
        "inventory profile names must use letters, numbers, dot, underscore, or hyphen",
      );
    if (seen.has(entry.name))
      throw new ModelInventoryError(
        "duplicate_profile",
        entry.name,
        `inventory profile "${entry.name}" is declared more than once`,
      );
    seen.add(entry.name);
    const registry = parseRegistryConfig(entry.registry);
    const profile = parseProfile(entry.profile);
    const modelNames = new Set(
      registry.providers.flatMap((provider) => provider.models.map((model) => model.name)),
    );
    for (const route of profile.entries) {
      if (!modelNames.has(route.model))
        throw new ModelInventoryError(
          "unknown_model",
          route.model,
          `inventory profile "${entry.name}" routes to unregistered model "${route.model}"`,
        );
    }
    return { name: entry.name, registry, profile };
  });

  if (value.default !== undefined) {
    if (typeof value.default !== "string" || !PROFILE_NAME.test(value.default))
      throw new ModelInventoryError(
        "invalid_config",
        "default",
        "inventory default must be a valid profile name",
      );
    if (!seen.has(value.default))
      throw new ModelInventoryError(
        "unknown_profile",
        value.default,
        `inventory default "${value.default}" is not declared`,
      );
  }
  return { profiles, ...(value.default !== undefined && { default: value.default }) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
