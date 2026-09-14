import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_INVENTORY_NAME,
  defaultInventoryPath,
  readOrCreateDefaultInventory,
} from "ad-coder";

test("first use installs an editable OpenAI inventory with private permissions", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-inventory-home-"));
  const file = defaultInventoryPath(home);
  const config = readOrCreateDefaultInventory(file);
  expect(config.default).toBe(DEFAULT_INVENTORY_NAME);
  expect(config.profiles[0]?.registry.providers[0]?.id).toBe("openai-codex");
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test("later use preserves the user-owned inventory verbatim", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-inventory-owned-"));
  const file = path.join(root, "inventories.json");
  readOrCreateDefaultInventory(file);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.profiles[0].name = "my-openai";
  parsed.default = "my-openai";
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  expect(readOrCreateDefaultInventory(file).default).toBe("my-openai");
});

test("default inventory refuses a symlink destination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-inventory-link-"));
  const target = path.join(root, "target.json");
  const file = path.join(root, "inventories.json");
  fs.writeFileSync(target, "{}\n");
  fs.symlinkSync(target, file);
  expect(() => readOrCreateDefaultInventory(file)).toThrow("regular file");
});
