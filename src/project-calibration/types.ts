import type { Profile } from "../profiles/types";
import type {
  CalibrationSource,
  EconomicConfidence,
  EconomicRecordKind,
  ModelInventoryConfig,
  SubscriptionCapacityRange,
} from "../user-profile";
export interface ProjectEconomicSnapshot {
  provider: string;
  model: string;
  kind: EconomicRecordKind;
  value: number;
  unit: string;
  observedOn: string;
  source: string;
  confidence: EconomicConfidence;
}

/**
 * A committed project snapshot names the routing source it was calibrated
 * against in THAT source's own namespace: `inventory` for a portable JSON
 * inventory block, `modelsProfile` for the name of a profile in the operator's
 * `models.yaml` (issue #506). Exactly one is present, and which one it is
 * decides which namespace the name must match at run time -- a JSON inventory
 * and a models.yaml profile that share a name are still different sources.
 *
 * The models arm carries no provider/model list: that list lives in
 * `models.yaml` and is not copied here (settings live in one place, and the
 * snapshot is committed to a repository). The pairs it was scoped by are
 * already applied to `economics` and `subscriptionCapacityRanges` at write
 * time, and a model the selected profile cannot serve is refused by the
 * resolver at run time, loudly.
 */
export type ProjectCalibrationSnapshot = {
  version: 1;
  routing: Profile;
  observedOn: string;
  economics: ProjectEconomicSnapshot[];
  subscriptionCapacityRanges: SubscriptionCapacityRange[];
} & (
  | { inventory: ModelInventoryConfig; modelsProfile?: never }
  | { modelsProfile: string; inventory?: never }
);

/** The routing source a project snapshot was built from, whichever arm it is. */
export function snapshotSource(snapshot: ProjectCalibrationSnapshot): CalibrationSource {
  return snapshot.inventory !== undefined
    ? { kind: "inventory", name: snapshot.inventory.name }
    : { kind: "models-profile", name: snapshot.modelsProfile };
}

export interface ProjectCalibrationLimits {
  maxEconomics?: number;
  maxCapacityRanges?: number;
}
