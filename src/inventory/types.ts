import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Profile } from "../profiles/types";
import type { RegistryConfig, ResolvedRegistry } from "../registry/types";

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
