import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildInstalledInventoryConfig } from "./default-config";
import type { ModelInventoryConfig } from "./types";
import { parseModelInventoryConfig } from "./validate";

export function defaultInventoryPath(
  home = os.homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
): string {
  const root = xdgConfigHome === undefined ? path.join(home, ".config") : xdgConfigHome;
  return path.join(root, "ad-coder", "inventories.json");
}

/** Create the editable built-in inventory once, then only read user-owned contents. */
export function readOrCreateDefaultInventory(file = defaultInventoryPath()): ModelInventoryConfig {
  try {
    return readInventory(file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const config = buildInstalledInventoryConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(path.dirname(file));
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("inventory directory must be a real directory");
  const temporary = path.join(path.dirname(file), `.inventories.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.linkSync(temporary, file);
    return config;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return readInventory(file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readInventory(file: string): ModelInventoryConfig {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("inventory must be a regular file, not a symlink");
  return parseModelInventoryConfig(JSON.parse(fs.readFileSync(file, "utf8")));
}
