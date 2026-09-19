import * as fs from "node:fs";
import { ConfigError } from "./errors";
import { loadModelsConfig, loadSettingsConfig } from "./store";
import type { ModelsConfig, SettingsConfig } from "./types";

/**
 * The resolver's config-loading seam: the one place the stored YAML documents
 * cross from "a path on this machine" to "a validated config or a typed
 * refusal". Two contracts live HERE, not in the store, so the store's internals
 * stay a plain read/validate/write and this layer owns the resolver's reading
 * policy.
 *
 * ABSENCE DETECTION (D4). Never `fs.existsSync` (it follows symlinks and
 * returns true for a directory). `statSync` on the injected path: `ENOENT`
 * means absent (the defaults case); a symlink or a directory is NOT absence --
 * it is a file the store must refuse, so it is handed to `load*` and the
 * store's own typed refusal surfaces. A present-but-empty `settings.yaml` stays
 * refused exactly as the validator documents it, not silently defaulted.
 *
 * PATH LEAK (D5). `loadModelsConfig`/`loadSettingsConfig` put the ABSOLUTE file
 * path into `ConfigError.detail` (and a raw fs error can bubble out of the
 * stat the store performs). A path carries the machine's username and XDG
 * expansion, which must never reach `config show`/banner output an operator
 * pastes. When a ConfigError crosses this seam, its `detail` -- when it is the
 * injected absolute path -- is rewritten to the LOGICAL name
 * (`models.yaml`/`settings.yaml`); the code and the message's own prefix are
 * already logical-name-only. Non-path details (a field path, a provider name)
 * are untouched.
 */

/** The defaults a completely absent `settings.yaml` means (documented, not bypassed). */
export const DEFAULT_SETTINGS: SettingsConfig = {
  review: { requireStamp: "auto", costSignature: false },
  providerAdmission: {},
};

/** True when the path names a present entry (file, symlink, or directory). */
function present(path: string): boolean {
  try {
    fs.statSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    // Anything else (permission, a dangling link's broken target) is a refusal
    // for the load to surface, not "absent".
    return true;
  }
}

/** Rewrite a ConfigError whose `detail` is the injected path to the logical name. */
function remapPathDetail<T>(path: string, logicalName: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ConfigError) {
      if (error.detail === path) throw new ConfigError(error.code, logicalName, error.message);
      throw error;
    }
    // A raw fs error (e.g. a permission refusal on lstat/readFileSync) carries
    // the absolute path in its own message; scrub that too rather than let a
    // machine-local path cross the seam (D5).
    if (error instanceof Error && error.message.includes(path)) {
      throw new ConfigError(
        "invalid_config",
        logicalName,
        error.message.split(path).join(logicalName),
      );
    }
    throw error;
  }
}

/**
 * `models.yaml`, or `undefined` when the file is absent (the resolver's
 * "try YAML first, fall back to JSON" branch uses absence as its switch).
 * A present-but-unusable file throws a typed `ConfigError` whose `detail`
 * names the provider/model/field or the LOGICAL file name -- never a path.
 */
export function loadModelsConfigSeam(path: string): ModelsConfig | undefined {
  if (!present(path)) return undefined;
  return remapPathDetail(path, "models.yaml", () => loadModelsConfig(path));
}

/**
 * `settings.yaml`, or the documented defaults when the file is absent. A
 * present-but-empty or malformed file throws a typed `ConfigError` -- absence
 * is the ONLY source of defaults.
 */
export function loadSettingsConfigSeam(path: string): SettingsConfig {
  if (!present(path)) return { ...DEFAULT_SETTINGS, review: { ...DEFAULT_SETTINGS.review } };
  return remapPathDetail(path, "settings.yaml", () => loadSettingsConfig(path));
}
