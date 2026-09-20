/**
 * Durable, secret-free bindings (docs/contracts/session-manager.md):
 * `driverKey -> projectKey` and `projectKey -> project record`, persisted as
 * one `0600` file inside an owner-private `0700` state directory — never
 * inside a target project. Persisted `targetDir` records are re-validated
 * against the allowed roots at every load with the SAME validators used on
 * write; a record that escaped its root is reported to the caller and refused
 * fail-closed (never silently dropped into auto-creation, never followed).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AllowedRoots, validateProjectKey as validateKey } from "./project-keys";
import {
  type DriverKey,
  type DriverKind,
  type PersistedBindings,
  SessionManagerError,
  type SessionNameSource,
  sessionManagerErrorMessage,
} from "./types";

const BINDINGS_VERSION = 1 as const;
const KNOWN_TOP_KEYS = new Set(["version", "drivers", "projects"]);
const KNOWN_DRIVER_KEYS = new Set(["projectKey", "driverKind"]);
const KNOWN_PROJECT_KEYS = new Set([
  "targetDir",
  "sessionId",
  "profile",
  "name",
  "nameSource",
  "createdAt",
]);
const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{8,63}$/;
const SESSION_FALLBACK_NAME = "New session";

/** Owner-private `0700` state directory, umask-independent (explicit chmod). */
export function ensureStateDir(stateDir: string): string {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.chmodSync(stateDir, 0o700);
  return stateDir;
}

/** Default state root: XDG_STATE_HOME or ~/.local/state — outside every project. */
export function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "", ".local", "state");
  return path.join(base, "ad-coder", "session-manager");
}

export function emptyBindings(): PersistedBindings {
  return { version: BINDINGS_VERSION, drivers: {}, projects: {} };
}

/** Read a private state file as plain JSON; absent stays absent. */
export function readOwnedJson(stateDir: string, file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir, file), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SessionManagerError(
      "invalid_binding",
      true,
      `the private state file could not be parsed`,
      `remove the corrupted file from the private state directory; it will be rebuilt`,
      error,
      file,
    );
  }
}

/** Atomic `0600` write of a private state file (temp + rename, same dir). */
export function writeOwnedJson(stateDir: string, file: string, value: unknown): void {
  ensureStateDir(stateDir);
  const target = path.join(stateDir, file);
  const temp = path.join(stateDir, `.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
}

/**
 * Typed record guard: returns the record or throws. Narrowing via a `never`
 * callback does not survive the entry-map places, so the validator PINS the
 * shape instead of asking control flow to infer it from a returned false.
 */
function asRecord(value: unknown, bad: (reason: string) => never): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad("not a map");
  return value as Record<string, unknown>;
}

/**
 * Load and strictly validate. Unknown persisted fields are refused (a probe
 * test walks this schema); targetDir records are re-validated immediately,
 * while the allowed roots exist, so a stale or hostile record never survives
 * to a turn. Unknown-field and shape violations fail closed.
 */
export function loadBindings(stateDir: string, roots: AllowedRoots): LoadedBindings {
  const raw = readOwnedJson(stateDir, "bindings.json");
  const rejected: { projectKey: string; reason: string }[] = [];
  if (raw === undefined) return { bindings: emptyBindings(), rejected };
  const bad = (reason: string, cause?: unknown): never => {
    throw new SessionManagerError(
      "invalid_binding",
      false,
      `the stored session-manager bindings are ${reason}`,
      "remove the corrupted bindings file from the private state directory; bindings rebuild as sessions are re-created",
      cause,
    );
  };
  const doc = asRecord(raw, bad);
  for (const key of Object.keys(doc)) if (!KNOWN_TOP_KEYS.has(key)) bad(`unknown field "${key}"`);
  if (doc.version !== BINDINGS_VERSION) bad("written by a different version");
  const drivers: PersistedBindings["drivers"] = {};
  const projects: PersistedBindings["projects"] = {};
  if (doc.drivers !== undefined) {
    for (const [driverKey, value] of Object.entries(asRecord(doc.drivers, bad))) {
      const driver = asRecord(value, bad);
      for (const k of Object.keys(driver)) if (!KNOWN_DRIVER_KEYS.has(k)) bad(`unknown field`);
      const boundKey = driver.projectKey;
      if (typeof boundKey !== "string") bad(`driver record is missing its projectKey`);
      try {
        validateKey(boundKey as string);
      } catch (cause) {
        // Fail closed: a poisoned driver record never auto-creates anything.
        bad("a driver record names an unsafe project key", cause);
      }
      const driverKind: DriverKind =
        driver.driverKind === "telegram"
          ? "telegram"
          : driver.driverKind === "console"
            ? "console"
            : bad("a driver record is missing its front kind attribution");
      drivers[driverKey as DriverKey] = { projectKey: boundKey as string, driverKind };
    }
  }
  if (doc.projects !== undefined) {
    for (const [projectKey, value] of Object.entries(asRecord(doc.projects, bad))) {
      const rec = asRecord(value, bad);
      for (const k of Object.keys(rec)) {
        if (!KNOWN_PROJECT_KEYS.has(k)) bad(`unknown field in project record`);
      }
      try {
        validateKey(projectKey);
      } catch (cause) {
        bad("a project record key is not a slug", cause);
      }
      const rejectEntry = (reason: string): void => {
        rejected.push({ projectKey, reason });
      };
      const targetDir = rec.targetDir;
      const sessionId = rec.sessionId;
      const name = rec.name;
      const nameSource = rec.nameSource;
      const createdAt = rec.createdAt;
      const profile = rec.profile;
      if (typeof targetDir !== "string") {
        rejectEntry("project record is missing a string targetDir");
        continue;
      }
      if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
        rejectEntry("project record has an invalid sessionId");
        continue;
      }
      if (typeof name !== "string" || name.length === 0 || name.length > 64) {
        rejectEntry("project record has an invalid name");
        continue;
      }
      if (nameSource !== "generated" && nameSource !== "manual") {
        rejectEntry("project record has an invalid nameSource");
        continue;
      }
      const source: SessionNameSource = nameSource;
      if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) {
        rejectEntry("project record has an invalid createdAt");
        continue;
      }
      if (profile !== undefined && (!(typeof profile === "string") || profile.length > 64)) {
        rejectEntry("project record has an invalid profile");
        continue;
      }
      try {
        // Re-verify the persisted path against the REAL frontier, every load.
        // A record that escaped its root fails CLOSED: it never triggers
        // project creation, never resolves, and is surfaced to the caller.
        let real: string;
        try {
          real = fs.realpathSync.native(targetDir as string);
        } catch {
          throw new SessionManagerError(
            "not_found",
            false,
            "the recorded project directory no longer exists on this machine",
            "re-create the binding; safe creation never adopts a disappeared directory",
          );
        }
        // An immediate child only: a nested descendant of a root is a
        // poisoned record (the root-relative path must EQUAL the key),
        // never a farther-down descendant.
        if (targetDir !== real || !roots.values.some((r) => path.relative(r, real) === projectKey))
          throw new SessionManagerError(
            "unsafe_path",
            false,
            "the recorded project directory no longer resolves immediately inside an allowed root",
            "move the directory back under a configured root, then bind the project again",
          );
        projects[projectKey] = {
          targetDir: real,
          sessionId: sessionId as string,
          ...(profile !== undefined && { profile: profile as string }),
          name: name as string,
          nameSource: source,
          createdAt: createdAt as number,
        };
      } catch (error) {
        rejectEntry(sessionManagerErrorMessage(error));
      }
    }
  }
  return { bindings: { version: BINDINGS_VERSION, drivers, projects }, rejected };
}

export interface LoadedBindings {
  bindings: PersistedBindings;
  rejected: readonly { projectKey: string; reason: string }[];
}

/** Atomic bindings write. No secret is ever a field of this shape. */
export function saveBindings(stateDir: string, bindings: PersistedBindings): void {
  writeOwnedJson(stateDir, "bindings.json", bindings);
}

/** Neutral name constant re-exported for callers avoiding the types import. */
export { SESSION_FALLBACK_NAME };
