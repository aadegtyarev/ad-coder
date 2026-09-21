import { UserProfileError } from "./errors";
import { parseUserProfile } from "./schema";
import type { ImportMode, UserProfile, UserProfileImportPreview } from "./types";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Plans import entirely in memory. Merge only adds distinct identities; replace
 * replaces routing and capacity settings but never rewrites the append-only economics journal.
 */
export function previewUserProfileImport(
  localValue: unknown,
  incomingValue: unknown,
  mode: ImportMode,
): UserProfileImportPreview {
  if (mode !== "merge" && mode !== "replace")
    throw new UserProfileError("invalid_profile", "mode", "user profile import mode is invalid");
  const local = parseUserProfile(localValue);
  const incoming = parseUserProfile(incomingValue);
  const creates: string[] = [];
  const updates: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  const routingKey = (entry: UserProfile["calibratedRouting"][number]) => entry.modelsProfile;
  const localRouting = new Map(local.calibratedRouting.map((entry) => [routingKey(entry), entry]));
  const localRecords = new Map(local.economicRecords.map((entry) => [entry.id, entry]));
  const capacityKey = (entry: UserProfile["subscriptionCapacityRanges"][number]) =>
    `${entry.provider}\u0000${entry.unit}`;
  const localCapacity = new Map(
    local.subscriptionCapacityRanges.map((entry) => [capacityKey(entry), entry]),
  );

  if (mode === "replace") {
    if (same(local.calibratedRouting, incoming.calibratedRouting))
      unchanged.push("calibratedRouting");
    else updates.push("calibratedRouting");
    if (same(local.subscriptionCapacityRanges, incoming.subscriptionCapacityRanges))
      unchanged.push("subscriptionCapacityRanges");
    else updates.push("subscriptionCapacityRanges");
  } else {
  }

  for (const routing of incoming.calibratedRouting) {
    const current = localRouting.get(routingKey(routing));
    if (mode === "replace") continue;
    const label = routing.modelsProfile;
    if (current === undefined) creates.push(`calibratedRouting:models-profile:${label}`);
    else if (same(current, routing)) unchanged.push(`calibratedRouting:models-profile:${label}`);
    else conflicts.push(`calibratedRouting:models-profile:${label}`);
  }

  for (const range of incoming.subscriptionCapacityRanges) {
    const key = capacityKey(range);
    const current = localCapacity.get(key);
    if (mode === "replace") continue;
    if (current === undefined)
      creates.push(`subscriptionCapacityRange:${range.provider}:${range.unit}`);
    else if (same(current, range))
      unchanged.push(`subscriptionCapacityRange:${range.provider}:${range.unit}`);
    else conflicts.push(`subscriptionCapacityRange:${range.provider}:${range.unit}`);
  }

  for (const record of incoming.economicRecords) {
    const current = localRecords.get(record.id);
    if (current === undefined) creates.push(`economicRecord:${record.id}`);
    else if (same(current, record)) unchanged.push(`economicRecord:${record.id}`);
    else conflicts.push(`economicRecord:${record.id}`);
  }

  if (conflicts.length > 0) return { mode, creates, updates, unchanged, conflicts };
  const calibratedRouting =
    mode === "replace"
      ? incoming.calibratedRouting
      : [
          ...local.calibratedRouting,
          ...incoming.calibratedRouting.filter((entry) => !localRouting.has(routingKey(entry))),
        ];
  const subscriptionCapacityRanges =
    mode === "replace"
      ? incoming.subscriptionCapacityRanges
      : [
          ...local.subscriptionCapacityRanges,
          ...incoming.subscriptionCapacityRanges.filter(
            (entry) => !localCapacity.has(capacityKey(entry)),
          ),
        ];
  const economicRecords = [
    ...local.economicRecords,
    ...incoming.economicRecords.filter((entry) => !localRecords.has(entry.id)),
  ];
  return {
    mode,
    creates,
    updates,
    unchanged,
    conflicts,
    result: {
      version: 1,
      calibratedRouting,
      economicRecords,
      subscriptionCapacityRanges,
    },
  };
}

export function requireImportResult(preview: UserProfileImportPreview): UserProfile {
  if (preview.conflicts.length > 0 || preview.result === undefined)
    throw new UserProfileError(
      "conflict",
      preview.conflicts.join(","),
      "user profile import has conflicts",
    );
  return preview.result;
}
