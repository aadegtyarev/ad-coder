import { RegistryError } from "./errors";
import type {
  ApiKind,
  CredentialSource,
  ModelConfig,
  ProviderConfig,
  RegistryConfig,
} from "./types";

const API_KINDS: readonly ApiKind[] = [
  "openai-completions",
  "anthropic-messages",
  "openai-codex-responses",
];

export const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Header names a declared config may NOT set, lower-cased.
 *
 * Two distinct reasons, both fail-closed:
 *
 * AUTHENTICATION. `authorization`, `x-api-key`, `proxy-authorization`,
 * `cookie`, and the Anthropic OAuth pair carry or displace credentials. The
 * resolver derives those from `credential`, whose value never appears in a
 * config file; accepting them here would invite an operator to paste a secret
 * into shared config, and a null/empty value would silently strip the auth the
 * resolver installed.
 *
 * TRANSPORT. `host`, `content-type`, `content-length`, `accept-encoding`,
 * `user-agent`, and `anthropic-version` are owned by pi-ai or its SDKs.
 * Declaring one either loses to the adapter or corrupts the request body
 * framing, so rejecting is honest where silently-ignored would not be.
 */
const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "anthropic-auth-token",
  "cf-aig-authorization",
  "host",
  "content-type",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "user-agent",
  "anthropic-version",
]);

/** RFC 7230 token: the characters an HTTP field name may contain. */
/**
 * Placeholders a declared header value may contain, expanded by the resolver at
 * resolve time. `session` becomes one opaque run-scoped identifier, the same
 * value for every header and model of a single resolved registry, a fresh value
 * for the next run. It exists because some APIs demand a per-conversation
 * routing marker that a static config file cannot know.
 *
 * Unknown tokens are REJECTED rather than transmitted literally: a typo that
 * reached the wire would look to the provider like a legitimate constant value
 * and fail as an opaque routing error instead of a config error.
 */
const HEADER_PLACEHOLDERS: ReadonlySet<string> = new Set(["session"]);

/** `{{name}}` — the only substitution syntax a declared header value supports. */
export const HEADER_PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validate a declared header map: plain object, token-shaped names, no
 * duplicate names differing only by case, printable ASCII values, and none of
 * the reserved names above. Returns undefined when absent so the field stays
 * off the resolved object entirely.
 *
 * Values are NOT secrets by contract and are reported only by NAME on failure,
 * matching the rest of this validator.
 */
function parseHeaders(value: unknown, scope: string, bad: Bad): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    bad("invalid_config", `${scope}.headers`, "headers must be an object when present");
  }
  const seen = new Set<string>();
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      bad(
        "invalid_config",
        `${scope}.headers.${name}`,
        `header name "${name}" is not a valid HTTP field name`,
      );
    }
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADER_NAMES.has(lower)) {
      bad(
        "invalid_config",
        `${scope}.headers.${name}`,
        `header "${name}" is reserved; authentication belongs in provider.credential and transport headers are owned by the client`,
      );
    }
    if (seen.has(lower)) {
      bad(
        "invalid_config",
        `${scope}.headers.${name}`,
        `header "${name}" is declared more than once, ignoring case`,
      );
    }
    seen.add(lower);
    if (typeof headerValue !== "string" || headerValue.length === 0) {
      bad(
        "invalid_config",
        `${scope}.headers.${name}`,
        `header "${name}" must have a non-empty string value`,
      );
    }
    const text = headerValue as string;
    // Printable ASCII only: a newline would splice an extra header into the
    // request, and a non-ASCII byte is not transmissible in a field value.
    if (!/^[\x20-\x7e]*$/.test(text)) {
      bad(
        "invalid_config",
        `${scope}.headers.${name}`,
        `header "${name}" value must contain only printable ASCII characters`,
      );
    }
    for (const match of text.matchAll(HEADER_PLACEHOLDER_PATTERN)) {
      const token = match[1] ?? "";
      if (!HEADER_PLACEHOLDERS.has(token)) {
        bad(
          "invalid_config",
          `${scope}.headers.${name}`,
          `header "${name}" uses unknown placeholder "{{${token}}}"; supported: ${[...HEADER_PLACEHOLDERS].map((p) => `{{${p}}}`).join(", ")}`,
        );
      }
    }
    headers[name] = text;
  }
  return headers;
}

/**
 * TRUST BOUNDARY. `RegistryConfig` is OPERATOR-AUTHORED, plain-data config: the
 * config AUTHOR is trusted, its concrete SHAPE is not. This validator hardens
 * against malformed/careless input (wrong types, duplicate keys, a non-URL
 * baseUrl) -- it is NOT a control against a hostile config author. In
 * particular the `baseUrl` https check below is SCHEME-HARDENING (it forecloses
 * cleartext key transmission and non-http schemes), NOT an exfiltration control:
 * it does not constrain the HOST, so a trusted author who pairs an arbitrary
 * https host with an arbitrary env-var name can still direct that named secret
 * to that host. That pairing is acceptable ONLY because the author is trusted;
 * if config ever originates from a less-trusted source, host-level controls
 * (link-local / loopback / RFC1918 / metadata rejection or an allowlist) must be
 * added here. See the module's security notes.
 *
 * Pure, hand-written, fail-loud -- no `eval`, no schema library, no silent
 * coercion, no defaulting a bad value. Mirrors `parsePlan`: every deviation
 * throws a typed `RegistryError` whose `detail` names the offending
 * id/name/field ONLY, never a value.
 */
export function parseRegistryConfig(value: unknown): RegistryConfig {
  const bad = (code: RegistryError["code"], detail: string, message: string): never => {
    throw new RegistryError(code, detail, message);
  };

  if (!isObject(value)) {
    return bad("invalid_config", "config", "registry config must be an object");
  }
  const providers = value.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    return bad("invalid_config", "providers", "config.providers must be a non-empty array");
  }

  const seenProviderIds = new Set<string>();
  const seenModelNames = new Set<string>();
  const validated: ProviderConfig[] = [];

  for (const rawProvider of providers) {
    validated.push(parseProvider(rawProvider, bad, seenProviderIds, seenModelNames));
  }

  return { providers: validated };
}

type Bad = (code: RegistryError["code"], detail: string, message: string) => never;

function parseProvider(
  value: unknown,
  bad: Bad,
  seenProviderIds: Set<string>,
  seenModelNames: Set<string>,
): ProviderConfig {
  if (!isObject(value)) {
    bad("invalid_config", "provider", "each provider must be an object");
  }
  const record = value as Record<string, unknown>;

  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    bad("invalid_config", "provider.id", "provider.id must be a non-empty string");
  }
  const providerId = id as string;
  if (seenProviderIds.has(providerId)) {
    bad("duplicate_provider", providerId, `provider id "${providerId}" is declared more than once`);
  }
  seenProviderIds.add(providerId);

  if (record.displayName !== undefined && typeof record.displayName !== "string") {
    bad(
      "invalid_config",
      `${providerId}.displayName`,
      "provider.displayName must be a string when present",
    );
  }

  const api = record.api;
  if (typeof api !== "string" || !API_KINDS.includes(api as ApiKind)) {
    bad(
      "unsupported_api",
      providerId,
      `provider "${providerId}" api must be one of ${API_KINDS.join(", ")}`,
    );
  }

  assertHttpsUrl(record.baseUrl, `${providerId}.baseUrl`, bad);

  const credential = parseCredential(record.credential, providerId, bad);

  const headers = parseHeaders(record.headers, providerId, bad);

  const models = record.models;
  if (!Array.isArray(models) || models.length === 0) {
    bad(
      "invalid_config",
      `${providerId}.models`,
      `provider "${providerId}" must declare a non-empty models array`,
    );
  }
  const validatedModels: ModelConfig[] = [];
  for (const rawModel of models as unknown[]) {
    validatedModels.push(parseModel(rawModel, providerId, bad, seenModelNames));
  }

  return {
    id: providerId,
    ...(record.displayName !== undefined ? { displayName: record.displayName as string } : {}),
    api: api as ApiKind,
    baseUrl: record.baseUrl as string,
    credential,
    ...(headers !== undefined ? { headers } : {}),
    models: validatedModels,
  };
}

function parseCredential(value: unknown, providerId: string, bad: Bad): CredentialSource {
  if (!isObject(value)) {
    bad("invalid_config", `${providerId}.credential`, "provider.credential must be an object");
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "oauth") {
    return { kind: "oauth" };
  }
  if (kind === "env-var") {
    const envVar = record.envVar;
    if (typeof envVar !== "string" || envVar.length === 0) {
      bad(
        "invalid_config",
        `${providerId}.credential.envVar`,
        "an env-var credential requires a non-empty envVar name",
      );
    }
    return { kind: "env-var", envVar: envVar as string };
  }
  return bad(
    "invalid_config",
    `${providerId}.credential.kind`,
    "provider.credential.kind must be 'env-var' or 'oauth'",
  );
}

function parseModel(
  value: unknown,
  providerId: string,
  bad: Bad,
  seenModelNames: Set<string>,
): ModelConfig {
  if (!isObject(value)) {
    bad("invalid_config", `${providerId}.model`, "each model must be an object");
  }
  const record = value as Record<string, unknown>;

  const name = record.name;
  if (typeof name !== "string" || name.length === 0) {
    bad("invalid_config", `${providerId}.model.name`, "model.name must be a non-empty string");
  }
  const modelName = name as string;
  if (seenModelNames.has(modelName)) {
    bad(
      "duplicate_model",
      modelName,
      `model name "${modelName}" is declared more than once across providers`,
    );
  }
  seenModelNames.add(modelName);

  if (typeof record.modelId !== "string" || (record.modelId as string).length === 0) {
    bad("invalid_config", `${modelName}.modelId`, "model.modelId must be a non-empty string");
  }

  if (record.contextWindow !== undefined) {
    assertPositiveNumber(record.contextWindow, `${modelName}.contextWindow`, bad);
  }
  assertPositiveNumber(record.maxTokens, `${modelName}.maxTokens`, bad);

  if (record.reasoning !== undefined && typeof record.reasoning !== "boolean") {
    bad(
      "invalid_config",
      `${modelName}.reasoning`,
      "model.reasoning must be a boolean when present",
    );
  }

  let input: ("text" | "image")[] | undefined;
  if (record.input !== undefined) {
    if (
      !Array.isArray(record.input) ||
      record.input.length === 0 ||
      record.input.some((item) => item !== "text" && item !== "image") ||
      new Set(record.input).size !== record.input.length
    ) {
      bad(
        "invalid_config",
        `${modelName}.input`,
        'model.input must be a non-empty unique array containing only "text" and "image"',
      );
    }
    input = record.input as ("text" | "image")[];
  }

  const cost = parseCost(record.cost, modelName, bad);

  let api: ApiKind | undefined;
  if (record.api !== undefined) {
    if (typeof record.api !== "string" || !API_KINDS.includes(record.api as ApiKind)) {
      bad(
        "unsupported_api",
        modelName,
        `model "${modelName}" api override must be one of ${API_KINDS.join(", ")}`,
      );
    }
    api = record.api as ApiKind;
  }

  // `compat` is deliberately UNVALIDATED pass-through: the validator only
  // confirms it is absent or a plain object, and the resolver does NOT forward
  // it into provider construction in this first cut. So an unvalidated blob
  // cannot reach request shaping (headers, transport) -- it stays inert data on
  // the config. If a future cut forwards compat, it must be shape-checked here.
  if (record.compat !== undefined && !isObject(record.compat)) {
    bad("invalid_config", `${modelName}.compat`, "model.compat must be an object when present");
  }

  if (record.baseUrl !== undefined) {
    assertHttpsUrl(record.baseUrl, `${modelName}.baseUrl`, bad);
  }
  const headers = parseHeaders(record.headers, modelName, bad);

  return {
    name: modelName,
    modelId: record.modelId as string,
    contextWindow: (record.contextWindow as number | undefined) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: record.maxTokens as number,
    ...(record.reasoning !== undefined ? { reasoning: record.reasoning as boolean } : {}),
    ...(input !== undefined ? { input } : {}),
    cost,
    ...(api !== undefined ? { api } : {}),
    ...(record.baseUrl !== undefined ? { baseUrl: record.baseUrl as string } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(record.compat !== undefined ? { compat: record.compat } : {}),
  };
}

function parseCost(value: unknown, modelName: string, bad: Bad): ModelConfig["cost"] {
  if (!isObject(value)) {
    bad("invalid_config", `${modelName}.cost`, "model.cost must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const num = record[field];
    if (typeof num !== "number" || !Number.isFinite(num)) {
      bad(
        "invalid_config",
        `${modelName}.cost.${field}`,
        `model.cost.${field} must be a finite number`,
      );
    }
  }
  return {
    input: record.input as number,
    output: record.output as number,
    cacheRead: record.cacheRead as number,
    cacheWrite: record.cacheWrite as number,
  };
}

/**
 * Validate a baseUrl as an ABSOLUTE https URL carrying no embedded credentials.
 *
 * SECURITY (hard requirement, from review): parse with `new URL` (reject on
 * throw), then require `url.protocol === 'https:'` by EXACT equality -- a loose
 * `startsWith('https')` would wave through crafted schemes like `httpsx:` -- and
 * reject a URL carrying userinfo (`https://user:pass@host`), which would
 * silently override the declared credential intent. The offending value IS kept
 * in `detail` because a baseUrl is not a secret; a rejected URL must be
 * diagnosable.
 */
function assertHttpsUrl(value: unknown, field: string, bad: Bad): void {
  if (typeof value !== "string" || value.length === 0) {
    bad("invalid_config", field, `${field} must be a non-empty string`);
  }
  const raw = value as string;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // new URL throws on a relative or malformed URL; the error carries only the
    // input we already have, so we drop it and report a typed reject.
    bad("invalid_config", field, `${field} is not a valid absolute URL: ${raw}`);
    return;
  }
  if (url.protocol !== "https:") {
    bad("invalid_config", field, `${field} must use the https scheme: ${raw}`);
  }
  if (url.username !== "" || url.password !== "") {
    bad("invalid_config", field, `${field} must not embed userinfo (user:pass@host): ${raw}`);
  }
}

function assertPositiveNumber(value: unknown, field: string, bad: Bad): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    bad("invalid_config", field, `${field} must be a positive finite number`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
