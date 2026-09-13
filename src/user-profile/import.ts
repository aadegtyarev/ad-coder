import { UserProfileError } from "./errors";
import { parseUserProfile } from "./schema";
import type { ImportMode, UserProfile, UserProfileImportPreview } from "./types";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Plans import entirely in memory. Merge only adds distinct identities; replace
 * replaces inventories but never rewrites the append-only economics journal.
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
  const localInventories = new Map(local.inventories.map((entry) => [entry.name, entry]));
  const localRouting = new Map(local.calibratedRouting.map((entry) => [entry.inventory, entry]));
  const localRecords = new Map(local.economicRecords.map((entry) => [entry.id, entry]));
  const capacityKey = (entry: UserProfile["subscriptionCapacityRanges"][number]) =>
    `${entry.provider}\u0000${entry.unit}`;
  const localCapacity = new Map(
    local.subscriptionCapacityRanges.map((entry) => [capacityKey(entry), entry]),
  );

  if (mode === "replace") {
    if (same(local.inventories, incoming.inventories)) unchanged.push("inventories");
    else updates.push("inventories");
    if (same(local.calibratedRouting, incoming.calibratedRouting))
      unchanged.push("calibratedRouting");
    else updates.push("calibratedRouting");
    if (same(local.subscriptionCapacityRanges, incoming.subscriptionCapacityRanges))
      unchanged.push("subscriptionCapacityRanges");
    else updates.push("subscriptionCapacityRanges");
  } else {
    for (const inventory of incoming.inventories) {
      const current = localInventories.get(inventory.name);
      if (current === undefined) creates.push(`inventory:${inventory.name}`);
      else if (same(current, inventory)) unchanged.push(`inventory:${inventory.name}`);
      else conflicts.push(`inventory:${inventory.name}`);
    }
  }

  for (const routing of incoming.calibratedRouting) {
    const current = localRouting.get(routing.inventory);
    if (mode === "replace") continue;
    if (current === undefined) creates.push(`calibratedRouting:${routing.inventory}`);
    else if (same(current, routing)) unchanged.push(`calibratedRouting:${routing.inventory}`);
    else conflicts.push(`calibratedRouting:${routing.inventory}`);
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
  const inventories =
    mode === "replace"
      ? incoming.inventories
      : [
          ...local.inventories,
          ...incoming.inventories.filter((entry) => !localInventories.has(entry.name)),
        ];
  const calibratedRouting =
    mode === "replace"
      ? incoming.calibratedRouting
      : [
          ...local.calibratedRouting,
          ...incoming.calibratedRouting.filter((entry) => !localRouting.has(entry.inventory)),
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
      inventories,
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
