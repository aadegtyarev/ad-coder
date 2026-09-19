import { loadModelsConfigSeam } from "../config/seam";
import { defaultModelsPath } from "../config/store";
import { toRegistryProvider } from "../config/to-registry";
import { ModelInventoryError } from "../inventory/errors";
import { defaultInventoryPath, storedInventoryExists } from "../inventory/store";
import type { ProviderConfig, RegistryConfig } from "../registry/types";

/**
 * Resolution of the DECLARED env-var providers the auth command can manage.
 *
 * WHY A SHARED HELPER. `auth login/status/logout --provider <id>` for a
 * non-built-in `id` must manage the SAME provider routing resolves -- same
 * `models.yaml`-first precedence, same credential env-var NAME projection --
 * otherwise `auth login --provider x` could store a key that routing never
 * reads (or the reverse). One source of truth here keeps the two from
 * drifting. With the stored `inventories.json` route retired (issue #280),
 * "the same" includes routing's retirement: a present stored JSON under an
 * absent `models.yaml` is the same loud migrate-pointer error, and with both
 * sources absent nothing beyond the built-ins is declared.
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
  /**
   * Stored `inventories.json` path; retired as a source (issue #280): when
   * `models.yaml` is absent, its PRESENCE is the loud migrate-pointer error.
   */
  inventoryPath?: string;
}

function sourcePaths(source: DeclaredProviderSource): { models: string; inventory: string } {
  return {
    models: source.modelsConfigPath ?? defaultModelsPath(),
    inventory: source.inventoryPath ?? defaultInventoryPath(),
  };
}

/**
 * The declared env-var providers available to `auth`, keyed by id, resolved the
 * way routing resolves them: `models.yaml` when present; with `models.yaml`
 * absent, a PRESENT stored `inventories.json` is the loud retire error naming
 * `config migrate`, and with both absent nothing is declared (nothing is
 * seeded). Returns an empty map when neither source declares an env-var
 * provider.
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
  // models.yaml ABSENT. The stored `inventories.json` route is retired
  // (issue #280): a PRESENT file is the same loud operator-facing error
  // routing throws -- never a silent read, never a seeding write -- so auth
  // cannot store a key routing would refuse to read. ABSENT both leaves no
  // declared env-var provider: auth covers the built-ins only.
  if (storedInventoryExists(paths.inventory)) {
    throw new Error(
      "stored inventories.json is no longer a routing source: models.yaml is " +
        "the operator-facing stored routing source. " +
        "Run `ad-coder config migrate` to convert it.",
    );
  }
  return new Map();
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
