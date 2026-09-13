import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseProfile } from "../profiles/validate";
import { parseUserProfile, type UserProfile, UserProfileError } from "../user-profile";
import type { ProjectCalibrationLimits, ProjectCalibrationSnapshot } from "./types";

const FILE = "calibration.json";
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
function canonicalDate(value: string) {
  const d = new Date(`${value}T00:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(d.valueOf()) &&
    d.toISOString().slice(0, 10) === value
  );
}
function limit(value: number | undefined, name: string, fallback: number) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 0)
    throw new UserProfileError("invalid_profile", name, `${name} must be non-negative`);
  return n;
}
export function projectCalibrationPath(targetDir: string) {
  return path.join(path.resolve(targetDir), ".ad-coder", FILE);
}
export function createProjectCalibrationSnapshot(
  value: unknown,
  inventoryName: string,
  limits: ProjectCalibrationLimits = {},
): ProjectCalibrationSnapshot {
  const profile = parseUserProfile(value);
  const inventory = profile.inventories.find((x) => x.name === inventoryName);
  const routing = profile.calibratedRouting.find((x) => x.inventory === inventoryName);
  if (!inventory || !routing)
    throw new UserProfileError("not_found", inventoryName, "calibrated inventory not found");
  const maxEconomics = limit(limits.maxEconomics, "maxEconomics", 256);
  const maxCapacity = limit(limits.maxCapacityRanges, "maxCapacityRanges", 64);
  const providers = new Set(inventory.providers.map((p) => p.id));
  const providerModels = new Set(
    inventory.providers.flatMap((provider) =>
      provider.models.map((model) => `${provider.id}\0${model}`),
    ),
  );
  const latest = new Map<string, UserProfile["economicRecords"][number]>();
  for (const record of profile.economicRecords) {
    if (providerModels.has(`${record.provider}\0${record.model}`)) {
      const key = `${record.provider}\0${record.model}\0${record.kind}\0${record.unit}`;
      const old = latest.get(key);
      if (!old || old.observedAt < record.observedAt) latest.set(key, record);
    }
  }
  const economics = [...latest.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ provider, model, kind, value, unit, observedAt, source, confidence }) => ({
      provider,
      model,
      kind,
      value,
      unit,
      observedOn: observedAt.slice(0, 10),
      source,
      confidence,
    }));
  const capacity = profile.subscriptionCapacityRanges.filter((x) => providers.has(x.provider));
  if (
    (maxEconomics > 0 && economics.length > maxEconomics) ||
    (maxCapacity > 0 && capacity.length > maxCapacity)
  )
    throw new UserProfileError(
      "invalid_profile",
      "snapshot_limit",
      "project calibration snapshot exceeds configured limit",
    );
  return parseProjectCalibrationSnapshot({
    version: 1,
    inventory,
    routing: routing.profile,
    observedOn: routing.observedOn,
    economics,
    subscriptionCapacityRanges: capacity,
  });
}
export function parseProjectCalibrationSnapshot(value: unknown): ProjectCalibrationSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new UserProfileError(
      "invalid_profile",
      "snapshot",
      "project calibration snapshot must be an object",
    );
  const x = value as Record<string, unknown>;
  if (
    Object.keys(x).sort().join(",") !==
      "economics,inventory,observedOn,routing,subscriptionCapacityRanges,version" ||
    x.version !== 1
  )
    throw new UserProfileError(
      "invalid_profile",
      "snapshot",
      "project calibration snapshot fields are invalid",
    );
  if (!Array.isArray(x.economics) || !Array.isArray(x.subscriptionCapacityRanges))
    throw new UserProfileError(
      "invalid_profile",
      "snapshot",
      "snapshot economics and capacity ranges must be arrays",
    );
  const envelope = parseUserProfile({
    version: 1,
    inventories: [x.inventory],
    calibratedRouting: [
      {
        inventory: (x.inventory as { name?: unknown })?.name,
        profile: x.routing,
        observedOn: x.observedOn,
        source: "project-calibration",
        confidence: "measured",
      },
    ],
    economicRecords: x.economics.map((r, i) => {
      const e = r as Record<string, unknown>;
      return {
        id: `snapshot-${i}`,
        observedAt: `${String(e.observedOn)}T00:00:00.000Z`,
        provider: e.provider,
        model: e.model,
        kind: e.kind,
        value: e.value,
        unit: e.unit,
        source: e.source,
        confidence: e.confidence,
      };
    }),
    subscriptionCapacityRanges: x.subscriptionCapacityRanges,
  });
  if (!canonicalDate(String(x.observedOn)))
    throw new UserProfileError("invalid_profile", "observedOn", "snapshot date is invalid");
  const inventory = envelope.inventories[0];
  if (inventory === undefined)
    throw new UserProfileError("invalid_profile", "inventory", "snapshot inventory is missing");
  return {
    version: 1,
    inventory,
    routing: parseProfile(x.routing),
    observedOn: String(x.observedOn),
    economics: (x.economics as ProjectCalibrationSnapshot["economics"]).map((e) => ({ ...e })),
    subscriptionCapacityRanges: envelope.subscriptionCapacityRanges,
  };
}
export function writeProjectCalibrationSnapshot(targetDir: string, value: unknown) {
  const snapshot = parseProjectCalibrationSnapshot(value);
  const file = projectCalibrationPath(targetDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${FILE}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return file;
}
export function readProjectCalibrationSnapshot(targetDir: string) {
  const file = projectCalibrationPath(targetDir);
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      return parseProjectCalibrationSnapshot(JSON.parse(fs.readFileSync(fd, "utf8")));
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof UserProfileError) throw error;
    throw new UserProfileError(
      "io_error",
      "snapshot",
      "could not read project calibration snapshot",
      { cause: error },
    );
  }
}
