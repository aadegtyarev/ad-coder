import type { Complexity } from "../orchestration/types";
import type { Profile, ProfileEntry, ProfileRole } from "../profiles/types";
import type {
  CredentialSource,
  RegistryConfig,
  ModelConfig as RegistryModelConfig,
  ProviderConfig as RegistryProviderConfig,
} from "../registry/types";
import { ConfigError } from "./errors";
import type {
  ModelConfig as ConfigModelConfig,
  ProviderConfig as ConfigProviderConfig,
  ModelsConfig,
} from "./types";

/** The three tiers a routing profile exposes, in canonical order. */
const COMPLEXITIES: readonly Complexity[] = ["trivial", "medium", "complex"];

/**
 * Splits a `provider:model` rung at the FIRST colon and keeps the model part.
 * The provider name cannot contain a colon (types.ts), so everything after the
 * first one is the model name verbatim, tags and variants included.
 */
function modelPart(rung: string): string {
  const colon = rung.indexOf(":");
  return colon === -1 ? rung : rung.slice(colon + 1);
}

/**
 * One models.yaml model row as a registry model. `name` and `modelId` are the
 * file's row key: this layer derives no alias and no catalog, and the registry
 * documents `name` defaulting to `modelId`.
 *
 * Only declared fields are carried -- the input vocabulary has no `maxTokens`,
 * modalities, or thinking support, so those optional registry fields stay
 * absent rather than guessed.
 */
function toRegistryModel(name: string, model: ConfigModelConfig): RegistryModelConfig {
  return {
    name,
    modelId: name,
    cost: {
      input: model.input,
      output: model.output,
      // models.yaml declares only input/output prices. The registry's cost
      // shape also requires per-token cache rates, which this vocabulary has
      // no field for yet -- they settle at zero, the only value not invented
      // (a guessed nonzero rate would corrupt every budget computed from it).
      cacheRead: 0,
      cacheWrite: 0,
    },
    ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  };
}

function toRegistryProvider(id: string, provider: ConfigProviderConfig): RegistryProviderConfig {
  return {
    id,
    api: provider.api as RegistryProviderConfig["api"],
    // `credential` is a REFERENCE (an env-var name or the oauth marker) by
    // the validated config contract; the canonical source shape lives in
    // the registry layer, so the validated value is retyped at this one
    // projection boundary.
    credential: provider.credential as unknown as CredentialSource,
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    models: Object.entries(provider.models).map(([name, model]) => toRegistryModel(name, model)),
  };
}

/**
 * The pure projection of a validated `models.yaml` into the registry
 * declaration and a routing profile. No I/O, no mutation, and no error from
 * data content -- the input is already validated; the only failures are
 * "which profile" questions this function owns.
 */
export function toRegistryAndProfile(
  config: ModelsConfig,
  profileName?: string,
): { registry: RegistryConfig; profile: Profile; name: string } {
  const name = profileName ?? config.defaultProfile;
  if (name === undefined) {
    throw new ConfigError(
      "invalid_config",
      "defaultProfile",
      "no profile selected: no `defaultProfile` in config and no profileName given",
    );
  }
  const declared = config.profiles[name];
  if (declared === undefined) {
    throw new ConfigError("unknown_profile", name, `no such profile in config: ${name}`);
  }

  const registry: RegistryConfig = {
    providers: Object.entries(config.providers)
      .filter(([, provider]) => provider.enabled)
      .map(([id, provider]) => toRegistryProvider(id, provider)),
  };

  // Ladder failover is not implemented yet: only a row's FIRST rung (index 0)
  // reaches an entry; the remaining rungs of a list-valued row are ignored
  // until the resolver can walk a ladder.
  const bare = new Map<ProfileRole, string[]>();
  const overrides = new Map<ProfileRole, Partial<Record<Complexity, string[]>>>();
  for (const [key, ladder] of Object.entries(declared.routes)) {
    const at = key.indexOf("@");
    if (at === -1) {
      bare.set(key as ProfileRole, [...ladder]);
      continue;
    }
    const role = key.slice(0, at) as ProfileRole;
    const tier = key.slice(at + 1) as Complexity;
    const perRole = overrides.get(role) ?? {};
    perRole[tier] = [...ladder];
    overrides.set(role, perRole);
  }

  const entries: ProfileEntry[] = [];
  for (const [role, ladder] of bare) {
    const perRole = overrides.get(role);
    for (const complexity of COMPLEXITIES) {
      const chosen = perRole?.[complexity] ?? ladder;
      if (chosen.length === 0) {
        continue;
      }
      const rung = chosen[0];
      if (rung === undefined) {
        continue;
      }
      entries.push({ role, complexity, model: modelPart(rung) });
    }
  }

  return { registry, profile: { entries }, name };
}
