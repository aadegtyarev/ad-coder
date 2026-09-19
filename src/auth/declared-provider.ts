import { loadModelsConfigSeam } from "../config/seam";
import { defaultModelsPath } from "../config/store";
import { toRegistryProvider } from "../config/to-registry";
import { ModelInventoryError } from "../inventory/errors";
import { defaultInventoryPath, readOrCreateDefaultInventory } from "../inventory/store";
import type { ModelInventoryConfig } from "../inventory/types";
import type { ProviderConfig, RegistryConfig } from "../registry/types";

/**
 * Resolution of the DECLARED env-var providers the auth command can manage.
 *
 * WHY A SHARED HELPER. `auth login/status/logout --provider <id>` for a
 * non-built-in `id` must manage the SAME provider routing resolves -- same
 * `models.yaml`-first / `inventories.json`-fallback precedence, same
 * credential env-var NAME projection -- otherwise `auth login --provider x`
 * could store a key that routing never reads (or the reverse). One source of
 * truth here keeps the two from drifting.
 *
 * CREDENTIAL BOUNDARY. A provider's `credential` is an env-var NAME (or the
 * literal `oauth` marker), never a value; nothing here reads process.env and no
 * value is ever materialized or echoed. The returned `RegistryConfig` is the
 * declared data the resolver consumes.
 */

/** Where the declared source lives; both injectable so tests confine reads to temp dirs. */
export interface DeclaredProviderSource {
  /** `models.yaml` path; defaults to the XDG config home (models.yaml-first). */
  modelsConfigPath?: string;
  /** `inventories.json` path; the fallback when `models.yaml` is absent. */
  inventoryPath?: string;
}

function sourcePaths(source: DeclaredProviderSource): { models: string; inventory: string } {
  return {
    models: source.modelsConfigPath ?? defaultModelsPath(),
    inventory: source.inventoryPath ?? defaultInventoryPath(),
  };
}

/**
 * The default profile's registry providers from `inventories.json`, filtered to
 * env-var providers (the only kind `auth` can store a key for -- oauth is the
 * codex-only marker and is never operator-declared as an env-var provider).
 *
 * Uses `readOrCreateDefaultInventory` for the same reason routing does: the
 * first CLI use seeds the built-in profile, and every later read is user-owned.
 */
function inventoryEnvProviders(inventory: ModelInventoryConfig): Map<string, ProviderConfig> {
  const name = inventory.default;
  if (name === undefined) {
    throw new ModelInventoryError(
      "missing_selection",
      "profile",
      "inventory has no default; select a profile explicitly",
    );
  }
  const profile = inventory.profiles.find((entry) => entry.name === name);
  if (profile === undefined) {
    throw new ModelInventoryError(
      "unknown_profile",
      name,
      `inventory profile "${name}" is not declared`,
    );
  }
  const result = new Map<string, ProviderConfig>();
  for (const provider of profile.registry.providers) {
    if (provider.credential.kind === "env-var") result.set(provider.id, provider);
  }
  return result;
}

/**
 * The declared env-var providers available to `auth`, keyed by id, resolved the
 * way routing resolves them: `models.yaml` when present, else `inventories.json`.
 * Returns an empty map when neither source declares an env-var provider.
 */
export function declaredEnvProviders(
  source: DeclaredProviderSource = {},
): Map<string, ProviderConfig> {
  const paths = sourcePaths(source);
  const models = loadModelsConfigSeam(paths.models);
  if (models !== undefined) {
    const result = new Map<string, ProviderConfig>();
    for (const [id, provider] of Object.entries(models.providers)) {
      if (provider.enabled) result.set(id, toRegistryProvider(id, provider));
    }
    return result;
  }
  return inventoryEnvProviders(readOrCreateDefaultInventory(paths.inventory));
}

/** The declared env-var provider ids, for the CLI's `--provider` validation error (ids only). */
export function declaredEnvProviderIds(source: DeclaredProviderSource = {}): string[] {
  return [...declaredEnvProviders(source).keys()];
}

/**
 * A single-provider `RegistryConfig` for a declared env-var provider, for
 * `resolveRegistry` to turn into a live provider the auth command manages.
 * Throws when `providerId` is not declared, naming the declared ids only.
 */
export function resolveDeclaredProviderRegistry(
  providerId: string,
  source: DeclaredProviderSource = {},
): RegistryConfig {
  const provider = declaredEnvProviders(source).get(providerId);
  if (provider === undefined) {
    const ids = declaredEnvProviderIds(source);
    throw new ModelInventoryError(
      "unknown_profile",
      providerId,
      `provider "${providerId}" is not a declared env-var provider${
        ids.length > 0 ? ` (declared: ${ids.join(", ")})` : ""
      }`,
    );
  }
  return { providers: [provider] };
}
