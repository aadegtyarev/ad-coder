import type { Api, Model, Models } from "@earendil-works/pi-ai";

/**
 * The three request-shaping APIs this registry can resolve.
 *
 * A deliberately NARROW subset of pi-ai's open `Api` union: these are the only
 * kinds the resolver knows how to construct a provider for. `openai-completions`
 * and `anthropic-messages` are built here via `createProvider`;
 * `openai-codex-responses` is reachable ONLY through the delegated
 * `openaiCodexProvider()` factory (codex is OAuth-only), never via
 * `createProvider` in this module. Keeping the set closed is what lets the
 * validator reject an unknown api rather than passing an arbitrary string into
 * provider construction.
 */
export type ApiKind = "openai-completions" | "anthropic-messages" | "openai-codex-responses";

/**
 * One model as plain declared data, carrying EXACTLY the fields
 * `deriveCapabilities` consumes off a pi `Model<Api>` plus a stable registry
 * lookup key.
 *
 * `name` is the registry-scoped lookup key (globally unique across ALL
 * providers) that `ResolvedRegistry.lookup`/`getModel` resolve by; `modelId` is
 * the provider-native model id passed to pi. They are separate because one
 * provider-native id may be surfaced under a friendlier stable name, and because
 * the codex delegation resolves `modelId` against the factory's own catalog.
 *
 * `api` is an OPTIONAL per-model override for dual-api providers (openrouter
 * fronts both openai-completions and anthropic-messages); absent, the model
 * inherits the provider's `api`. `compat` is deliberately typed `unknown` and,
 * per the validator's contract, is NOT forwarded into provider construction in
 * this first cut -- see `parseRegistryConfig` for why that pass-through is safe.
 */
export interface ModelConfig {
  name: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  api?: ApiKind;
  compat?: unknown;
}

/**
 * Where a provider's credential comes from.
 *
 * `env-var` names a process-environment variable (a NAME, never a value) the
 * resolver reads through its injected accessor. `oauth` carries NO binding on
 * purpose: it is the codex-only marker, and the resolver delegates any
 * `oauth`-kind provider to the shipped `openaiCodexProvider()` factory rather
 * than handling tokens here. See `resolveRegistry` for the oauth==codex
 * assumption this union encodes.
 */
export type CredentialSource = { kind: "env-var"; envVar: string } | { kind: "oauth" };

/**
 * A provider as plain declared data: an id, its request API, the credential
 * SOURCE, an https base URL, and its models. `displayName` is a human label
 * (defaults to `id`). This is the second-from-bottom layer of the settled
 * config model; the role/profile layers sit on top of the resolved form.
 */
export interface ProviderConfig {
  id: string;
  displayName?: string;
  api: ApiKind;
  baseUrl: string;
  credential: CredentialSource;
  models: ModelConfig[];
}

/** The whole declared registry: a non-empty list of providers. */
export interface RegistryConfig {
  providers: ProviderConfig[];
}

/**
 * The resolved registry: a live pi `Models` collection plus a stable-name
 * lookup. `lookup(name)` returns the `{ models, model }` shape `runRole`
 * consumes directly; `getModel(name)` is the model-only convenience. Both throw
 * `RegistryError('unknown_model', name)` when the name is not registered.
 */
export interface ResolvedRegistry {
  models: Models;
  getModel(name: string): Model<Api>;
  lookup(name: string): { models: Models; model: Model<Api> };
}
