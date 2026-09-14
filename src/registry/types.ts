import type { Api, Model, Models, ThinkingLevelMap } from "@earendil-works/pi-ai";

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
  /** Defaults to `modelId` when omitted; a short alias the routing profile uses. */
  name: string;
  modelId: string;
  /**
   * Defaults to 200000 for a hand-declared model. A catalog-backed model
   * inherits the catalog value, and an explicit number overrides it.
   */
  contextWindow?: number;
  /** Required unless the provider declares a `catalog` that supplies it. */
  maxTokens?: number;
  reasoning?: boolean;
  /** Accepted input modalities; defaults to text-only for custom providers. */
  input?: ("text" | "image")[];
  /** Required unless the provider declares a `catalog` that supplies it. */
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  api?: ApiKind;
  /**
   * Set to `false` to admit this model even though the provider's `catalog`
   * does not publish it, supplying `cost` and `maxTokens` by hand.
   *
   * WHY AN EXPLICIT OPT-OUT. Some ids exist only in the operator's own account
   * -- an OpenRouter `@preset/...` routes through their saved provider
   * preferences, so no static catalog can know it or its price. Silently
   * accepting any unlisted id would give a typo the same treatment, resolving
   * it with whatever numbers were typed next to it; requiring the marker keeps
   * the hand-written exception deliberate and keeps the typo an error.
   */
  catalog?: false;
  /**
   * Per-model override of the provider `baseUrl`. Needed when one account
   * fronts two request APIs under different path prefixes, because pi's
   * adapters append their own suffix to whatever `baseUrl` they are handed.
   * Same https-only validation as the provider field.
   */
  baseUrl?: string;
  /**
   * Per-model request headers, merged OVER the provider's declared headers.
   * Same non-secret contract as `ProviderConfig.headers`.
   */
  headers?: Record<string, string>;
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
  /**
   * Required for a hand-declared provider. Optional when `catalog` is set,
   * because each catalog model carries its own base URL -- which is how one
   * account can front two request APIs under different path prefixes.
   */
  baseUrl?: string;
  credential: CredentialSource;
  /**
   * Take model facts -- ids, prices, context windows, token ceilings, base URLs
   * and thinking-level support -- from a named pi-ai built-in catalog instead of
   * restating them here. A hand-written price list silently goes stale as
   * providers change them, and a stale price corrupts every routing and budget
   * decision made from it; the catalog moves with the dependency.
   *
   * With a catalog, `models` becomes an optional FILTER: list the ids to admit
   * (optionally under a short `name` the routing profile uses), or omit it to
   * admit the whole catalog. Any field declared on a model entry still wins, so
   * a value the catalog cannot know -- an account-specific alias, a negotiated
   * price -- remains declarable. A model id absent from the named catalog is
   * rejected rather than resolved with invented economics.
   */
  catalog?: string;
  /**
   * Static request headers every model of this provider sends, for APIs that
   * mandate a non-auth header (a routing or tenancy marker, an API version).
   *
   * NOT A CREDENTIAL CHANNEL. Values are literal config text and are the one
   * part of a registry config that is transmitted verbatim to the provider, so
   * the validator rejects any name that would carry or displace authentication
   * (`authorization`, `x-api-key`, `cookie`, ...): a key belongs in
   * `credential`, whose value the resolver never places in a config file.
   * Headers pi-ai owns (`user-agent`, `content-type`, ...) are likewise
   * rejected rather than silently losing to the adapter's own value.
   *
   * Per-request values a config file cannot know (a run-scoped session id) are
   * derived by the resolver, not declared here.
   */
  headers?: Record<string, string>;
  /** Required for a hand-declared provider; an optional filter under `catalog`. */
  models?: ModelConfig[];
}

/** The whole declared registry: a non-empty list of providers. */
export interface RegistryConfig {
  providers: ProviderConfig[];
}

/**
 * One model after validation, with every field the resolver needs present.
 *
 * WHY A SECOND TYPE. `ModelConfig` is what an operator WRITES, where a catalog
 * makes `cost` and `maxTokens` redundant; this is what the validator RETURNS,
 * where they are settled facts. Keeping them apart is what lets the compiler
 * prove the resolver never reads a price that was never supplied -- the failure
 * a single permissive type would hide until a budget computed `undefined`.
 */
export interface ResolvedModelConfig extends ModelConfig {
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /**
   * Catalog-supplied mapping from pi thinking levels to this model's own
   * values, where `null` marks a level the model does NOT support.
   *
   * Present only for a catalog-backed model: it is a fact about the model that
   * no config file can be expected to restate correctly. Without it the
   * adapter forwards a requested level verbatim, so a routing profile asking
   * for a level the model rejects produces an opaque provider error instead of
   * the model's documented fallback.
   */
  thinkingLevelMap?: ThinkingLevelMap;
  /**
   * Catalog-supplied request-shaping overrides, forwarded to pi-ai.
   *
   * Deliberately a DIFFERENT field from the operator-declared `compat`, which
   * stays inert. This one originates in the pinned dependency rather than in
   * config text, and it is load-bearing: `thinkingLevelMap` is consulted only
   * inside a `compat.thinkingFormat` branch of the adapters, so forwarding the
   * map without this would silently do nothing.
   */
  catalogCompat?: unknown;
}

/** One provider after validation: a settled base URL and fully-specified models. */
export interface ResolvedProviderConfig extends ProviderConfig {
  baseUrl: string;
  models: ResolvedModelConfig[];
}

/** The validated registry the resolver consumes. See `ResolvedModelConfig`. */
export interface ResolvedRegistryConfig extends RegistryConfig {
  providers: ResolvedProviderConfig[];
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
