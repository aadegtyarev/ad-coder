import type { ModelInventoryConfig as RegistryInventoryConfig } from "../inventory/types";
import type { Profile } from "../profiles/types";

/** A provider/model inventory that is safe to move between machines. */
export interface ModelInventoryConfig {
  name: string;
  providers: Array<{ id: string; models: string[] }>;
  default?: string;
}

/**
 * `credit_balance` is a server-reported, account-free balance observation. It
 * must use a stable provider/model scope and a unit such as `credits`, so two
 * append-only observations can measure consumed capacity without retaining an
 * account identifier or raw provider response.
 */
export type EconomicRecordKind =
  | "price"
  | "context_limit"
  | "subscription_limit"
  | "credit_balance";
export type EconomicConfidence = "official" | "provider_reported" | "measured" | "estimated";

export interface EconomicRecord {
  id: string;
  observedAt: string;
  provider: string;
  model: string;
  kind: EconomicRecordKind;
  value: number;
  unit: string;
  source: string;
  confidence: EconomicConfidence;
  previousId?: string;
}

/**
 * A source-linked routing profile calibrated against a NAMED routing source.
 * Two namespaces exist and are deliberately kept apart (issue #506):
 *
 * - `inventory` names a portable JSON inventory declared in this same profile's
 *   `inventories` block. It is the original route, kept parsing unchanged.
 * - `modelsProfile` names a profile in the operator's `models.yaml`. The model
 *   list of that source lives in `models.yaml`, which this stored document does
 *   not carry: settings live in ONE place, so the YAML is not copied here.
 *
 * Exactly one of the two is present. A bare name would be ambiguous the moment
 * an inventory and a models.yaml profile share it, and the two resolve against
 * different model sets, so the kind is written down rather than guessed.
 */
export interface CalibratedRouting {
  inventory?: string;
  modelsProfile?: string;
  profile: Profile;
  observedOn: string;
  source: string;
  confidence: EconomicConfidence;
}

/**
 * The routing source a calibrated routing entry (or a project snapshot) names:
 * which namespace the name lives in, and the name. Produced by one function so
 * every consumer -- uniqueness, import merge, the project snapshot match --
 * reads the same source instead of pattern-matching the two optional fields.
 */
export interface CalibrationSource {
  kind: "inventory" | "models-profile";
  name: string;
}

/**
 * `undefined` when the entry names no source at all. The parser refuses that
 * shape, so a value that reached a store is guaranteed to name exactly one --
 * this stays total for hand-constructed values in tests and callers.
 */
export function calibrationSourceOf(entry: {
  inventory?: string;
  modelsProfile?: string;
}): CalibrationSource | undefined {
  if (entry.inventory !== undefined) return { kind: "inventory", name: entry.inventory };
  if (entry.modelsProfile !== undefined)
    return { kind: "models-profile", name: entry.modelsProfile };
  return undefined;
}

/**
 * A provider-level, account-free estimate of subscription capacity. Bounds are
 * deliberately coarse and may only describe a known safe range.
 */
export interface SubscriptionCapacityRange {
  provider: string;
  unit: string;
  lowerBound: number;
  upperBound: number;
  observedOn: string;
  source: string;
  confidence: EconomicConfidence;
}

export interface UserProfile {
  version: 1;
  inventories: ModelInventoryConfig[];
  calibratedRouting: CalibratedRouting[];
  economicRecords: EconomicRecord[];
  subscriptionCapacityRanges: SubscriptionCapacityRange[];
  /** Capability switches; absent means every built-in default (enabled). */
  capabilities?: UserProfileCapabilities;
}

/**
 * Capability switches a profile may carry. Absence means every built-in
 * default (enabled); `false` is the operator's persistent off for that
 * capability, mirrored by a matching launch parameter (issue #116, item 3:
 * an optional field under the v1 parser, not a v2 bump).
 */
export interface UserProfileCapabilities {
  /** Skill capability: `false` is the persistent off, absent or `true` is enabled. */
  skills?: boolean;
}

/** Location inputs are explicit so callers can override the user-level default. */
export interface UserProfileStoreOptions {
  userHome: string;
  configPath?: string;
  xdgConfigHome?: string;
}

export type ImportMode = "merge" | "replace";

/** A deterministic, non-mutating import decision. Record identifiers are the journal identity. */
export interface UserProfileImportPreview {
  mode: ImportMode;
  creates: string[];
  updates: string[];
  unchanged: string[];
  conflicts: string[];
  result?: UserProfile;
}

// Keep this alias available to consumers migrating from the inventory module.
export type ExistingModelInventoryConfig = RegistryInventoryConfig;
