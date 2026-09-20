import type { Profile } from "../profiles/types";
import type {
  CalibrationSource,
  EconomicConfidence,
  EconomicRecordKind,
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
 * against: the name of a profile in the operator's `models.yaml` (issue #506).
 *
 * It carries no provider/model list: that list lives in `models.yaml` and is
 * not copied here (settings live in one place, and the snapshot is committed to
 * a repository). The pairs it was scoped by are already applied to `economics`
 * and `subscriptionCapacityRanges` at write time, and a model the selected
 * profile cannot serve is refused by the resolver at run time, loudly.
 *
 * The `inventory` arm this type used to carry -- a portable JSON inventory
 * block named as the source -- is GONE (issue #513). The routed JSON inventory
 * was retired with the YAML route, which left that arm naming a source no run
 * could ever select: a snapshot carrying it parsed and then never matched, a
 * second format kept alive by nothing but its own parser. Refusing it by name
 * is the point of the change: a repository that still holds one is told which
 * source to name instead, and the routing a project actually runs is in one
 * place for every checkout at once.
 */
export type ProjectCalibrationSnapshot = {
  version: 1;
  routing: Profile;
  observedOn: string;
  economics: ProjectEconomicSnapshot[];
  subscriptionCapacityRanges: SubscriptionCapacityRange[];
  modelsProfile: string;
};

/**
 * The routing source a project snapshot was built from. One arm, one answer:
 * the snapshot names a `models.yaml` profile, and that is the only kind of
 * source a run can resolve.
 */
export function snapshotSource(snapshot: ProjectCalibrationSnapshot): CalibrationSource {
  return { kind: "models-profile", name: snapshot.modelsProfile };
}

export interface ProjectCalibrationLimits {
  maxEconomics?: number;
  maxCapacityRanges?: number;
}
