import type { Complexity } from "../orchestration/types";
import type { ProfileRole } from "../profiles/types";
import { PROFILE_ROLES } from "../profiles/validate";
import { ConfigError } from "./errors";
import type {
  ConfigProfile,
  ModelConfig,
  ModelLadder,
  ModelsConfig,
  ProviderConfig,
  SettingsConfig,
  StampRequirement,
} from "./types";

/**
 * Mirrors the private list `profiles/validate.ts` keeps. Re-exporting theirs
 * would make an internal detail load-bearing; importing the `Complexity` TYPE
 * and listing the tokens keeps this module's vocabulary pinned to the same
 * union the compiler checks. A tier added to `Complexity` without a token here
 * fails typechecking on this line.
 */
const COMPLEXITIES: readonly Complexity[] = ["trivial", "medium", "complex"];

const MODELS_KEYS = new Set(["providers", "default", "profiles"]);
const PROVIDER_KEYS = new Set([
  "enabled",
  "api",
  "baseUrl",
  "credential",
  "concurrency",
  "headers",
  "models",
]);
const MODEL_KEYS = new Set([
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "maxTokens",
  "baseUrl",
  "contextWindow",
  "tools",
  "format",
  "concurrency",
]);
const SETTINGS_KEYS = new Set(["review"]);
const REVIEW_KEYS = new Set(["require-stamp", "cost-signature"]);
const STAMP_REQUIREMENTS: readonly StampRequirement[] = ["auto", "on", "off"];

type Bad = (code: ConfigError["code"], detail: string, message: string) => never;

/**
 * Strictly validate untrusted, plain-data input into a `ModelsConfig`.
 *
 * Pure, hand-written, fail-loud -- mirrors `parseRegistryConfig`/`parseProfile`:
 * no schema library, no silent coercion, no defaulting a bad value. `value` is
 * whatever the YAML document reduced to (a caller passes the `Document`'s plain
 * data, so comments and ordering stay the store's business), and it must be a
 * map with a non-empty `providers` map, a non-empty `profiles` map, and an
 * optional `default` naming a declared profile.
 *
 * UNKNOWN KEYS ARE REFUSED, at the top level and inside a provider and a model.
 * A hand-edited file is where a typo lives, and `contextwindow: 200000` next to
 * `contextWindow: 200000` is not a value the operator gets told about by any
 * later layer -- it is silently inert, forever. The settings the format does
 * NOT allow on a provider but does allow on a model (`contextWindow`, `tools`,
 * `format`, the cache prices `cacheRead`/`cacheWrite`, `maxTokens`) are
 * refused there for the same reason; widening the
 * provider shape is an additive change here plus in `config/types.ts`, not a
 * key quietly ignored today. `baseUrl` IS a provider key (a provider endpoint
 * default, narrowable per model).
 *
 * Cross-file rules all live here rather than in a consumer, because a consumer
 * only learns which providers and models exist after a row has already chosen
 * one:
 *
 * - a rung naming an undeclared provider is refused;
 * - a rung naming a model its provider does not declare is refused;
 * - a `role@complexity` row with no bare row for that same role is refused --
 *   a tier row REPLACES the bare row, so without the bare row every other tier
 *   would resolve to nothing, which reads as "the harness ignored my role";
 * - an unknown role is refused against `PROFILE_ROLES`, the one live list;
 * - an unknown complexity tier is refused.
 *
 * Every deviation throws a typed `ConfigError` whose `detail` names ONLY the
 * offending provider/model/profile/role/complexity token or field path -- never
 * a value, never a credential, never a header value, never config content.
 */
export function parseModelsConfig(value: unknown): ModelsConfig {
  const bad = reporter("models.yaml");

  if (!isObject(value)) {
    bad("invalid_config", "document", "must be a map with `providers` and `profiles`");
  }
  const document = value as Record<string, unknown>;
  refuseUnknownKeys(document, MODELS_KEYS, "", bad, "top-level");

  const rawProviders = document.providers;
  if (!isObject(rawProviders) || Object.keys(rawProviders).length === 0) {
    bad(
      "invalid_config",
      "providers",
      "`providers` must be a non-empty map of provider name to provider settings",
    );
  }
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, rawProvider] of Object.entries(rawProviders as Record<string, unknown>)) {
    providers[name] = parseProvider(name, rawProvider, bad);
  }

  const rawProfiles = document.profiles;
  if (!isObject(rawProfiles) || Object.keys(rawProfiles).length === 0) {
    bad(
      "invalid_config",
      "profiles",
      "`profiles` must be a non-empty map of profile name to role rows",
    );
  }
  const profiles: Record<string, ConfigProfile> = {};
  for (const [name, rawProfile] of Object.entries(rawProfiles as Record<string, unknown>)) {
    profiles[name] = parseProfile(name, rawProfile, providers, bad);
  }

  const defaultProfile = document.default;
  if (defaultProfile !== undefined) {
    if (typeof defaultProfile !== "string" || defaultProfile.length === 0) {
      bad("invalid_config", "default", "`default` must be a non-empty profile name");
    }
    if (!Object.hasOwn(profiles, defaultProfile as string)) {
      bad(
        "unknown_profile",
        defaultProfile as string,
        `\`default\` names profile "${String(defaultProfile)}", which \`profiles\` does not declare`,
      );
    }
  }

  return {
    providers,
    ...(defaultProfile !== undefined ? { defaultProfile: defaultProfile as string } : {}),
    profiles,
  };
}

/**
 * Strictly validate untrusted, plain-data input into a `SettingsConfig`.
 *
 * A SEPARATE parser for a SEPARATE file: `review` is the whole vocabulary, and
 * a `models.yaml` key appearing here is refused rather than ignored.
 *
 * This is the one layer where an absent key is allowed to take its default --
 * `review.require-stamp` defaults to `auto`, `review.cost-signature` to `false`
 * -- because the file documents that default as the meaning of absence. A
 * PRESENT key is still validated strictly: `require-stamp: maybe` is refused,
 * never read as `auto`.
 *
 * An empty file is refused rather than read as "all defaults": a document that
 * reduced to nothing is far more likely to be a truncated write than an
 * operator's intent, and accepting it would turn a `require-stamp: on` into
 * `auto` without a word. An ABSENT FILE is the defaults case, and that is the
 * store's decision to make, not this parser's.
 */
export function parseSettingsConfig(value: unknown): SettingsConfig {
  const bad = reporter("settings.yaml");

  if (!isObject(value)) {
    bad(
      "invalid_config",
      "document",
      "must be a map with a `review` section (an empty file carries no settings; write `{}` or remove it)",
    );
  }
  const document = value as Record<string, unknown>;
  refuseUnknownKeys(document, SETTINGS_KEYS, "", bad, "top-level");

  const rawReview = document.review;
  if (rawReview === undefined) {
    return { review: { requireStamp: "auto", costSignature: false } };
  }
  if (!isObject(rawReview)) {
    bad("invalid_config", "review", "`review` must be a map");
  }
  const review = rawReview as Record<string, unknown>;
  refuseUnknownKeys(review, REVIEW_KEYS, "review", bad, "review");

  let requireStamp: StampRequirement = "auto";
  const rawStamp = review["require-stamp"];
  if (rawStamp !== undefined) {
    if (
      typeof rawStamp !== "string" ||
      !STAMP_REQUIREMENTS.includes(rawStamp as StampRequirement)
    ) {
      bad(
        "invalid_config",
        "review.require-stamp",
        `review.require-stamp must be one of ${STAMP_REQUIREMENTS.join(", ")}`,
      );
    }
    requireStamp = rawStamp as StampRequirement;
  }

  let costSignature = false;
  const rawSignature = review["cost-signature"];
  if (rawSignature !== undefined) {
    if (typeof rawSignature !== "boolean") {
      bad("invalid_config", "review.cost-signature", "review.cost-signature must be a boolean");
    }
    costSignature = rawSignature as boolean;
  }

  return { review: { requireStamp, costSignature } };
}

function parseProvider(name: string, value: unknown, bad: Bad): ProviderConfig {
  if (!isObject(value)) {
    bad("invalid_config", name, `provider "${name}" must be a map of provider settings`);
  }
  const record = value as Record<string, unknown>;
  refuseUnknownKeys(record, PROVIDER_KEYS, name, bad, `provider "${name}"`);

  if (typeof record.enabled !== "boolean") {
    bad("invalid_config", `${name}.enabled`, `provider "${name}".enabled must be a boolean`);
  }

  const api = optionalString(record.api, `${name}.api`, bad);
  const baseUrl = optionalString(record.baseUrl, `${name}.baseUrl`, bad);
  const credential = optionalString(record.credential, `${name}.credential`, bad);
  const concurrency = optionalConcurrency(record.concurrency, `${name}.concurrency`, bad);
  const headers = optionalHeaders(record.headers, name, bad);

  const rawModels = record.models;
  if (!isObject(rawModels)) {
    bad(
      "invalid_config",
      `${name}.models`,
      `provider "${name}".models must be a map of model name to model settings`,
    );
  }
  const models: Record<string, ModelConfig> = {};
  for (const [modelName, rawModel] of Object.entries(rawModels as Record<string, unknown>)) {
    models[modelName] = parseModel(name, modelName, rawModel, bad);
  }

  return {
    enabled: record.enabled as boolean,
    ...(api !== undefined ? { api } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(credential !== undefined ? { credential } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(headers !== undefined ? { headers } : {}),
    models,
  };
}

function parseModel(provider: string, name: string, value: unknown, bad: Bad): ModelConfig {
  const path = `${provider}.models.${name}`;
  if (!isObject(value)) {
    bad("invalid_config", path, `model "${name}" of provider "${provider}" must be a map`);
  }
  const record = value as Record<string, unknown>;
  refuseUnknownKeys(record, MODEL_KEYS, path, bad, `model "${name}"`);

  const input = requirePrice(record.input, `${path}.input`, bad);
  const output = requirePrice(record.output, `${path}.output`, bad);
  const cacheRead = optionalPrice(record.cacheRead, `${path}.cacheRead`, bad);
  const cacheWrite = optionalPrice(record.cacheWrite, `${path}.cacheWrite`, bad);
  const maxTokens = optionalMaxTokens(record.maxTokens, `${path}.maxTokens`, bad);
  const baseUrl = optionalString(record.baseUrl, `${path}.baseUrl`, bad);
  const format = optionalString(record.format, `${path}.format`, bad);
  const contextWindow = optionalContextWindow(record.contextWindow, `${path}.contextWindow`, bad);
  const concurrency = optionalConcurrency(record.concurrency, `${path}.concurrency`, bad);

  if (record.tools !== undefined && typeof record.tools !== "boolean") {
    bad("invalid_config", `${path}.tools`, `${path}.tools must be a boolean when present`);
  }

  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(record.tools !== undefined ? { tools: record.tools as boolean } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
}

function parseProfile(
  name: string,
  value: unknown,
  providers: Record<string, ProviderConfig>,
  bad: Bad,
): ConfigProfile {
  if (!isObject(value) || Object.keys(value).length === 0) {
    bad(
      "invalid_config",
      name,
      `profile "${name}" must be a non-empty map of role rows (a profile that routes nothing cannot be named)`,
    );
  }
  const rawRows = value as Record<string, unknown>;

  const keys: Array<{ key: string; role: ProfileRole; complexity: Complexity | undefined }> = [];
  const bareRoles = new Set<string>();
  for (const key of Object.keys(rawRows)) {
    const parsed = parseRowKey(name, key, bad);
    keys.push(parsed);
    if (parsed.complexity === undefined) {
      bareRoles.add(parsed.role);
    }
  }

  for (const { key, role, complexity } of keys) {
    if (complexity !== undefined && !bareRoles.has(role)) {
      bad(
        "orphan_override",
        key,
        `row "${key}" in profile "${name}" overrides role "${role}" for tier "${complexity}" but profile "${name}" declares no bare "${role}" row; a tier row replaces the bare row and cannot stand in for the other tiers`,
      );
    }
  }

  const routes: Record<string, ModelLadder> = {};
  for (const [key, rawRow] of Object.entries(rawRows)) {
    routes[key] = parseLadder(name, key, rawRow, providers, bad);
  }

  return { name, routes };
}

function parseRowKey(
  profile: string,
  key: string,
  bad: Bad,
): { key: string; role: ProfileRole; complexity: Complexity | undefined } {
  if (key.length === 0) {
    bad("invalid_config", profile, `profile "${profile}" declares an empty row key`);
  }
  const at = key.indexOf("@");
  const roleToken = at === -1 ? key : key.slice(0, at);
  if (roleToken.length === 0) {
    bad(
      "unknown_role",
      key,
      `row key "${key}" in profile "${profile}" names no role; expected one of ${PROFILE_ROLES.join(", ")}`,
    );
  }
  if (!PROFILE_ROLES.includes(roleToken as ProfileRole)) {
    bad(
      "unknown_role",
      roleToken,
      `row key "${key}" in profile "${profile}" names role "${roleToken}"; expected one of ${PROFILE_ROLES.join(", ")}`,
    );
  }
  const role = roleToken as ProfileRole;

  if (at === -1) {
    return { key, role, complexity: undefined };
  }
  const tierToken = key.slice(at + 1);
  if (!COMPLEXITIES.includes(tierToken as Complexity)) {
    bad(
      "invalid_complexity",
      tierToken.length > 0 ? tierToken : key,
      `row key "${key}" in profile "${profile}" names complexity "${tierToken}"; expected one of ${COMPLEXITIES.join(", ")}`,
    );
  }

  return { key, role, complexity: tierToken as Complexity };
}

function parseLadder(
  profile: string,
  key: string,
  value: unknown,
  providers: Record<string, ProviderConfig>,
  bad: Bad,
): ModelLadder {
  const path = `profiles.${profile}.${key}`;
  const rungs: unknown = typeof value === "string" ? [value] : value;
  if (!Array.isArray(rungs) || rungs.length === 0) {
    bad(
      "invalid_config",
      path,
      `row "${key}" in profile "${profile}" must be one "provider:model" string or a non-empty list of them`,
    );
  }

  const ladder: string[] = [];
  for (const rawRung of rungs as unknown[]) {
    if (typeof rawRung !== "string" || rawRung.length === 0) {
      bad(
        "invalid_config",
        path,
        `every rung of row "${key}" in profile "${profile}" must be a non-empty "provider:model" string`,
      );
    }
    const rung = rawRung as string;
    const colon = rung.indexOf(":");
    const providerName = colon === -1 ? "" : rung.slice(0, colon);
    const modelName = colon === -1 ? rung.slice(1) : rung.slice(colon + 1);
    if (providerName.length === 0 || modelName.length === 0) {
      bad(
        "invalid_config",
        path,
        `rung "${rung}" of row "${key}" in profile "${profile}" must be "provider:model" with both names non-empty`,
      );
    }

    const provider = providers[providerName];
    if (provider === undefined) {
      bad(
        "unknown_provider",
        providerName,
        `rung "${rung}" of row "${key}" in profile "${profile}" names provider "${providerName}", which \`providers\` does not declare`,
      );
    }
    if (!Object.hasOwn(provider.models, modelName)) {
      bad(
        "unknown_model",
        modelName,
        `rung "${rung}" of row "${key}" in profile "${profile}" names model "${modelName}", which provider "${providerName}" does not declare`,
      );
    }

    ladder.push(rung);
  }

  return ladder;
}

function reporter(file: "models.yaml" | "settings.yaml"): Bad {
  return (code, detail, message) => {
    throw new ConfigError(code, detail, `${file}: ${message}`);
  };
}

function refuseUnknownKeys(
  record: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  bad: Bad,
  where: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      const at = path.length === 0 ? key : `${path}.${key}`;
      bad(
        "invalid_config",
        at,
        `unknown ${where} key "${key}"; expected one of ${[...allowed].join(", ")}`,
      );
    }
  }
}

function requirePrice(value: unknown, path: string, bad: Bad): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    bad("invalid_config", path, `${path} must be a non-negative finite number`);
  }
  return value as number;
}

/** An optional price with exactly `requirePrice`'s checks; absence stays absent. */
function optionalPrice(value: unknown, path: string, bad: Bad): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requirePrice(value, path, bad);
}

/**
 * An optional positive completion ceiling. No `maxTokens`-vs-`contextWindow`
 * cross-field rule on purpose: the epic leaves that check to the operator's
 * provider, and a positive number is all this layer can honestly assert.
 */
function optionalMaxTokens(value: unknown, path: string, bad: Bad): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    bad("invalid_config", path, `${path} must be a positive finite number when present`);
  }
  return value as number;
}

function optionalString(value: unknown, path: string, bad: Bad): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    bad("invalid_config", path, `${path} must be a non-empty string when present`);
  }
  return value as string;
}

function optionalConcurrency(value: unknown, path: string, bad: Bad): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    bad("invalid_config", path, `${path} must be an integer of at least 1 when present`);
  }
  return value as number;
}

function optionalContextWindow(value: unknown, path: string, bad: Bad): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    bad("invalid_config", path, `${path} must be a positive integer token count when present`);
  }
  return value as number;
}

/**
 * Headers carry their own error detail on purpose: a header NAME is
 * caller-chosen text that may be a credential-bearing key, so neither the key
 * nor the value is echoed -- the field path is the whole message the operator
 * needs to find the line.
 */
function optionalHeaders(
  value: unknown,
  provider: string,
  bad: Bad,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const path = `${provider}.headers`;
  if (!isObject(value)) {
    bad("invalid_config", path, `${path} must be a map of header name to string value`);
  }
  const headers: Record<string, string> = {};
  for (const [header, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (header.length === 0 || typeof headerValue !== "string") {
      bad("invalid_config", path, `${path} keys must be non-empty and every value a string`);
    }
    headers[header] = headerValue as string;
  }
  return headers;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
