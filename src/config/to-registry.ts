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
import {
  type ModelConfig as ConfigModelConfig,
  type ProviderConfig as ConfigProviderConfig,
  type ModelRung,
  type ModelsConfig,
  OAUTH_CREDENTIAL,
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
 * The `provider:model` reference of a rung, for BOTH accepted rung forms (#477):
 * a bare string rung is the reference itself, a mapping rung carries it under
 * `model`. Every consumer that wants the model part must go through this, so a
 * ladder rung never has to be pattern-matched twice (or forgotten once).
 */
function refOf(rung: ModelRung): string {
  return typeof rung === "string" ? rung : rung.model;
}

/**
 * The declared thinking level of a rung, or undefined when it declares none.
 * The bare-string form declares none by construction; only the mapping form can
 * carry one, and this layer carries it verbatim -- the allow-list was already
 * enforced at the parsing boundary (`params/config` validate).
 */
function levelOf(rung: ModelRung): string | undefined {
  return typeof rung === "string" ? undefined : rung.thinkingLevel;
}

/**
 * One models.yaml model row as a registry model. `name` is the file's row key
 * -- the routing name every consumer addresses -- and `modelId` is the row's
 * declared `id`, defaulting to that key (#497). This layer derives no catalog
 * and no other alias, and the registry documents `name` defaulting to
 * `modelId`; here the DEFAULT runs the other way (the key is required, the id
 * optional), so a row declares an id only when the two differ.
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
    modelId: model.id ?? name,
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
  // CREDENTIAL PROJECTION (three cases). `credential` is normally a NAME -- the
  // env-var the resolver reads through its injected accessor -- never a value.
  // This boundary is where the string reference becomes the registry's
  // `{ kind: 'env-var', envVar }` shape, so `parseCredential` never sees an
  // undefined or a raw string.
  //
  // The literal `oauth` is the second, deliberate spelling (#503): codex is
  // OAuth-only and its token lives in the credential store under the provider
  // id, so no env-var names it. Without this case the YAML route could not
  // declare a codex provider at all -- the registry has always supported
  // `{ kind: 'oauth' }` (it is what the shipped `openaiCodexPreset()` carries),
  // and an id the operator cannot name in `models.yaml` is an id they cannot
  // route to from their own config file.
  let credential: CredentialSource;
  if (provider.credential === OAUTH_CREDENTIAL) {
    credential = { kind: "oauth" };
  } else if (provider.credential !== undefined) {
    credential = { kind: "env-var", envVar: provider.credential };
  } else {
    // Absent credential on an ENABLED provider (disabled providers are filtered
    // out upstream) is refused here, naming the provider only -- a NAME is an
    // identifier safe to echo; a value never appears anywhere.
    throw new ConfigError(
      "invalid_config",
      id,
      `provider "${id}" must declare a credential (an env-var NAME, or the literal "${OAUTH_CREDENTIAL}") to route through`,
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
 * The PROVIDER/MODEL PAIRS a `models.yaml` profile can serve, in the portable
 * shape the calibration layer scopes economics and capacity by (issue #506).
 *
 * A models profile is a routing source like an inventory: it names the models
 * a run may be routed to. The pairs are derived THE WAY THE RESOLVER DISPATCHES
 * -- each rung's model part, owned by whichever projected provider declares
 * that name -- so a calibration snapshot built from this can never scope
 * economics to a provider the profile cannot actually reach. A rung whose model
 * no enabled provider declares contributes nothing here; the resolver raises
 * `unknown_model` for it at run time, loudly, which is where that belongs.
 */
export function modelsProfileSource(
  config: ModelsConfig,
  profileName?: string,
): { name: string; providers: Array<{ id: string; models: string[] }> } {
  const { name, reachable } = toRegistryAndProfile(config, profileName);
  const byProvider = new Map<string, string[]>();
  for (const { provider, model } of reachable) {
    const models = byProvider.get(provider) ?? [];
    if (!models.includes(model)) models.push(model);
    byProvider.set(provider, models);
  }
  return { name, providers: [...byProvider].map(([id, models]) => ({ id, models })) };
}

/**
 * The pure projection of a validated `models.yaml` into the registry
 * declaration and a routing profile. No I/O, no mutation, and no error from
 * data content -- the input is already validated; the only failures are
 * "which profile" questions this function owns.
 *
 * `reachableProviders` is REQUIRED in the result (an added field must be
 * produced, never forgotten): the provider ids whose models the SELECTED
 * profile's rungs name. The resolver uses it as the credential-preflight
 * scope, so a foreign enabled provider without a key can never make an
 * unselected-from profile unresolvable (issue #414) -- the YAML mirror of the
 * JSON route's "no unselected profile reads credentials" per-profile-registry
 * rule. The registry stays FULL: every enabled provider is still projected
 * and registered (and still fails loudly on a missing credential/endpoint
 * declaration), only the KEY preflight narrows.
 *
 * `reachable` is the same walk one level finer -- the (provider, model) PAIRS,
 * in first-reached order, that `reachableProviders` is the projection of. The
 * calibration layer scopes a project snapshot's economics by exactly these
 * pairs (issue #506), so the pairs come from the walk that already exists
 * rather than from a second implementation of it.
 */
export function toRegistryAndProfile(
  config: ModelsConfig,
  profileName?: string,
): {
  registry: RegistryConfig;
  profile: Profile;
  name: string;
  reachableProviders: string[];
  reachable: Array<{ provider: string; model: string }>;
} {
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
  const bare = new Map<ProfileRole, ModelRung[]>();
  const overrides = new Map<ProfileRole, Partial<Record<Complexity, ModelRung[]>>>();
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

  // Reachability is computed THE WAY THE REGISTRY RESOLVES (security
  // mitigation for #414, Broken-Access-Control class): every rung of the
  // SELECTED profile's routes -- bare rows, role@complexity overrides and
  // every ladder rung, served or not -- contributes its MODEL part, and the
  // owner is whichever projected registry provider declares that model name
  // (names are globally unique). Never the rung's provider PREFIX: a prefix
  // can scroll past its declare-provider check in a hand-built config, while
  // the owner lookup is the same one the resolver's model index performs, so
  // a rung `foo:bar` whose model `bar` is registered under `baz` reaches
  // `baz` -- exactly what the registry will dispatch to. A model no provider
  // owns adds nothing; the resolver raises `unknown_model` there instead.
  const ownerOf = new Map<string, string>();
  for (const provider of registry.providers) {
    for (const model of provider.models ?? []) ownerOf.set(model.name, provider.id);
  }
  const reachable: Array<{ provider: string; model: string }> = [];
  const reached = new Set<string>();
  for (const ladder of Object.values(declared.routes)) {
    for (const rung of ladder) {
      const model = modelPart(refOf(rung));
      const owner = ownerOf.get(model);
      const pair = owner === undefined ? undefined : `${owner}\u0000${model}`;
      if (owner !== undefined && pair !== undefined && !reached.has(pair)) {
        reached.add(pair);
        reachable.push({ provider: owner, model });
      }
    }
  }
  const reachableProviders: string[] = [];
  for (const { provider } of reachable)
    if (!reachableProviders.includes(provider)) reachableProviders.push(provider);

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
      const level = levelOf(rung);
      entries.push({
        role,
        complexity,
        model: modelPart(refOf(rung)),
        ...(level !== undefined
          ? { thinkingLevel: level as NonNullable<ProfileEntry["thinkingLevel"]> }
          : {}),
      });
    }
  }

  return { registry, profile: { entries }, name, reachableProviders, reachable };
}
