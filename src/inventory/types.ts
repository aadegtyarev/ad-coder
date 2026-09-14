import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Profile } from "../profiles/types";
import type { RegistryConfig, ResolvedRegistry, ResolvedRegistryConfig } from "../registry/types";

/** One named, indivisible provider/model registry and role-routing profile pair. */
export interface ModelInventoryProfile {
  name: string;
  registry: RegistryConfig;
  profile: Profile;
}

/** Trusted operator-authored inventory data. A default is optional. */
export interface ModelInventoryConfig {
  profiles: ModelInventoryProfile[];
  default?: string;
}

/**
 * One pair after validation, whose registry has every catalog-backed default
 * already filled in. Distinct from the authored form for the same reason
 * `ResolvedRegistryConfig` is: what an operator may omit and what the resolver
 * may read are different guarantees.
 */
export interface ResolvedModelInventoryProfile extends ModelInventoryProfile {
  registry: ResolvedRegistryConfig;
}

/** Inventory data after validation. See `ResolvedModelInventoryProfile`. */
export interface ResolvedModelInventoryConfig extends ModelInventoryConfig {
  profiles: ResolvedModelInventoryProfile[];
}

export interface ResolveModelInventoryOptions {
  env?: (name: string) => string | undefined;
  credentials?: CredentialStore;
}

/** A safe projection intentionally excluding URLs and credential data. */
export interface ModelInventorySummary {
  name: string;
  providerIds: string[];
  modelNames: string[];
}

export interface ResolvedModelInventory {
  name: string;
  registry: ResolvedRegistry;
  profile: Profile;
  summary: ModelInventorySummary;
  source: "selection" | "default";
}
