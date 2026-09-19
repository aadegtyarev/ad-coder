/**
 * The two operator-edited config documents under
 * `(XDG_CONFIG_HOME ?? ~/.config)/ad-coder`, as validated plain data.
 *
 * `models.yaml` declares the providers the harness may call and the role
 * routing profiles that name them; `settings.yaml` carries review policy and
 * provider-admission limits. Both are turned into these shapes by
 * `parseModelsConfig`/`parseSettingsConfig` BEFORE anything reads a field, so
 * no consumer ever handles an unvalidated value: an unknown provider or an
 * off-vocabulary role is refused at the boundary instead of becoming a lookup
 * miss three layers down.
 *
 * These types carry NAMES only -- a provider name, a model name, a credential
 * REFERENCE, a `provider:model` rung. No credential value is ever a field here,
 * which is what keeps a `ConfigError` safe to paste into a bug report.
 */

/**
 * One model's settings in `models.yaml`.
 *
 * `input`/`output` are the declared prices, required: a model row without a
 * price is a cost the ledger cannot attribute, and defaulting it to zero would
 * report a paid model as free. The unit is whatever the file declares -- this
 * layer carries the number, it does not define a currency.
 *
 * `cacheRead`/`cacheWrite` are the declared per-token cache prices, like
 * `input`/`output`: the unit is whatever the file declares -- this layer
 * carries the number, it does not define a currency. They are optional, and
 * absent settles at zero in the registry projection -- the only value not
 * invented (a guessed nonzero rate would corrupt every budget computed from
 * it).
 *
 * `maxTokens` is the per-completion OUTPUT ceiling, distinct from the
 * `contextWindow` budget (which bounds prompt plus completion together). A
 * declared value wins in the projection; absent keeps the projection's window
 * default, because inventing a smaller ceiling would be a guess.
 *
 * `concurrency` is the one setting a provider also declares: the provider's
 * value is the default, a model's value narrows it. `baseUrl` is the other
 * provider-declares/model-narrows pair: a provider's `baseUrl` is its default
 * endpoint, a model's narrows it to an ENDPOINT variant. `contextWindow`,
 * `tools` and `format` stay model-only, because they describe an endpoint
 * variant rather than a whole provider (`tools: false` on a provider would
 * silently strip tools from a model that does support them).
 */
export interface ModelConfig {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  maxTokens?: number;
  baseUrl?: string;
  contextWindow?: number;
  tools?: boolean;
  format?: string;
  concurrency?: number;
}

/**
 * One provider in `models.yaml`.
 *
 * `enabled: false` keeps a declared provider and its model list out of routing
 * without deleting the credential reference or the prices, so an operator can
 * flip a provider back on without a diff of names to re-derive.
 *
 * `models` may be empty: a disabled provider is allowed to declare no models
 * yet. An enabled provider with no models routes nothing, which every row that
 * names it reports as `unknown_model`.
 */
export interface ProviderConfig {
  enabled: boolean;
  api?: string;
  /**
   * The provider's https endpoint. OPTIONAL: a model may carry its own
   * `baseUrl`, and the projection resolves the first declared model's URL as
   * the provider-level default (mirroring the registry's own "first model's
   * URL is the honest default" fallback). https enforcement stays the registry
   * validator's job, not this layer's.
   */
  baseUrl?: string;
  credential?: string;
  concurrency?: number;
  headers?: Record<string, string>;
  models: Record<string, ModelConfig>;
}

/**
 * One rung of a fallback ladder: `provider:model`, both declared in
 * `providers`. The provider name cannot contain `:`; everything after the FIRST
 * colon is the model name verbatim, so a model name that itself contains one
 * (a tag, a variant) survives the split.
 */
export type ModelRef = string;

/**
 * A row's ordered fallback ladder. Index 0 is the preferred rung; a consumer
 * walks the list in order and takes the first rung it can actually serve. A
 * single string in the file becomes a one-rung ladder, so a consumer never
 * branches on "string or list" -- that ambiguity is resolved once, here.
 */
export type ModelLadder = readonly ModelRef[];

/**
 * One profile: its name and its rows.
 *
 * A row key is canonical -- the bare role (`coder`) or the tier override
 * (`coder@complex`). A `role@complexity` row REPLACES the bare row for that
 * tier; it does not merge, and it may not exist without the bare row to fall
 * back on for the other tiers.
 *
 * The key stays a string because that is what a caller holds when it resolves
 * a `(role, complexity)`: `routes[`${role}@${complexity}`] ?? routes[role]`.
 * Re-deriving the pair from a structured key costs the same and can disagree
 * with the key the file actually declares.
 */
export interface ConfigProfile {
  name: string;
  routes: Record<string, ModelLadder>;
}

/**
 * The validated whole of `models.yaml`.
 *
 * `defaultProfile` is ABSENT, not empty, when the file declares no `default`:
 * exactOptionalPropertyTypes makes that distinction real, and a caller reads
 * "no default configured" instead of a named profile that is not there.
 */
export interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
  defaultProfile?: string;
  profiles: Record<string, ConfigProfile>;
}

/**
 * `settings.yaml`'s `provider-admission` section: the operator's overrides for
 * the shared provider-capacity boundary (issue #365). Every field is optional;
 * an absent field leaves the module's finite default standing. Per the numeric
 * resource-limit convention (docs/contracts/config.md), the limits are
 * non-negative integers and a configured `0` DISABLES — for admission that is
 * the whole boundary: `max-concurrent-per-scope: 0` means pass-through, no
 * controller is constructed, and the `0` never reaches the module's
 * constructor (which refuses it). Admission ships ENABLED, so an absent
 * section is the enabled state with module defaults, not a silent off.
 */
export interface ProviderAdmissionSettings {
  /** 0 disables admission entirely; a positive integer overrides the default cap. */
  maxConcurrentPerScope?: number;
  queueCapacityPerScope?: number;
  maxWaitMs?: number;
  retryDelayMs?: number;
  cooldownMaxMs?: number;
}

/**
 * `settings.yaml`'s `review.require-stamp`: whether the review stamp is
 * demanded of a pipeline run. `auto` is the default and means the harness
 * decides per run; `on` and `off` are the operator forcing that decision.
 *
 * These three tokens are strings, not booleans: the `yaml` package implements
 * the YAML 1.2 core schema, where `on`/`off` stay strings (YAML 1.1 would have
 * read them as `true`/`false`). This module does not accept `yes`/`true` as a
 * spelling of `on` -- the vocabulary is exactly what the file documents.
 */
export type StampRequirement = "auto" | "on" | "off";

/** `settings.yaml`'s `review` section, with its documented defaults filled in. */
export interface ReviewSettings {
  requireStamp: StampRequirement;
  costSignature: boolean;
}

/**
 * The validated whole of `settings.yaml`: always fully populated, so a caller
 * reads a policy rather than re-implementing the defaults. A malformed value is
 * refused, never corrected -- only an ABSENT key gets its default.
 */
export interface SettingsConfig {
  review: ReviewSettings;
  /** Absent section resolves to the enabled default with the module's finite defaults. */
  providerAdmission: ProviderAdmissionSettings;
}
