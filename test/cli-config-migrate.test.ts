import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigError } from "../src/config/errors";
import { loadModelsConfig, writeFreshModelsConfig } from "../src/config/store";
import type { ModelsConfig } from "../src/config/types";
import type { ModelInventoryConfig } from "../src/inventory/types";
import type { Complexity } from "../src/orchestration/types";
import type { ProfileEntry, ProfileRole } from "../src/profiles/types";

/**
 * Synthetic fixtures in temp dirs only: fake provider/model names, a fake
 * env-var NAME, and an `XDG_CONFIG_HOME` pointing into a per-test temp dir, so
 * no test ever reads the machine's real `~/.config/ad-coder` files.
 */
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(REPO_ROOT, "src/cli.ts");

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function tempConfigHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-migrate-cli-"));
  fs.mkdirSync(path.join(home, "ad-coder"), { recursive: true });
  return home;
}

function writeInventory(home: string, config: ModelInventoryConfig): string {
  const file = path.join(home, "ad-coder", "inventories.json");
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

const KEY = { kind: "env-var", envVar: "TEST_PROVIDER_API_KEY" } as const;

function bigModel() {
  return {
    name: "big",
    modelId: "test-big",
    contextWindow: 128000,
    maxTokens: 32000,
    cost: { input: 3, output: 15, cacheRead: 1.5, cacheWrite: 3 },
  };
}

function smallModel() {
  return {
    name: "small",
    modelId: "test-small",
    contextWindow: 64000,
    maxTokens: 8000,
    cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

function entry(role: ProfileRole, complexity: Complexity, model: string): ProfileEntry {
  return { role, complexity, model };
}

function tiers(role: ProfileRole, model: string): ProfileEntry[] {
  return (["trivial", "medium", "complex"] as const).map((tier) => entry(role, tier, model));
}

function goodInventory(): ModelInventoryConfig {
  return {
    profiles: [
      {
        name: "work",
        registry: {
          providers: [
            {
              id: "test-provider",
              api: "openai-completions",
              baseUrl: "https://test.example.com/v1",
              credential: KEY,
              models: [bigModel(), smallModel()],
            },
          ],
        },
        profile: { entries: [...tiers("coder", "big"), ...tiers("reviewer", "small")] },
      },
    ],
    default: "work",
  };
}

test("config migrate writes the projected models.yaml and exits 0 (default paths)", () => {
  const home = tempConfigHome();
  writeInventory(home, goodInventory());
  const output = path.join(home, "ad-coder", "models.yaml");

  const result = runCli(["config", "migrate"], { XDG_CONFIG_HOME: home });

  expect(result.code).toBe(0);
  expect(fs.existsSync(output)).toBe(true);
  const written = fs.readFileSync(output, "utf8");
  expect(written).toContain("default: work");
  expect(written).toContain("TEST_PROVIDER_API_KEY");
  const config = loadModelsConfig(output);
  expect(config.defaultProfile).toBe("work");
  expect(config.profiles.work!.routes.coder).toEqual(["test-provider:test-big"]);
  expect(config.profiles.work!.routes.reviewer).toEqual(["test-provider:test-small"]);
  expect(config.providers["test-provider"]!.credential).toBe("TEST_PROVIDER_API_KEY");
  // Success is a summary, not a path dump: stdout never carries the config home.
  expect(result.stdout).not.toContain(home);
  expect(result.stdout).toContain("profile names are preserved");
  expect(result.stdout).toContain("routing rows: 6");
  expect(result.stdout).toContain("dropped extras: 0");
});

test("explicit --inventory/--output flags are honored", () => {
  const home = tempConfigHome();
  const inventory = writeInventory(home, goodInventory());
  const output = path.join(home, "elsewhere", "models.yaml");
  expect(fs.existsSync(output)).toBe(false);

  const result = runCli(["config", "migrate", "--inventory", inventory, "--output", output], {
    XDG_CONFIG_HOME: home,
  });

  expect(result.code).toBe(0);
  expect(fs.existsSync(output)).toBe(true);
  expect(loadModelsConfig(output).defaultProfile).toBe("work");
});

function conflictingInventory(): ModelInventoryConfig {
  const base = goodInventory().profiles[0]!;
  return {
    profiles: [
      base,
      {
        name: "other",
        registry: {
          providers: [{ ...base.registry.providers[0]!, api: "anthropic-messages" }],
        },
        profile: { entries: tiers("coder", "big") },
      },
    ],
    default: "work",
  };
}

function oauthInventory(): ModelInventoryConfig {
  const base = goodInventory().profiles[0]!;
  return {
    profiles: [
      {
        ...base,
        registry: {
          providers: [{ ...base.registry.providers[0]!, credential: { kind: "oauth" } }],
        },
      },
    ],
    default: "work",
  };
}

for (const [name, inventory] of [
  ["a provider conflict", conflictingInventory()] as const,
  ["an oauth provider", oauthInventory()] as const,
] as const) {
  test(`all-or-nothing: ${name} prints the report and writes NOTHING`, () => {
    const home = tempConfigHome();
    const inventoryFile = writeInventory(home, inventory);
    const output = path.join(home, "ad-coder", "models.yaml");

    const result = runCli(["config", "migrate", "--inventory", inventoryFile], {
      XDG_CONFIG_HOME: home,
    });

    expect(result.code).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
    // The full report reaches stdout so the operator can see WHY nothing landed.
    expect(result.stdout).toContain("notExpressible");
    expect(result.stdout).not.toContain("stub-credential");
  });
}

test("config migrate refuses to overwrite an existing models.yaml", () => {
  const home = tempConfigHome();
  writeInventory(home, goodInventory());
  const output = path.join(home, "ad-coder", "models.yaml");
  const handEdited = "# hand-edited\nproviders: {}\n";
  fs.writeFileSync(output, handEdited);

  const result = runCli(["config", "migrate"], { XDG_CONFIG_HOME: home });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("refusing to overwrite");
  expect(fs.readFileSync(output, "utf8")).toBe(handEdited);
});

test("the fresh writer validates BEFORE writing: an invalid config lands nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-migrate-writer-"));
  const file = path.join(dir, "models.yaml");
  // A model row without a price is refused by parseModelsConfig; the writer
  // must catch that through the document, not trust its input.
  const invalid = {
    providers: {
      "test-provider": { enabled: true, models: { "test-big": { output: 2 } } },
    },
    profiles: { work: { name: "work", routes: { coder: ["test-provider:test-big"] } } },
  } as unknown as ModelsConfig;

  expect(() => writeFreshModelsConfig(file, invalid)).toThrow(ConfigError);
  expect(fs.existsSync(file)).toBe(false);
});

test("the fresh writer emits the file shape and refuses an existing target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-migrate-writer-"));
  const file = path.join(dir, "models.yaml");
  const config: ModelsConfig = {
    providers: {
      "test-provider": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://test.example.com/v1",
        credential: "TEST_PROVIDER_API_KEY",
        models: {
          "test-big": {
            input: 3,
            output: 15,
            cacheRead: 1.5,
            contextWindow: 128000,
            maxTokens: 32000,
          },
        },
      },
    },
    defaultProfile: "work",
    profiles: { work: { name: "work", routes: { coder: ["test-provider:test-big"] } } },
  };

  writeFreshModelsConfig(file, config);
  const text = fs.readFileSync(file, "utf8");
  expect(text).toContain("default: work");
  const roundTrip = loadModelsConfig(file);
  expect(roundTrip).toEqual(config);

  // A hand-edited file is never clobbered by a fresh write.
  fs.writeFileSync(file, "# hand-edited\nproviders: {}\n");
  expect(() => writeFreshModelsConfig(file, config)).toThrow(/refusing to overwrite/);
  expect(fs.readFileSync(file, "utf8")).toBe("# hand-edited\nproviders: {}\n");
});
