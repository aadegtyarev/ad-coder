import { ConfigError } from "../config/errors";
import { loadModelsConfigSeam } from "../config/seam";
import { defaultModelsPath } from "../config/store";
import { toRegistryProvider } from "../config/to-registry";
import type { ProviderConfig, RegistryConfig } from "../registry/types";

/**
 * Resolution of the DECLARED env-var providers the auth command can manage.
 *
 * WHY A SHARED HELPER. `auth login/status/logout --provider <id>` for a
 * non-built-in `id` must manage the SAME provider routing resolves -- same
 * `models.yaml` precedence, same credential env-var NAME projection --
 * otherwise `auth login --provider x` could store a key that routing never
 * reads (or the reverse). One source of truth here keeps the two from
 * drifting. `models.yaml` is now the ONLY declared stored source (the JSON
 * inventory route was removed outright in issue #513), so with it absent
 * nothing beyond the built-ins is declared.
 *
 * CREDENTIAL BOUNDARY. A provider's `credential` is an env-var NAME (or the
 * literal `oauth` marker), never a value; nothing here reads process.env and no
 * value is ever materialized or echoed. The returned `RegistryConfig` is the
 * declared data the resolver consumes.
 */

/** Where the declared source lives; injectable so tests confine reads to temp dirs. */
export interface DeclaredProviderSource {
  /** `models.yaml` path; defaults to the XDG config home. */
  modelsConfigPath?: string;
}

/**
 * The declared env-var providers available to `auth`, keyed by id, resolved the
 * way routing resolves them: `models.yaml` when present, nothing declared when
 * it is absent (nothing is seeded). Returns an empty map when the document
 * declares no env-var provider.
 */
export function declaredEnvProviders(
  source: DeclaredProviderSource = {},
): Map<string, ProviderConfig> {
  // A file left on disk from the removed JSON-inventory route (issue #513) is
  // read by nothing and is not an error: there is no second stored source left
  // to point the operator at, and no migration command to name.
  const models = loadModelsConfigSeam(source.modelsConfigPath ?? defaultModelsPath());
  if (models === undefined) return new Map();
  const result = new Map<string, ProviderConfig>();
  for (const [id, provider] of Object.entries(models.providers)) {
    if (provider.enabled) result.set(id, toRegistryProvider(id, provider));
  }
  return result;
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
    throw new ConfigError(
      "unknown_profile",
      providerId,
      `provider "${providerId}" is not a declared env-var provider${
        ids.length > 0 ? ` (declared: ${ids.join(", ")})` : ""
      }`,
    );
  }
  return { providers: [provider] };
}
