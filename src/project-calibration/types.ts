import type { Profile } from "../profiles/types";
import type {
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
export interface ProjectCalibrationSnapshot {
  version: 1;
  inventory: ModelInventoryConfig;
  routing: Profile;
  observedOn: string;
  economics: ProjectEconomicSnapshot[];
  subscriptionCapacityRanges: SubscriptionCapacityRange[];
}
export interface ProjectCalibrationLimits {
  maxEconomics?: number;
  maxCapacityRanges?: number;
}
