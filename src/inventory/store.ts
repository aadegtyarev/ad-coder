import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelInventoryConfig } from "./types";
import { parseModelInventoryConfig } from "./validate";

export function defaultInventoryPath(
  home = os.homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
): string {
  const root = xdgConfigHome === undefined ? path.join(home, ".config") : xdgConfigHome;
  return path.join(root, "ad-coder", "inventories.json");
}

/**
 * Does the retired stored `inventories.json` exist at `file`? ENOENT-only means
 * absent; any other stat failure is rethrown so an unreadable config root is
 * never mistaken for an absent file. Shared by every consumer of the retired
 * route (routing and the auth declared-provider resolution) so the loud retire
 * error fires from one existence rule, never from a silent read.
 */
export function storedInventoryExists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Read an operator-owned inventory file: regular file only, validated whole. */
export function readInventory(file: string): ModelInventoryConfig {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("inventory must be a regular file, not a symlink");
  return parseModelInventoryConfig(JSON.parse(fs.readFileSync(file, "utf8")));
}
