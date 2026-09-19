import type { Complexity } from "../orchestration/types";
import type { Profile, ProfileEntry, ProfileRole } from "../profiles/types";
import type {
  CredentialSource,
  RegistryConfig,
  ModelConfig as RegistryModelConfig,
  ProviderConfig as RegistryProviderConfig,
} from "../registry/types";
import { DEFAULT_CONTEXT_WINDOW } from "../registry/validate";
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
 * `maxTokens` is the per-completion OUTPUT ceiling a row may declare: a
 * declared value wins, and absence keeps the window default -- the model's
 * declared window (or the shared 200000 ceiling), the largest completion a
 * window that size can serve. It is not the budget, so defaulting to the
 * window is safe (the budget is derived separately from `contextWindow`).
 */
function toRegistryModel(name: string, model: ConfigModelConfig): RegistryModelConfig {
  return {
    name,
    modelId: name,
    maxTokens: model.maxTokens ?? model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    cost: {
      input: model.input,
      output: model.output,
      // cacheRead/cacheWrite are declared per-token cache prices, like
      // input/output in the file's declared unit. Absent settles at zero, the
      // only value not invented (a guessed nonzero rate would corrupt every
      // budget computed from it).
      cacheRead: model.cacheRead ?? 0,
      cacheWrite: model.cacheWrite ?? 0,
    },
    ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  };
}

/** The first declared model of `provider`, in source order; undefined when empty. */
function firstModel(provider: ConfigProviderConfig): ConfigModelConfig | undefined {
  return Object.values(provider.models)[0];
}

/**
 * Project one `models.yaml` provider into its registry declaration. Exported
 * for `auth`'s declared-provider resolution: `auth login --provider <id>` for a
 * non-built-in provider builds a single-provider `RegistryConfig` from exactly
 * the same projection routing uses, so a key names the same env-var and
 * endpoint whether it is being routed to or auth-managed.
 */
export function toRegistryProvider(
  id: string,
  provider: ConfigProviderConfig,
): RegistryProviderConfig {
  // CREDENTIAL PROJECTION (three cases). `credential` is a NAME -- the
  // env-var the resolver reads through its injected accessor -- never a value.
  // This boundary is where the string reference becomes the registry's
  // `{ kind: 'env-var', envVar }` shape, so `parseCredential` never sees an
  // undefined or a raw string.
  let credential: CredentialSource;
  if (provider.credential !== undefined) {
    credential = { kind: "env-var", envVar: provider.credential };
  } else {
    // Absent credential on an ENABLED provider (disabled providers are filtered
    // out upstream) is refused here, naming the provider only -- a NAME is an
    // identifier safe to echo; a value never appears anywhere.
    throw new ConfigError(
      "invalid_config",
      id,
      `provider "${id}" must declare a credential (an env-var NAME) to route through`,
    );
  }

  // ENDPOINT PROJECTION (D2). A provider-level baseUrl wins; otherwise the
  // first declared model's URL fills the provider slot, because the registry
  // validator runs `assertHttpsUrl(record.baseUrl)` unconditionally for a
  // hand-declared provider even when a model carries its own. An enabled
  // provider with NEITHER is refused here with a typed error naming the
  // provider -- the registry validator would otherwise throw on an undefined
  // baseUrl even when no model could be a fallback.
  const baseUrl = provider.baseUrl ?? firstModel(provider)?.baseUrl;
  if (baseUrl === undefined) {
    throw new ConfigError(
      "invalid_config",
      id,
      `provider "${id}" declares no baseUrl and no model supplies one; declare provider.baseUrl or a model baseUrl`,
    );
  }

  return {
    id,
    api: provider.api as RegistryProviderConfig["api"],
    baseUrl,
    credential,
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
