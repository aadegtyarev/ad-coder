import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseProfile } from "../profiles/validate";
import {
  calibrationSourceOf,
  type ModelInventoryConfig,
  parseUserProfile,
  type UserProfile,
  UserProfileError,
} from "../user-profile";
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
/**
 * Which routing source a snapshot is being built from (issue #506). A bare
 * string keeps the original meaning -- an inventory name -- so every existing
 * caller reads unchanged; the models arm names a `models.yaml` profile and
 * carries the (provider, model) pairs that profile reaches, which is what the
 * economics and capacity scoping below filters by. Those pairs are derived by
 * the config layer from the same walk the registry resolves with
 * (`modelsProfileSource`), never re-derived here.
 */
export type CalibrationSourceRef =
  | { kind: "inventory"; name: string }
  | { kind: "models-profile"; name: string; providers: Array<{ id: string; models: string[] }> };

function refOf(source: CalibrationSourceRef | string): CalibrationSourceRef {
  return typeof source === "string" ? { kind: "inventory", name: source } : source;
}

export function createProjectCalibrationSnapshot(
  value: unknown,
  source: CalibrationSourceRef | string,
  limits: ProjectCalibrationLimits = {},
): ProjectCalibrationSnapshot {
  const ref = refOf(source);
  const profile = parseUserProfile(value);
  const routing = profile.calibratedRouting.find((x) => {
    const named = calibrationSourceOf(x);
    return named?.kind === ref.kind && named.name === ref.name;
  });
  if (routing === undefined)
    throw new UserProfileError(
      "not_found",
      ref.name,
      ref.kind === "inventory"
        ? "calibrated inventory not found"
        : "calibrated models profile not found",
    );
  // Each arm resolves BOTH the provider/model pairs it serves and the source
  // field the snapshot will name, in one place: an inventory declares both in
  // this document, a models.yaml profile declares them in `models.yaml` and
  // they arrive WITH the ref (derived by the config layer's own walk).
  let declaredProviders: Array<{ id: string; models: string[] }>;
  let sourceFields: { inventory: ModelInventoryConfig } | { modelsProfile: string };
  if (ref.kind === "inventory") {
    const inventory = profile.inventories.find((x) => x.name === ref.name);
    if (inventory === undefined)
      throw new UserProfileError("not_found", ref.name, "calibrated inventory not found");
    declaredProviders = inventory.providers;
    sourceFields = { inventory };
  } else {
    declaredProviders = ref.providers;
    sourceFields = { modelsProfile: ref.name };
  }
  // Membership: the calibration may only route to models its source serves. For
  // an inventory, `parseUserProfile` above already enforced it against this
  // document. For a models profile the check happens here, and the offending
  // cell is NAMED, so a mistyped model is refused by name instead of shipping a
  // snapshot whose route dies at resolution.
  if (ref.kind === "models-profile") {
    const outside = routing.profile.entries.find(
      (entry) => !declaredProviders.some((provider) => provider.models.includes(entry.model)),
    );
    if (outside !== undefined)
      throw new UserProfileError(
        "invalid_profile",
        outside.model,
        `calibrated routing model "${outside.model}" is not served by models profile "${ref.name}"`,
      );
  }
  const maxEconomics = limit(limits.maxEconomics, "maxEconomics", 256);
  const maxCapacity = limit(limits.maxCapacityRanges, "maxCapacityRanges", 64);
  const providers = new Set(declaredProviders.map((p) => p.id));
  const providerModels = new Set(
    declaredProviders.flatMap((provider) =>
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
    ...sourceFields,
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
  // EXACTLY ONE SOURCE KEY (#506). The accepted field set is the union of the
  // two arms' shapes, compared exactly -- a snapshot carrying both source keys
  // and a snapshot carrying neither are both refused, as is an unknown field. A
  // snapshot written before the models arm existed carries `inventory` and
  // still parses here, so a committed snapshot in an existing checkout never
  // turns into a hard failure.
  const shape = Object.keys(x).sort().join(",");
  if (
    (shape !== "economics,inventory,observedOn,routing,subscriptionCapacityRanges,version" &&
      shape !== "economics,modelsProfile,observedOn,routing,subscriptionCapacityRanges,version") ||
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
  // The envelope re-parse hands the stored facts to the user-profile parser,
  // which owns routing shape, source naming and membership. It declares the
  // SAME arm the snapshot names, so the checks that apply are the ones that arm
  // has: an inventory block, or a models.yaml profile name whose model list
  // this module cannot see.
  const namesModelsProfile = x.modelsProfile !== undefined;
  const envelope = parseUserProfile({
    version: 1,
    inventories: namesModelsProfile ? [] : [x.inventory],
    calibratedRouting: [
      namesModelsProfile
        ? {
            modelsProfile: x.modelsProfile,
            profile: x.routing,
            observedOn: x.observedOn,
            source: "project-calibration",
            confidence: "measured",
          }
        : {
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
  const routing = parseProfile(x.routing);
  const observedOn = String(x.observedOn);
  const economics = (x.economics as ProjectCalibrationSnapshot["economics"]).map((e) => ({ ...e }));
  if (namesModelsProfile) {
    const modelsProfile = envelope.calibratedRouting[0]?.modelsProfile;
    if (modelsProfile === undefined)
      throw new UserProfileError(
        "invalid_profile",
        "modelsProfile",
        "snapshot models profile is missing",
      );
    return {
      version: 1,
      modelsProfile,
      routing,
      observedOn,
      economics,
      subscriptionCapacityRanges: envelope.subscriptionCapacityRanges,
    };
  }
  const inventory = envelope.inventories[0];
  if (inventory === undefined)
    throw new UserProfileError("invalid_profile", "inventory", "snapshot inventory is missing");
  return {
    version: 1,
    inventory,
    routing,
    observedOn,
    economics,
    subscriptionCapacityRanges: envelope.subscriptionCapacityRanges,
  };
}
export function writeProjectCalibrationSnapshot(targetDir: string, value: unknown) {
  const snapshot = parseProjectCalibrationSnapshot(value);
  const file = projectCalibrationPath(targetDir);
  const resolvedTarget = path.resolve(targetDir);
  const targetStat = fs.lstatSync(resolvedTarget);
  if (
    !targetStat.isDirectory() ||
    targetStat.isSymbolicLink() ||
    fs.realpathSync(resolvedTarget) !== resolvedTarget
  )
    throw new UserProfileError("invalid_path", "snapshot", "snapshot target is unsafe");
  const targetFd = fs.openSync(
    resolvedTarget,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW,
  );
  try {
    const directory = `/proc/self/fd/${targetFd}/.ad-coder`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      throw new UserProfileError("invalid_path", "snapshot", "snapshot directory is unsafe");
    const directoryFd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW,
    );
    const stableDirectory = `/proc/self/fd/${directoryFd}`;
    const destination = path.join(stableDirectory, FILE);
    const tmp = path.join(stableDirectory, `.${FILE}.${crypto.randomUUID()}.tmp`);
    try {
      try {
        const destinationStat = fs.lstatSync(destination);
        if (
          !destinationStat.isFile() ||
          destinationStat.isSymbolicLink() ||
          destinationStat.nlink !== 1
        )
          throw new UserProfileError("invalid_path", "snapshot", "snapshot destination is unsafe");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(tmp, destination);
      fs.chmodSync(destination, 0o600);
      fs.fsyncSync(directoryFd);
    } finally {
      fs.rmSync(tmp, { force: true });
      fs.closeSync(directoryFd);
    }
  } finally {
    fs.closeSync(targetFd);
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
