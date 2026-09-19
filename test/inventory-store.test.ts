import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultInventoryPath } from "ad-coder";
import { readInventory } from "../src/inventory/store";

const validInventory = {
  profiles: [
    {
      name: "legacy",
      registry: {
        providers: [
          {
            id: "jsonprov",
            api: "openai-completions",
            baseUrl: "https://json.example.com",
            credential: { kind: "env-var", envVar: "JSON_KEY" },
            models: [
              {
                name: "json-model",
                modelId: "json-model",
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        ],
      },
      profile: {
        entries: [{ role: "orchestrator", complexity: "trivial", model: "json-model" }],
      },
    },
  ],
  default: "legacy",
};

test("readInventory reads an operator-owned file verbatim", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-inventory-owned-"));
  const file = path.join(root, "inventories.json");
  fs.writeFileSync(file, `${JSON.stringify(validInventory, null, 2)}\n`);
  expect(readInventory(file).default).toBe("legacy");
});

test("readInventory refuses a symlink destination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-inventory-link-"));
  const target = path.join(root, "target.json");
  const file = path.join(root, "inventories.json");
  fs.writeFileSync(target, "{}\n");
  fs.symlinkSync(target, file);
  expect(() => readInventory(file)).toThrow("regular file");
});

test("readInventory on an absent path throws and creates NOTHING", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-inventory-absent-"));
  const file = path.join(root, "inventories.json");
  expect(() => readInventory(file)).toThrow(/ENOENT/);
  // First use seeds nothing: the stored JSON route is retired (2026-09-19).
  expect(fs.readdirSync(root)).toEqual([]);
});

test("defaultInventoryPath points at the ad-coder config root", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-inventory-home-"));

  // An explicit XDG_CONFIG_HOME argument wins over home, whatever the
  // ambient environment holds: the value is passed in, not read from env.
  const xdgDir = path.join(home, "xdg");
  expect(defaultInventoryPath(home, xdgDir)).toBe(
    path.join(xdgDir, "ad-coder", "inventories.json"),
  );

  // Without XDG_CONFIG_HOME the config root is home/.config; the ambient
  // value must be cleared or this branch cannot be asserted hermetically.
  const savedXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    expect(defaultInventoryPath(home)).toBe(
      path.join(home, ".config", "ad-coder", "inventories.json"),
    );
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  }
});
