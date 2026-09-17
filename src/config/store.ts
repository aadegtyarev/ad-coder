import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Document as YamlDocument } from "yaml";
import { parseDocument } from "yaml";
import { ConfigError } from "./errors";
import type { ModelsConfig, SettingsConfig } from "./types";
import { parseModelsConfig, parseSettingsConfig } from "./validate";

/**
 * Read and write the operator-edited YAML files under
 * `(XDG_CONFIG_HOME ?? ~/.config)/ad-coder`. Loading parses and validates the
 * whole document before any consumer sees a field; saving applies an edit to
 * the parsed Document so untouched comments survive, then validates the edited
 * document BEFORE writing -- a bad edit never lands on disk. The write follows
 * the atomic recipe from `src/inventory/store.ts`: a hard-linked temp file, so
 * a crash mid-write leaves the previous document intact, never a truncated one.
 */

export function defaultModelsPath(
  home = os.homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
): string {
  return resolveConfigPath("models.yaml", home, xdgConfigHome);
}

export function defaultSettingsPath(
  home = os.homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
): string {
  return resolveConfigPath("settings.yaml", home, xdgConfigHome);
}

function resolveConfigPath(file: string, home: string, xdgConfigHome: string | undefined): string {
  const root = xdgConfigHome === undefined ? path.join(home, ".config") : xdgConfigHome;
  return path.join(root, "ad-coder", file);
}

export function loadModelsConfig(file = defaultModelsPath()): ModelsConfig {
  return parseModelsConfig(readDocument(file, "models.yaml").toJS());
}

export function loadSettingsConfig(file = defaultSettingsPath()): SettingsConfig {
  return parseSettingsConfig(readDocument(file, "settings.yaml").toJS());
}

export function saveModelsConfig(file: string, edit: (doc: YamlDocument) => void): ModelsConfig {
  const doc = readDocument(file, "models.yaml");
  edit(doc);
  const config = parseModelsConfig(doc.toJS());
  writeAtomically(file, String(doc));
  return config;
}

function readDocument(file: string, name: "models.yaml" | "settings.yaml"): YamlDocument {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ConfigError("invalid_config", file, `${name} must be a regular file, not a symlink`);
  const doc = parseDocument(fs.readFileSync(file, "utf8"), { prettyErrors: false });
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    const first = (doc.errors.length > 0 ? doc.errors : doc.warnings)[0];
    // Name the file and the line only -- never the offending content, which can
    // be a header value or credential the operator meant to keep secret.
    throw new ConfigError(
      "invalid_config",
      file,
      `${name} is not valid YAML at line ${first?.pos?.[0] ?? "(unknown)"}`,
    );
  }
  return doc;
}

function writeAtomically(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(path.dirname(file));
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new ConfigError(
      "invalid_config",
      path.dirname(file),
      "config directory must be a real directory, not a symlink",
    );
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // `rename`, not `link`: this REPLACES an existing document, and a hard link
    // cannot overwrite its target -- it fails EEXIST, which for an update is
    // always, not a race. The inventory store links because it only ever
    // CREATES a file and treats EEXIST as "someone else got there first, read
    // theirs"; copying that shape here made every save fail with a concurrency
    // error on a file the caller had just read. `rename` within one directory
    // is atomic, so a reader sees the old document or the new one, never a
    // partial write.
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
