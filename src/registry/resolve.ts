import * as crypto from "node:crypto";
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { RegistryError } from "./errors";
import type {
  ApiKind,
  RegistryConfig,
  ResolvedModelConfig,
  ResolvedProviderConfig,
  ResolvedRegistry,
} from "./types";
import { HEADER_PLACEHOLDER_PATTERN, parseRegistryConfig } from "./validate";

/**
 * How the resolver reads credentials from the harness environment. Injectable so
 * tests hand a fake accessor and nothing touches the real `process.env`; the
 * default reads `process.env` (the harness environment -- the ONLY credential
 * source; a target-dir dotenv is NEVER read).
 */
export interface ResolveOptions {
  env?: (name: string) => string | undefined;
  credentials?: CredentialStore;
  /**
   * Set of provider ids known to have a stored credential in the injected
   * `credentials` store. Absent = storage unavailable or unknowable (env-only
   * preflight, exactly as today); a foreign/injected store without a snapshot
   * stays env-only because its read is async and this resolver is sync. The
   * set is a claim about which ids MAY resolve a stored key, not a grant of
   * credential access -- the actual stored-key retrieval is still pi-ai's
   * `credentials.read(id)` against the injected store, so an id in the set
   * with nothing actually stored simply fails that read at request time.
   */
  storedCredentialIds?: ReadonlySet<string>;
  /**
   * Value for the `{{session}}` placeholder in declared headers. Defaults to a
   * fresh random identifier; injectable so a test asserts on a known value and
   * a caller that already owns a run identity can reuse it.
   */
  session?: string;
  /**
   * The provider ids that MUST pass the credential preflight (issue #414).
   * ABSENT = every provider is preflighted, the behaviour every existing
   * caller keeps (auth/preset/migrate/test sites). When PRESENT, a provider
   * OUTSIDE the set still registers normally -- `createProvider` reads no
   * key, and `envApiKeyAuth.resolve` returns undefined only at request time
   * -- but a missing key is NOT a `missing_credential` failure; a provider
   * INSIDE the set is preflighted exactly as today, fail-loud. The edge is
   * the YAML copy of the JSON route's rule "a profile that does not select a
   * provider does not read its credentials". The set carries ids only
   * (`Set.has` -- no credential value ever crosses), and the env var of an
   * out-of-set provider is NEVER read here: registration needs no key.
   */
  preflightCredentialIds?: ReadonlySet<string>;
}

type ProviderStreams = ReturnType<typeof openAICompletionsApi>;

/**
 * Turn declared `RegistryConfig` data plus the harness environment into a live
 * pi `Models` collection with a stable-name lookup.
 *
 * CREDENTIAL BOUNDARY. OpenRouter keys may resolve through the injected credential
 * store first, then the injected `env` accessor. Other env-var providers retain
 * their fail-fast environment-only contract.
 * The pi `AuthContext` handed to `createModels` routes `env(name)` to that same
 * injected accessor and returns `Promise<false>` from `fileExists`, so pi
 * cannot fall back to a stored credential FILE or an ambient dotenv -- the
 * accessor is the whole surface. `envApiKeyAuth.resolve` reads through
 * `ctx.env` (verified against the installed pi-ai source), so what pi actually
 * transmits and what the preflight below checks are the SAME value.
 *
 * FAIL-LOUD credential check. `envApiKeyAuth.resolve` returns `undefined` (it
 * does NOT throw) on a missing key, which would surface only later as a runtime
 * stream failure. So the load-bearing check is the preflight here: an env-var
 * provider whose key is unset/empty throws `RegistryError('missing_credential',
 * <NAME>)` naming ONLY the variable, never a value.
 *
 * OAUTH DELEGATION. The codex provider is OAuth-only. Any `oauth`-kind provider
 * is delegated to the shipped `openaiCodexProvider()` factory (fixed baseUrl,
 * no token handling here); its declared `baseUrl`/`api` are deliberately
 * IGNORED. In this first cut `oauth` == codex: the union carries no provider
 * binding, so a non-codex provider declaring `oauth` would still resolve as
 * codex -- acceptable because codex is the only shipped oauth preset and its
 * baseUrl is fixed, but noted so a future second oauth provider adds a binding.
 */
export function resolveRegistry(
  config: RegistryConfig,
  options?: ResolveOptions,
): ResolvedRegistry {
  // ALWAYS re-validate: never trust a hand-built config, even one that skipped
  // parseRegistryConfig on the way in (security review: re-validate at the sink).
  const validated = parseRegistryConfig(config);

  const readEnv = options?.env ?? ((name: string) => process.env[name]);

  // One opaque marker per resolved registry: see expandHeaderValue.
  const session = options?.session ?? crypto.randomUUID();

  const models = createModels({
    ...(options?.credentials !== undefined && { credentials: options.credentials }),
    authContext: {
      env: async (name: string) => readEnv(name),
      fileExists: async () => false,
    },
  });

  // name -> the pi (providerId, modelId) pair getModel resolves against.
  const index = new Map<
    string,
    { providerId: string; modelId: string; config: ResolvedModelConfig }
  >();

  for (const provider of validated.providers) {
    const registeredId = registerProvider(
      provider,
      models,
      readEnv,
      options?.credentials !== undefined,
      options?.storedCredentialIds,
      // The preflight scope (`undefined` = preflight every provider).
      options?.preflightCredentialIds,
      session,
    );
    for (const model of provider.models) {
      index.set(model.name, { providerId: registeredId, modelId: model.modelId, config: model });
    }
  }

  const getModel = (name: string): Model<Api> => {
    const entry = index.get(name);
    if (entry === undefined) {
      throw new RegistryError("unknown_model", name, `no model named "${name}" is registered`);
    }
    const model = models.getModel(entry.providerId, entry.modelId);
    if (model === undefined) {
      throw new RegistryError(
        "unknown_model",
        name,
        `model "${name}" maps to provider "${entry.providerId}" model "${entry.modelId}", which the provider does not expose`,
      );
    }
    // Declared registry data is authoritative even for delegated OAuth catalogs.
    // A fresh object avoids mutating pi-ai's shared provider catalog.
    return {
      ...model,
      contextWindow: entry.config.contextWindow,
      maxTokens: entry.config.maxTokens,
      ...(entry.config.input !== undefined && { input: [...entry.config.input] }),
    };
  };

  return {
    models,
    getModel,
    lookup: (name: string) => ({ models, model: getModel(name) }),
  };
}

/** Register one config provider into `models`, returning the pi provider id it was registered under. */
function registerProvider(
  provider: ResolvedProviderConfig,
  models: ReturnType<typeof createModels>,
  readEnv: (name: string) => string | undefined,
  hasCredentialStore: boolean,
  storedCredentialIds: ReadonlySet<string> | undefined,
  preflightCredentialIds: ReadonlySet<string> | undefined,
  session: string,
): string {
  if (provider.credential.kind === "oauth") {
    const codex = openaiCodexProvider();
    models.setProvider(codex);
    return codex.id;
  }

  const envVar = provider.credential.envVar;
  // PREFLIGHT SCOPE (issue #414). `undefined` means preflight every provider
  // (long-standing behaviour); a passed set preflights only its members. For
  // an out-of-set provider the env accessor is NOT queried at all --
  // registration needs no key, so no secret is even touched here -- and a
  // missing key surfaces only when a route actually dispatches (pi-ai's
  // undefined `resolve`). In-set providers keep the fail-loud preflight whose
  // error names only the variable, never a value.
  const preflight = preflightCredentialIds === undefined || preflightCredentialIds.has(provider.id);
  // The knowledge set is the gate; `hasCredentialStore` only guards that the
  // set speaks about the injected store (a store without a snapshot must not
  // widen admission, and `undefined && ...` keeps the env-only preflight). An
  // id in the set MAY resolve a stored key -- pi-ai's envApiKeyAuth.resolve
  // still reads the real injected store, so a spoofed id with nothing stored
  // simply fails that read. An OR here would make ANY injected store admit
  // EVERY env-var provider and silently kill this preflight.
  const canUseStoredCredential =
    hasCredentialStore && storedCredentialIds?.has(provider.id) === true;
  // Env access happens ONLY for a provider that is being preflighted without
  // stored-key admission: an out-of-set provider never touches `readEnv`, and
  // a set member admitted through the store does not need the env either.
  const envKey = preflight && !canUseStoredCredential ? readEnv(envVar) : undefined;
  if (preflight && !canUseStoredCredential && (envKey === undefined || envKey === "")) {
    // Load-bearing: envApiKeyAuth.resolve returns undefined (not throw) on a
    // missing key, so without this preflight a missing key would surface only as
    // a later stream failure, not a typed missing_credential naming the var.
    throw new RegistryError(
      "missing_credential",
      envVar,
      `credential for provider "${provider.id}" is not stored and environment variable "${envVar}" is not set`,
    );
  }

  const displayName = provider.displayName ?? provider.id;
  const built = createProvider({
    id: provider.id,
    name: displayName,
    baseUrl: provider.baseUrl,
    ...(provider.headers !== undefined && {
      headers: Object.fromEntries(
        Object.entries(provider.headers).map(([name, value]) => [
          name,
          expandHeaderValue(value, session),
        ]),
      ),
    }),
    auth: { apiKey: envApiKeyAuth(displayName, [envVar]) },
    models: provider.models.map((model) => toPiModel(model, provider, session)),
    api: buildApi(provider),
  });
  models.setProvider(built);
  return provider.id;
}

/**
 * Expand the `{{...}}` placeholders a declared header value may contain.
 *
 * WHY THE RESOLVER OWNS THIS. A run-scoped routing marker is exactly the value
 * a config file cannot hold: it must differ per run, and writing it down would
 * make it a constant. The validator has already rejected every token this
 * function does not know, so an unexpanded `{{...}}` can never reach the wire.
 *
 * The identifier is opaque and carries no credential, project path or user
 * data: it is random per resolved registry, so a provider can group one run's
 * requests and learn nothing else. Every header of every model in one resolved
 * registry shares it, which is what makes it a *run* marker rather than a
 * per-request nonce.
 */
function expandHeaderValue(value: string, session: string): string {
  return value.replace(HEADER_PLACEHOLDER_PATTERN, (match, token: string) =>
    token === "session" ? session : match,
  );
}

/**
 * Merge declared provider headers with per-model overrides.
 *
 * WHY PER MODEL. `createProvider` accepts a provider-level `headers` option and
 * stores it on the provider object, but that value never reaches request
 * dispatch: `Models.applyAuth` merges only the resolved auth headers with the
 * caller's per-request headers, and both stream adapters read `model.headers`
 * (`openai-completions` merges it into the client's default headers;
 * `anthropic-messages` passes it to `mergeClientHeaders`). So declared headers
 * are flattened onto every model here. They are ALSO passed to
 * `createProvider` so the provider object reports what it sends.
 *
 * Model entries win over provider entries on a case-insensitive name match, so
 * a per-model override replaces rather than duplicates the provider's value.
 */
function mergeDeclaredHeaders(
  provider: ResolvedProviderConfig,
  model: ResolvedModelConfig,
  session: string,
): Record<string, string> | undefined {
  if (provider.headers === undefined && model.headers === undefined) return undefined;
  const merged: Record<string, string> = { ...provider.headers };
  if (model.headers !== undefined) {
    const overridden = new Set(Object.keys(model.headers).map((name) => name.toLowerCase()));
    for (const name of Object.keys(merged)) {
      if (overridden.has(name.toLowerCase())) delete merged[name];
    }
    Object.assign(merged, model.headers);
  }
  for (const [name, value] of Object.entries(merged)) {
    merged[name] = expandHeaderValue(value, session);
  }
  return merged;
}

/** Map a declared ModelConfig onto a pi `Model<Api>`, filling only the fields the registry declares. */
function toPiModel(
  model: ResolvedModelConfig,
  provider: ResolvedProviderConfig,
  session: string,
): Model<Api> {
  const api: Api = model.api ?? provider.api;
  const headers = mergeDeclaredHeaders(provider, model, session);
  return {
    id: model.modelId,
    name: model.name,
    api,
    provider: provider.id,
    baseUrl: model.baseUrl ?? provider.baseUrl,
    ...(headers !== undefined && { headers }),
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // Catalog facts, forwarded together on purpose: the adapters read
    // `thinkingLevelMap` only from inside a `compat.thinkingFormat` branch, so
    // the map without the compat that selects the branch is inert. Operator
    // `compat` is NOT forwarded (see the validator) -- only this pair, which
    // originates in the pinned dependency.
    ...(model.thinkingLevelMap !== undefined && { thinkingLevelMap: model.thinkingLevelMap }),
    ...(model.catalogCompat !== undefined && {
      compat: model.catalogCompat as NonNullable<Model<Api>["compat"]>,
    }),
  };
}

/**
 * Build the `api` argument for `createProvider`: a single `ProviderStreams` when
 * every model shares the provider api, or a map keyed by `model.api` for a
 * dual-api provider (openrouter). An env-var provider that declares
 * `openai-codex-responses` (which has no non-oauth stream factory) is rejected
 * with `unsupported_api`.
 */
function buildApi(
  provider: ResolvedProviderConfig,
): ProviderStreams | Partial<Record<Api, ProviderStreams>> {
  const kinds = new Set<ApiKind>([provider.api]);
  for (const model of provider.models) {
    if (model.api !== undefined) {
      kinds.add(model.api);
    }
  }
  if (kinds.size === 1) {
    return apiFactory(provider.api, provider.id);
  }
  const map: Record<string, ProviderStreams> = {};
  for (const kind of kinds) {
    map[kind] = apiFactory(kind, provider.id);
  }
  return map;
}

function apiFactory(kind: ApiKind, providerId: string): ProviderStreams {
  switch (kind) {
    case "openai-completions":
      return openAICompletionsApi();
    case "anthropic-messages":
      return anthropicMessagesApi();
    default:
      // openai-codex-responses reaches here only for an env-var provider; codex
      // is OAuth-only and has no createProvider stream factory in this module.
      throw new RegistryError(
        "unsupported_api",
        providerId,
        `api "${kind}" cannot be resolved for an env-var provider; codex-responses is OAuth-only`,
      );
  }
}
