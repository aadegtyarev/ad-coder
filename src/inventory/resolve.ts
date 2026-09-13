import { resolveRegistry } from "../registry/resolve";
import { ModelInventoryError } from "./errors";
import type {
  ModelInventoryConfig,
  ResolvedModelInventory,
  ResolveModelInventoryOptions,
} from "./types";
import { parseModelInventoryConfig } from "./validate";

/** Select and resolve one complete pair. No unselected profile reads credentials. */
export function resolveModelInventory(
  config: ModelInventoryConfig,
  selectedName?: string,
  options?: ResolveModelInventoryOptions,
): ResolvedModelInventory {
  const validated = parseModelInventoryConfig(config);
  const name = selectedName ?? validated.default;
  if (name === undefined)
    throw new ModelInventoryError(
      "missing_selection",
      "profile",
      "inventory has no default; select a profile explicitly",
    );
  const selected = validated.profiles.find((entry) => entry.name === name);
  if (selected === undefined)
    throw new ModelInventoryError(
      "unknown_profile",
      name,
      `inventory profile "${name}" is not declared`,
    );
  return {
    name,
    registry: resolveRegistry(selected.registry, options),
    profile: selected.profile,
    summary: {
      name,
      providerIds: selected.registry.providers.map((provider) => provider.id),
      modelNames: selected.registry.providers.flatMap((provider) =>
        provider.models.map((model) => model.name),
      ),
    },
    source: selectedName === undefined ? "default" : "selection",
  };
}
