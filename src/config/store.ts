import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Document, parseDocument, type Document as YamlDocument } from "yaml";
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
  // An EMPTY `XDG_CONFIG_HOME` means unset, not "the filesystem root". CI sets
  // it to "" and the undefined-only check then resolved to `/ad-coder/...`,
  // which is where a config would have been looked for on any machine with that
  // environment. The XDG spec says a variable set to an empty value is treated
  // as though it were unset, so this follows the spec rather than patching a
  // test: `path.join("", "ad-coder")` silently yields a relative path, which is
  // worse than wrong because it resolves against whatever the cwd happens to be.
  const root =
    xdgConfigHome === undefined || xdgConfigHome === ""
      ? path.join(home, ".config")
      : xdgConfigHome;
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

/**
 * Refuse to create a `models.yaml` that already has a name on disk. `lstat`,
 * not `stat` (and stricter than the seam's `present()`): even a dangling
 * symlink is a name an operator owns, so a hand-edited file is never clobbered
 * by a fresh write, whatever kind of entry sits at the path. A clean `ENOENT`
 * is the only green light; anything else (a permission refusal, an I/O error)
 * is also a refusal -- the write never fires blind on an unconfirmed target.
 */
export function assertModelsFileAbsent(file: string): void {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new ConfigError(
      "invalid_config",
      "models.yaml",
      "cannot confirm the models.yaml target is absent; refusing to write",
    );
  }
  throw new ConfigError(
    "invalid_config",
    "models.yaml",
    "refusing to overwrite an existing models.yaml; move or delete it first, then migrate again",
  );
}

/**
 * Create a FRESH `models.yaml` from already-built config: the counterpart of
 * `saveModelsConfig`, which only edits an existing document. Used by `config
 * migrate`, whose whole-file output has no prior document to preserve
 * comments in. The document is built in the FILE shape (a profile's value is
 * its routes map -- the parser fills the name from the key -- and the default
 * profile's key is `default`), validated through the same `parseModelsConfig`
 * gate BEFORE writing -- a bad projection never lands on disk -- and written
 * through the atomic recipe. The absence guard runs first, so an existing
 * file is refused before anything else happens.
 */
export function writeFreshModelsConfig(file: string, config: ModelsConfig): void {
  assertModelsFileAbsent(file);
  const doc = new Document(toFileShape(config));
  parseModelsConfig(doc.toJS());
  writeAtomically(file, String(doc));
}

/**
 * The stored-document shape of a `ModelsConfig`: exactly what
 * `parseModelsConfig` reads back, with the two memory-to-file renames --
 * `defaultProfile` becomes `default`, and a profile collapses to its routes
 * map because the key names the profile.
 */
function toFileShape(config: ModelsConfig): Record<string, unknown> {
  return {
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([name, provider]) => [
        name,
        { ...provider, models: { ...provider.models } },
      ]),
    ),
    ...(config.defaultProfile === undefined ? {} : { default: config.defaultProfile }),
    profiles: Object.fromEntries(
      Object.entries(config.profiles).map(([name, profile]) => [name, { ...profile.routes }]),
    ),
  };
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
