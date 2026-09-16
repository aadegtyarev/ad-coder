import { parseProfile } from "../profiles/validate";
import { UserProfileError } from "./errors";
import type {
  CalibratedRouting,
  EconomicConfidence,
  EconomicRecord,
  EconomicRecordKind,
  ModelInventoryConfig,
  SubscriptionCapacityRange,
  UserProfile,
  UserProfileCapabilities,
} from "./types";

const ECONOMIC_KINDS = new Set<EconomicRecordKind>([
  "price",
  "context_limit",
  "subscription_limit",
  "credit_balance",
]);
const CONFIDENCES = new Set<EconomicConfidence>([
  "official",
  "provider_reported",
  "measured",
  "estimated",
]);

function invalid(detail: string): never {
  throw new UserProfileError("invalid_profile", detail, `invalid user profile: ${detail}`);
}

function object(value: unknown, detail: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(detail);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], detail: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    invalid(`${detail} has unknown fields`);
}

function string(value: unknown, detail: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(detail);
  return value;
}

function safeSource(value: unknown, detail: string): string {
  const source = string(value, detail);
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    if (
      !new Set(["benchmark", "manual-entry", "project-calibration", "provider-measurement"]).has(
        source,
      )
    )
      invalid(`${detail} must be an HTTPS URL or an approved anonymous source label`);
    return source;
  }
  if (url.protocol !== "https:") invalid(`${detail} URL must use HTTPS`);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    invalid(`${detail} URL must not contain credentials, query, or fragment data`);
  return source;
}

function finite(value: unknown, detail: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(detail);
  return value;
}

function date(value: unknown, detail: string): string {
  const valueAsString = string(value, detail);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueAsString)) invalid(detail);
  const parsed = new Date(`${valueAsString}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== valueAsString)
    invalid(detail);
  return valueAsString;
}

function parseCalibratedRouting(value: unknown): CalibratedRouting {
  const routing = object(value, "calibrated routing must be an object");
  exactKeys(
    routing,
    ["inventory", "profile", "observedOn", "source", "confidence"],
    "calibrated routing",
  );
  if (
    typeof routing.confidence !== "string" ||
    !CONFIDENCES.has(routing.confidence as EconomicConfidence)
  )
    invalid("calibrated routing confidence is unsupported");
  const profileValue = object(routing.profile, "calibrated routing profile must be an object");
  exactKeys(profileValue, ["entries"], "calibrated routing profile");
  if (!Array.isArray(profileValue.entries))
    invalid("calibrated routing profile entries must be an array");
  for (const entry of profileValue.entries) {
    const profileEntry = object(entry, "calibrated routing profile entry must be an object");
    exactKeys(
      profileEntry,
      ["role", "complexity", "model", "maxOutput", "cacheRetention", "thinkingLevel"],
      "calibrated routing profile entry",
    );
  }
  try {
    return {
      inventory: string(
        routing.inventory,
        "calibrated routing inventory must be a non-empty string",
      ),
      profile: parseProfile(profileValue),
      observedOn: date(
        routing.observedOn,
        "calibrated routing observedOn must be a canonical ISO date",
      ),
      source: safeSource(routing.source, "calibrated routing source must be a non-empty string"),
      confidence: routing.confidence as EconomicConfidence,
    };
  } catch (error) {
    if (error instanceof UserProfileError) throw error;
    invalid("calibrated routing profile is invalid");
  }
}

function parseSubscriptionCapacityRange(value: unknown): SubscriptionCapacityRange {
  const range = object(value, "subscription capacity range must be an object");
  exactKeys(
    range,
    ["provider", "unit", "lowerBound", "upperBound", "observedOn", "source", "confidence"],
    "subscription capacity range",
  );
  const lowerBound = finite(range.lowerBound, "subscription capacity lowerBound must be finite");
  const upperBound = finite(range.upperBound, "subscription capacity upperBound must be finite");
  if (lowerBound < 0 || upperBound < 0 || lowerBound > upperBound)
    invalid("subscription capacity bounds must be non-negative and ordered");
  if (
    typeof range.confidence !== "string" ||
    !CONFIDENCES.has(range.confidence as EconomicConfidence)
  )
    invalid("subscription capacity confidence is unsupported");
  return {
    provider: string(range.provider, "subscription capacity provider must be a non-empty string"),
    unit: string(range.unit, "subscription capacity unit must be a non-empty string"),
    lowerBound,
    upperBound,
    observedOn: date(
      range.observedOn,
      "subscription capacity observedOn must be a canonical ISO date",
    ),
    source: safeSource(range.source, "subscription capacity source must be a non-empty string"),
    confidence: range.confidence as EconomicConfidence,
  };
}

function parseInventory(value: unknown): ModelInventoryConfig {
  const entry = object(value, "inventory must be an object");
  exactKeys(entry, ["name", "providers", "default"], "inventory");
  const name = string(entry.name, "inventory.name must be a non-empty string");
  if (!Array.isArray(entry.providers) || entry.providers.length === 0)
    invalid("inventory.providers must be a non-empty array");
  const providerIds = new Set<string>();
  const providers = entry.providers.map((providerValue) => {
    const provider = object(providerValue, "inventory provider must be an object");
    exactKeys(provider, ["id", "models"], "inventory provider");
    const id = string(provider.id, "inventory provider id must be a non-empty string");
    if (providerIds.has(id)) invalid("inventory provider ids must be unique");
    providerIds.add(id);
    if (
      !Array.isArray(provider.models) ||
      provider.models.length === 0 ||
      provider.models.some((model) => typeof model !== "string" || model.trim().length === 0)
    )
      invalid("inventory provider models must be a non-empty array of non-empty strings");
    if (new Set(provider.models).size !== provider.models.length)
      invalid("inventory provider models must be unique");
    return { id, models: [...provider.models] };
  });
  const defaultModel =
    entry.default === undefined ? undefined : string(entry.default, "inventory.default");
  if (
    defaultModel !== undefined &&
    !providers.some((provider) => provider.models.includes(defaultModel))
  )
    invalid("inventory.default must name a declared model");
  return { name, providers, ...(defaultModel === undefined ? {} : { default: defaultModel }) };
}

export function parseEconomicRecord(value: unknown): EconomicRecord {
  const record = object(value, "economic record must be an object");
  exactKeys(
    record,
    [
      "id",
      "observedAt",
      "provider",
      "model",
      "kind",
      "value",
      "unit",
      "source",
      "confidence",
      "previousId",
    ],
    "economic record",
  );
  const observedAt = string(record.observedAt, "economic record observedAt must be a string");
  const timestamp = new Date(observedAt);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== observedAt)
    invalid("economic record observedAt must be a canonical ISO timestamp");
  if (typeof record.kind !== "string" || !ECONOMIC_KINDS.has(record.kind as EconomicRecordKind))
    invalid("economic record kind is unsupported");
  if (
    typeof record.confidence !== "string" ||
    !CONFIDENCES.has(record.confidence as EconomicConfidence)
  )
    invalid("economic record confidence is unsupported");
  const previousId =
    record.previousId === undefined
      ? undefined
      : string(record.previousId, "economic record previousId");
  return {
    id: string(record.id, "economic record id must be a non-empty string"),
    observedAt,
    provider: string(record.provider, "economic record provider must be a non-empty string"),
    model: string(record.model, "economic record model must be a non-empty string"),
    kind: record.kind as EconomicRecordKind,
    value: finite(record.value, "economic record value must be finite"),
    unit: string(record.unit, "economic record unit must be a non-empty string"),
    source: safeSource(record.source, "economic record source must be a non-empty string"),
    confidence: record.confidence as EconomicConfidence,
    ...(previousId === undefined ? {} : { previousId }),
  };
}

function parseCapabilities(value: unknown): UserProfileCapabilities {
  const capabilities = object(value, "profile capabilities must be an object");
  exactKeys(capabilities, ["skills"], "profile capabilities");
  if (capabilities.skills !== undefined && typeof capabilities.skills !== "boolean")
    invalid("profile.capabilities.skills must be a boolean");
  return capabilities.skills === undefined ? {} : { skills: capabilities.skills };
}

/** Parse untrusted persisted or imported data without coercing its fields. */
export function parseUserProfile(value: unknown): UserProfile {
  const profile = object(value, "profile must be an object");
  exactKeys(
    profile,
    [
      "version",
      "inventories",
      "calibratedRouting",
      "economicRecords",
      "subscriptionCapacityRanges",
      "capabilities",
    ],
    "profile",
  );
  if (profile.version === undefined) invalid("profile.version is required");
  if (profile.version !== 1)
    throw new UserProfileError(
      "unsupported_version",
      "version",
      "unsupported user profile version",
    );
  if (
    !Array.isArray(profile.inventories) ||
    !Array.isArray(profile.calibratedRouting) ||
    !Array.isArray(profile.economicRecords) ||
    !Array.isArray(profile.subscriptionCapacityRanges)
  )
    invalid(
      "profile inventories, calibratedRouting, economicRecords, and subscriptionCapacityRanges must be arrays",
    );
  const capabilities =
    profile.capabilities === undefined ? undefined : parseCapabilities(profile.capabilities);
  const inventories = profile.inventories.map(parseInventory);
  const names = new Set<string>();
  for (const inventory of inventories) {
    if (names.has(inventory.name)) invalid("inventory names must be unique");
    names.add(inventory.name);
  }
  const calibratedRouting = profile.calibratedRouting.map(parseCalibratedRouting);
  const routingInventories = new Set<string>();
  for (const routing of calibratedRouting) {
    if (routingInventories.has(routing.inventory))
      invalid("calibrated routing inventories must be unique");
    const inventory = inventories.find((entry) => entry.name === routing.inventory);
    if (inventory === undefined) invalid("calibrated routing must reference a declared inventory");
    const models = new Set(inventory.providers.flatMap((provider) => provider.models));
    if (routing.profile.entries.some((entry) => !models.has(entry.model)))
      invalid("calibrated routing models must belong to its inventory");
    routingInventories.add(routing.inventory);
  }
  const economicRecords = profile.economicRecords.map(parseEconomicRecord);
  const recordsById = new Map<string, EconomicRecord>();
  for (const record of economicRecords) {
    if (recordsById.has(record.id)) invalid("economic record ids must be unique");
    if (record.value < 0) invalid("economic record value must be non-negative");
    if (record.previousId !== undefined) {
      const previous = recordsById.get(record.previousId);
      if (previous === undefined)
        invalid("economic record previousId must reference an earlier record");
      if (
        previous.provider !== record.provider ||
        previous.model !== record.model ||
        previous.kind !== record.kind
      )
        invalid("economic record previousId must reference the same provider, model, and kind");
    }
    recordsById.set(record.id, record);
  }
  const subscriptionCapacityRanges = profile.subscriptionCapacityRanges.map(
    parseSubscriptionCapacityRange,
  );
  const inventoryProviders = new Set(
    inventories.flatMap((inventory) => inventory.providers.map((provider) => provider.id)),
  );
  if (subscriptionCapacityRanges.some((range) => !inventoryProviders.has(range.provider)))
    invalid("subscription capacity provider must belong to a declared inventory provider");
  const capacityKeys = new Set<string>();
  for (const range of subscriptionCapacityRanges) {
    const key = `${range.provider}\u0000${range.unit}`;
    if (capacityKeys.has(key))
      invalid("subscription capacity provider and unit pairs must be unique");
    capacityKeys.add(key);
  }
  return {
    version: 1,
    inventories,
    calibratedRouting,
    economicRecords,
    subscriptionCapacityRanges,
    ...(capabilities !== undefined && Object.keys(capabilities).length > 0 ? { capabilities } : {}),
  };
}

export function parseUserProfileJson(json: string): UserProfile {
  try {
    return parseUserProfile(JSON.parse(json) as unknown);
  } catch (error) {
    if (error instanceof UserProfileError) throw error;
    throw new UserProfileError("invalid_profile", "json", "invalid user profile JSON", {
      cause: error,
    });
  }
}

export function encodeUserProfile(value: unknown): string {
  return `${JSON.stringify(parseUserProfile(value), null, 2)}\n`;
}
