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

/** A source-linked routing profile calibrated against a named portable inventory. */
export interface CalibratedRouting {
  inventory: string;
  profile: Profile;
  observedOn: string;
  source: string;
  confidence: EconomicConfidence;
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
