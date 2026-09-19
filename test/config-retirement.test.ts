import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePipelineConfig } from "../src/cli/resolve-config";

/** An absolute-path caveat guard: every test confines reads to a temp dir. */
function scratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ad-coder-retire-${label}-`));
}

const silent = (): void => {};

function fakeEnv(vars: Record<string, string>): (name: string) => string | undefined {
  return (name: string) => vars[name];
}

/** A minimal legacy stored inventories.json: one profile routing every role. */
function writeStoredInventory(dir: string): string {
  const file = path.join(dir, "inventories.json");
  const entries = (
    [
      "orchestrator",
      "planner",
      "researcher",
      "coder",
      "reviewer",
      "auditor",
      "security",
      "summarizer",
    ] as const
  ).flatMap((role) =>
    (["trivial", "medium", "complex"] as const).map((complexity) => ({
      role,
      complexity,
      model: "json-model",
    })),
  );
  fs.writeFileSync(
    file,
    JSON.stringify({
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
          profile: { entries },
        },
      ],
      default: "legacy",
    }),
  );
  return file;
}

// ---------------------------------------------------------------------------
// (a) models.yaml absent + stored inventories.json PRESENT -> loud retire error

test("(a) an absent models.yaml with a stored inventories.json is a loud migrate-pointer error", () => {
  const dir = scratch("present");
  try {
    const inventoryPath = writeStoredInventory(dir);
    const before = fs.readFileSync(inventoryPath, "utf8");
    let error: unknown;
    try {
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        modelsConfigPath: path.join(dir, "models.yaml"), // absent
        inventoryPath,
        env: fakeEnv({}),
        warn: silent,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("inventories.json");
    expect(message).toContain("no longer a routing source");
    expect(message).toContain("config migrate");
    // Logical name only: never the operator's path, never a credential value.
    expect(message).not.toContain(dir);
    // The stored JSON is untouched and nothing else was written.
    expect(fs.readFileSync(inventoryPath, "utf8")).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(["inventories.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) both stored sources ABSENT + DEEPSEEK_API_KEY -> env-preset route

test("(b) both stored sources absent with DEEPSEEK_API_KEY resolves the env-preset route and writes nothing", () => {
  const dir = scratch("env");
  try {
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: path.join(dir, "models.yaml"), // absent
      inventoryPath: path.join(dir, "inventories.json"), // absent
      env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
      warn: silent,
    });
    expect(config.delegatedRoute?.source).toBe('provider "deepseek"');
    // NO file is created anywhere in the scratch dir: no seeding on first use.
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) both stored sources ABSENT, no env keys -> codex fallback path entered

test("(c) both stored sources absent with no env keys takes the codex fallback and writes nothing", () => {
  const dir = scratch("codex");
  try {
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: path.join(dir, "models.yaml"), // absent
      inventoryPath: path.join(dir, "inventories.json"), // absent
      env: fakeEnv({}),
      warn: silent,
    });
    expect(config.delegatedRoute?.source).toBe('provider "openai-codex"');
    // The assertion is file absence, not oauth behaviour: resolution must not
    // materialize a stored routing source on first use.
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
