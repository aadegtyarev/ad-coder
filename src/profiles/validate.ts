import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { Complexity } from "../orchestration/types";
import { ProfileError } from "./errors";
import type { Profile, ProfileEntry, ProfileRole } from "./types";

/**
 * Every routing role a profile can name, in the order a reader expects to meet
 * them. Exported because a front that reports the LIVE routing has to walk the
 * same list validation accepts -- a second hand-kept copy would report a layout
 * missing whichever role was added last.
 */
export const PROFILE_ROLES: readonly ProfileRole[] = [
  "planner",
  "researcher",
  "coder",
  "reviewer",
  "auditor",
  "security",
  "recorder",
];

const COMPLEXITIES: readonly Complexity[] = ["trivial", "medium", "complex"];

const CACHE_RETENTIONS: readonly CacheRetention[] = ["none", "short", "long"];
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Strictly validate untrusted, plain-data input into a `Profile`.
 *
 * Pure, hand-written, fail-loud mirrors `parseRegistryConfig`/`parsePlan`: no
 * `eval`, no schema library, no silent coercion, no defaulting a bad value.
 * `value` must be an object with a non-empty `entries` array; every entry must
 * be an object with a known `role`, a known `complexity`, a non-empty `model`
 * string, and (when present) a positive-finite `maxOutput` and a valid
 * `cacheRetention`. Duplicate `(role, complexity)` cells are rejected via a
 * seen-Set on the composite `role:complexity` key.
 *
 * Every deviation throws a typed `ProfileError` whose `detail` names ONLY the
 * offending role/complexity/`role:complexity`/field token never a value, never
 * config content so a rejected profile stays safe to quote in a bug report.
 */
export function parseProfile(value: unknown): Profile {
  const bad = (code: ProfileError["code"], detail: string, message: string): never => {
    throw new ProfileError(code, detail, message);
  };

  if (!isObject(value)) {
    return bad("invalid_config", "profile", "profile must be an object");
  }
  const entries = value.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return bad("invalid_config", "entries", "profile.entries must be a non-empty array");
  }

  const seenKeys = new Set<string>();
  const validated: ProfileEntry[] = [];
  for (const rawEntry of entries as unknown[]) {
    validated.push(parseEntry(rawEntry, bad, seenKeys));
  }

  return { entries: validated };
}

type Bad = (code: ProfileError["code"], detail: string, message: string) => never;

function parseEntry(value: unknown, bad: Bad, seenKeys: Set<string>): ProfileEntry {
  if (!isObject(value)) {
    bad("invalid_config", "entry", "each profile entry must be an object");
  }
  const record = value as Record<string, unknown>;

  const role = record.role;
  if (typeof role !== "string" || !PROFILE_ROLES.includes(role as ProfileRole)) {
    bad(
      "unknown_role",
      typeof role === "string" ? role : "role",
      `entry.role must be one of ${PROFILE_ROLES.join(", ")}`,
    );
  }
  const profileRole = role as ProfileRole;

  const complexity = record.complexity;
  if (typeof complexity !== "string" || !COMPLEXITIES.includes(complexity as Complexity)) {
    bad(
      "invalid_complexity",
      typeof complexity === "string" ? complexity : "complexity",
      `entry.complexity must be one of ${COMPLEXITIES.join(", ")}`,
    );
  }
  const profileComplexity = complexity as Complexity;

  const key = `${profileRole}:${profileComplexity}`;
  if (seenKeys.has(key)) {
    bad("duplicate_entry", key, `profile declares (role, complexity) "${key}" more than once`);
  }
  seenKeys.add(key);

  const model = record.model;
  if (typeof model !== "string" || model.length === 0) {
    bad("invalid_config", `${key}.model`, "entry.model must be a non-empty string");
  }

  if (record.maxOutput !== undefined) {
    if (
      typeof record.maxOutput !== "number" ||
      !Number.isFinite(record.maxOutput) ||
      record.maxOutput <= 0
    ) {
      bad(
        "invalid_config",
        `${key}.maxOutput`,
        "entry.maxOutput must be a positive finite number when present",
      );
    }
  }

  if (
    record.cacheRetention !== undefined &&
    (typeof record.cacheRetention !== "string" ||
      !CACHE_RETENTIONS.includes(record.cacheRetention as CacheRetention))
  ) {
    bad(
      "invalid_config",
      `${key}.cacheRetention`,
      `entry.cacheRetention must be one of ${CACHE_RETENTIONS.join(", ")} when present`,
    );
  }
  if (
    record.thinkingLevel !== undefined &&
    (typeof record.thinkingLevel !== "string" ||
      !THINKING_LEVELS.includes(record.thinkingLevel as ThinkingLevel))
  ) {
    bad(
      "invalid_config",
      `${key}.thinkingLevel`,
      `entry.thinkingLevel must be one of ${THINKING_LEVELS.join(", ")} when present`,
    );
  }

  return {
    role: profileRole,
    complexity: profileComplexity,
    model: model as string,
    ...(record.maxOutput !== undefined ? { maxOutput: record.maxOutput as number } : {}),
    ...(record.cacheRetention !== undefined
      ? { cacheRetention: record.cacheRetention as CacheRetention }
      : {}),
    ...(record.thinkingLevel !== undefined
      ? { thinkingLevel: record.thinkingLevel as ThinkingLevel }
      : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
