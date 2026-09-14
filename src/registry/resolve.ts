import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { RegistryError } from "./errors";
import type {
  ApiKind,
  ModelConfig,
  ProviderConfig,
  RegistryConfig,
  ResolvedRegistry,
} from "./types";
import { parseRegistryConfig } from "./validate";

/**
 * How the resolver reads credentials from the harness environment. Injectable so
 * tests hand a fake accessor and nothing touches the real `process.env`; the
 * default reads `process.env` (the harness environment -- the ONLY credential
 * source; a target-dir dotenv is NEVER read).
 */
export interface ResolveOptions {
  env?: (name: string) => string | undefined;
  credentials?: CredentialStore;
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

  const models = createModels({
    ...(options?.credentials !== undefined && { credentials: options.credentials }),
    authContext: {
      env: async (name: string) => readEnv(name),
      fileExists: async () => false,
    },
  });

  // name -> the pi (providerId, modelId) pair getModel resolves against.
  const index = new Map<string, { providerId: string; modelId: string; config: ModelConfig }>();

  for (const provider of validated.providers) {
    const registeredId = registerProvider(
      provider,
      models,
      readEnv,
      options?.credentials !== undefined,
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
      contextWindow: entry.config.contextWindow ?? 200_000,
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
  provider: ProviderConfig,
  models: ReturnType<typeof createModels>,
  readEnv: (name: string) => string | undefined,
  hasCredentialStore: boolean,
): string {
  if (provider.credential.kind === "oauth") {
    const codex = openaiCodexProvider();
    models.setProvider(codex);
    return codex.id;
  }

  const envVar = provider.credential.envVar;
  const key = readEnv(envVar);
  const canUseStoredCredential = hasCredentialStore && provider.id === "openrouter";
  if ((key === undefined || key === "") && !canUseStoredCredential) {
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
    auth: { apiKey: envApiKeyAuth(displayName, [envVar]) },
    models: provider.models.map((model) => toPiModel(model, provider)),
    api: buildApi(provider),
  });
  models.setProvider(built);
  return provider.id;
}

/** Map a declared ModelConfig onto a pi `Model<Api>`, filling only the fields the registry declares. */
function toPiModel(model: ModelConfig, provider: ProviderConfig): Model<Api> {
  const api: Api = model.api ?? provider.api;
  return {
    id: model.modelId,
    name: model.name,
    api,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow ?? 200_000,
    maxTokens: model.maxTokens,
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
  provider: ProviderConfig,
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
