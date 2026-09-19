import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePipelineConfig } from "../src/cli/resolve-config";
import { ConfigError } from "../src/config/errors";
import { loadModelsConfigSeam, loadSettingsConfigSeam } from "../src/config/seam";
import { toRegistryAndProfile } from "../src/config/to-registry";
import type { SettingsConfig } from "../src/config/types";
import { parseModelsConfig } from "../src/config/validate";
import { RegistryError } from "../src/registry/errors";
import type { RegistryConfig } from "../src/registry/types";
import { DEFAULT_CONTEXT_WINDOW, parseRegistryConfig } from "../src/registry/validate";
import {
  checkReviewStamps,
  recordReviewStampFromResult,
  resolveStampRequirement,
  STAMPS_MARKER_FILE,
} from "../src/stamp/record-review-stamp";

/** An absolute-path caveat guard: every test confines reads to a temp dir. */
function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-seam-"));
}

const silent = (): void => {};

function fakeEnv(vars: Record<string, string>): (name: string) => string | undefined {
  return (name: string) => vars[name];
}

/** A minimal standalone registry for the no-inventory (preset) path. */
function defaultRegistry(): RegistryConfig {
  return {
    providers: [
      {
        id: "local",
        api: "openai-completions",
        baseUrl: "https://localhost.example/v1",
        credential: { kind: "env-var", envVar: "LOCAL_KEY" },
        models: [
          {
            name: "local-model",
            modelId: "local-model",
            contextWindow: 32000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ],
  };
}

/**
 * A minimal, fully-valid models.yaml shape: one enabled provider
 * ("opencode-go"), one model, and a `daily` profile routing EVERY role to it
 * (a resolver needs every `PROFILE_ROLES` cell, summarizer included).
 */
function modelsYaml(): string {
  return `providers:
  opencode-go:
    enabled: true
    api: openai-completions
    baseUrl: https://opencode.example.com
    credential: OPENCODE_API_KEY
    models:
      glm-5.3-flash: {input: 0.15, output: 0.5}
default: daily
profiles:
  daily:
    orchestrator: opencode-go:glm-5.3-flash
    planner: opencode-go:glm-5.3-flash
    researcher: opencode-go:glm-5.3-flash
    coder: opencode-go:glm-5.3-flash
    reviewer: opencode-go:glm-5.3-flash
    auditor: opencode-go:glm-5.3-flash
    security: opencode-go:glm-5.3-flash
    summarizer: opencode-go:glm-5.3-flash
`;
}

function writeModels(dir: string, contents: string): string {
  const file = path.join(dir, "models.yaml");
  fs.writeFileSync(file, contents);
  return file;
}

/** A scratch git repo, so the stamp writer's tree digest can run. */
function gitRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-seam-git-")));
  const run = (args: string[]): void => {
    const child = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
  };
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(dir, "f.txt"), "one\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

// ---------------------------------------------------------------------------
// (b) credential NAME projection + (b2) absent credential on an enabled provider

test("a declared credential becomes an env-var reference that parseRegistryConfig accepts", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://opencode.example.com",
        credential: "TEST_VAR_NAME",
        models: { "glm-5.3-flash": { input: 0.15, output: 0.5 } },
      },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
  const { registry } = toRegistryAndProfile(config, "daily");
  const resolved = parseRegistryConfig(registry);
  expect(resolved.providers[0]?.credential).toEqual({
    kind: "env-var",
    envVar: "TEST_VAR_NAME",
  });
});

test("a credential is a NAME only -- the env-var reference is never resolved to a value here", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://opencode.example.com",
        credential: "MY_PROVIDER_SECRET_REF",
        models: { "glm-5.3-flash": { input: 0.15, output: 0.5 } },
      },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
  const { registry } = toRegistryAndProfile(config, "daily");
  // The string is the env-var NAME, never a resolved value, never echoed as a value.
  expect(registry.providers[0]?.credential).toEqual({
    kind: "env-var",
    envVar: "MY_PROVIDER_SECRET_REF",
  });
});

test("(b2) an enabled provider with no credential is refused, naming the provider only", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://opencode.example.com",
        models: { "glm-5.3-flash": { input: 0.15, output: 0.5 } },
      },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
  expect(() => toRegistryAndProfile(config, "daily")).toThrow(ConfigError);
  try {
    toRegistryAndProfile(config, "daily");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const ce = error as ConfigError;
    expect(ce.code).toBe("invalid_config");
    expect(ce.detail).toBe("opencode-go");
    expect(ce.message).toContain('"opencode-go"');
  }
});

// ---------------------------------------------------------------------------
// (d) enabled:false provider unrouted

test("a disabled provider is filtered out entirely -- no credential needed", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://opencode.example.com",
        credential: "OPENCODE_API_KEY",
        models: { "glm-5.3-flash": { input: 0.15, output: 0.5 } },
      },
      dormant: {
        enabled: false,
        // no credential, no baseUrl: a disabled provider owes neither
        models: { "ghost-model": { input: 0.2, output: 0.6 } },
      },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
  const { registry } = toRegistryAndProfile(config, "daily");
  expect(registry.providers.map((p) => p.id)).toEqual(["opencode-go"]);
  // And nothing about the disabled provider reaches the registry.
  expect(JSON.stringify(registry)).not.toContain("ghost-model");
});

// ---------------------------------------------------------------------------
// (d2) enabled provider with neither credential nor endpoint -> typed error
// (i) baseUrl defaulting: provider wins, first model fills in, neither errors

test("(d2/i) an enabled provider with no endpoint is refused even when it has a credential", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        credential: "OPENCODE_API_KEY",
        models: { "glm-5.3-flash": { input: 0.15, output: 0.5 } },
      },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
  expect(() => toRegistryAndProfile(config, "daily")).toThrow(ConfigError);
  try {
    toRegistryAndProfile(config, "daily");
  } catch (error) {
    expect((error as ConfigError).code).toBe("invalid_config");
    expect((error as ConfigError).detail).toBe("opencode-go");
    expect((error as ConfigError).message).toContain("baseUrl");
  }
});

test("(i) the first model's baseUrl fills the provider when the provider omits it", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        credential: "OPENCODE_API_KEY",
        models: {
          "glm-5.3-flash": {
            input: 0.15,
            output: 0.5,
            baseUrl: "https://model.example.com/v1",
          },
        },
      },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
  const { registry } = toRegistryAndProfile(config, "daily");
  expect(registry.providers[0]?.baseUrl).toBe("https://model.example.com/v1");
});

test("(i) a provider-level baseUrl wins over the model's own endpoint", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://provider.example.com",
        credential: "OPENCODE_API_KEY",
        models: {
          "glm-5.3-flash": {
            input: 0.15,
            output: 0.5,
            baseUrl: "https://model.example.com/v1",
          },
        },
      },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
  const { registry } = toRegistryAndProfile(config, "daily");
  expect(registry.providers[0]?.baseUrl).toBe("https://provider.example.com");
});

// ---------------------------------------------------------------------------
// (g) invalid models.yaml -> ConfigError, identifiers only

test("(g) a rejected models.yaml surfaces the logical name, never a path or a value", () => {
  const dir = scratch();
  try {
    const file = writeModels(
      dir,
      "providers:\n  opencode-go:\n    enabled: true\n    api: openai-completions\n    credential: OPENCODE_API_KEY\n    baseUrl: https://x.example\n    models:\n      glm: {input: 0.1, output: 0.1}\nprofiles:\n  daily:\n    coder: opencode-go:unlisted-model\n",
    );
    // The rung names a model the provider does not declare: refuse by NAME.
    try {
      loadModelsConfigSeam(file);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const ce = error as ConfigError;
      // Identifiers only: the offending model name, never a path, never a
      // credential name embedded in the message.
      expect(ce.detail).toBe("unlisted-model");
      expect(ce.message).toContain("unlisted-model");
      expect(ce.message).not.toContain("OPENCODE_API_KEY");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(g) an invalid models.yaml is a typed error, not a silent JSON fallback", () => {
  const dir = scratch();
  try {
    // A present models.yaml with an unknown provider rung: the seam must throw,
    // never fall back to inventories.json.
    const file = writeModels(
      dir,
      "providers:\n  opencode-go:\n    enabled: true\n    api: openai-completions\n    credential: OPENCODE_API_KEY\n    baseUrl: https://x.example\n    models:\n      glm: {input: 0.1, output: 0.1}\nprofiles:\n  daily:\n    coder: nope:glm\n",
    );
    expect(() => loadModelsConfigSeam(file)).toThrow(ConfigError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (h) settings seam: absent -> defaults, empty present -> refused

test("(h) an absent settings.yaml means the documented defaults", () => {
  const dir = scratch();
  try {
    const settings = loadSettingsConfigSeam(path.join(dir, "settings.yaml"));
    expect(settings).toEqual({ review: { requireStamp: "auto", costSignature: false } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(h) a present-but-empty settings.yaml stays refused, not silently defaulted", () => {
  const dir = scratch();
  try {
    const file = path.join(dir, "settings.yaml");
    fs.writeFileSync(file, "");
    expect(() => loadSettingsConfigSeam(file)).toThrow(ConfigError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (f) require-stamp resolution + writer/checker agreement

function settingsWith(requireStamp: "auto" | "on" | "off"): SettingsConfig {
  return { review: { requireStamp, costSignature: false } };
}

function settledResult() {
  return {
    approved: true,
    runIds: ["run-1"],
    stageMetrics: [{ stage: "review:1", provider: "v", model: "m" }],
    reviewRan: true,
  };
}

test("(f) require-stamp on/off/auto resolve exactly as declared", () => {
  expect(resolveStampRequirement(settingsWith("on"))).toBe("on");
  expect(resolveStampRequirement(settingsWith("off"))).toBe("off");
  expect(resolveStampRequirement(settingsWith("auto"))).toBe("auto");
  expect(resolveStampRequirement(undefined)).toBe("auto");
});

test("(f) require-stamp off silences BOTH the writer and the gate", () => {
  const dir = scratch();
  try {
    fs.writeFileSync(path.join(dir, STAMPS_MARKER_FILE), JSON.stringify({ file: "stamps.log" }));
    // Writer: no stamp written even though a marker exists.
    const written = recordReviewStampFromResult(dir, settledResult(), new Date(), "off");
    expect(written.recorded).toBe(false);
    // Gate: passes even though no stamp was ever written (the failure mode a
    // half-wired off would manufacture).
    const gate = checkReviewStamps(dir, "off");
    expect(gate.ok).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(f) require-stamp on writes and requires even without a marker", () => {
  const dir = gitRepo();
  try {
    const written = recordReviewStampFromResult(dir, settledResult(), new Date(), "on");
    expect(written.recorded).toBe(true);
    const gate = checkReviewStamps(dir, "on");
    expect(gate.ok).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(f) auto keeps the marker-governed behaviour for writer and gate alike", () => {
  const dir = gitRepo();
  try {
    // No marker: the writer stays off, exactly today.
    fs.rmSync(path.join(dir, STAMPS_MARKER_FILE), { force: true });
    expect(recordReviewStampFromResult(dir, settledResult()).recorded).toBe(false);
    // With a marker: the writer writes and the gate requires a fresh stamp.
    fs.writeFileSync(path.join(dir, STAMPS_MARKER_FILE), JSON.stringify({ file: "stamps.log" }));
    expect(recordReviewStampFromResult(dir, settledResult()).recorded).toBe(true);
    expect(checkReviewStamps(dir).ok).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (a) YAML-first precedence at the resolver seam
// (e/e2) banner/effectiveConfig source + no-default typed error

function writeInventory(dir: string, name: string): string {
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
  const inventory = {
    profiles: [
      {
        name,
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
    default: name,
  };
  fs.writeFileSync(file, JSON.stringify(inventory));
  return file;
}

test("(a) models.yaml wins when both it and inventories.json are present", () => {
  const dir = scratch();
  try {
    const modelsPath = writeModels(dir, modelsYaml());
    writeInventory(dir, "json-profile");
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: modelsPath,
      inventoryPath: path.join(dir, "inventories.json"),
      settingsConfigPath: path.join(dir, "settings.yaml"),
      env: fakeEnv({ OPENCODE_API_KEY: "k" }),
      warn: silent,
    });
    // YAML won: the banner/effectiveConfig name models.yaml, not the JSON name.
    expect(config.delegatedRoute?.source).toBe('models.yaml "daily"');
    expect(config.effectiveConfig?.inventoryProfile?.source).toBe("models.yaml");
    expect(config.effectiveConfig?.inventoryProfile?.value).toBe("daily");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(a) only-JSON is retired: an absent models.yaml with a stored inventories.json errors", () => {
  const dir = scratch();
  try {
    writeInventory(dir, "json-profile");
    // The stored JSON route is retired (2026-09-19): loud, never a silent
    // fallback to env presets, never a silent switch to the seeded file.
    expect(() =>
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        modelsConfigPath: path.join(dir, "models.yaml"), // absent
        inventoryPath: path.join(dir, "inventories.json"),
        settingsConfigPath: path.join(dir, "settings.yaml"),
        env: fakeEnv({ JSON_KEY: "k" }),
        warn: silent,
      }),
    ).toThrow(/no longer a routing source/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(a2) a role-model flag keeps the models.yaml seam entered, overriding just that role", () => {
  const dir = scratch();
  try {
    // Two models so the coder override lands on a model the daily profile does
    // not otherwise route: composition must not disable the stored seam.
    const twoModels = modelsYaml().replace(
      "models:\n      glm-5.3-flash: {input: 0.15, output: 0.5}\n",
      "models:\n      glm-5.3-flash: {input: 0.15, output: 0.5}\n      glm-5.3-pro: {input: 0.5, output: 2.0}\n",
    );
    const modelsPath = writeModels(dir, twoModels);
    writeInventory(dir, "json-profile");
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: modelsPath,
      inventoryPath: path.join(dir, "inventories.json"),
      settingsConfigPath: path.join(dir, "settings.yaml"),
      coderModel: "glm-5.3-pro",
      env: fakeEnv({ OPENCODE_API_KEY: "k" }),
      warn: silent,
    });
    // The seam stays ENTERED (models.yaml won), not disabled by the role flag.
    expect(config.delegatedRoute?.source).toBe('models.yaml "daily"');
    expect(config.effectiveConfig?.inventoryProfile?.source).toBe("models.yaml");
    // The override pinches just the coder cell; the planner still takes the
    // profile's own route.
    expect(config.roles.coder.model.name).toBe("glm-5.3-pro");
    expect(config.roles.planner?.model.name).toBe("glm-5.3-flash");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(a3) an override naming an unregistered model with an inventory selected is a typed error naming both", () => {
  const dir = scratch();
  try {
    const inventoryPath = writeInventory(dir, "json-profile");
    try {
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        inventoryConfig: JSON.parse(fs.readFileSync(inventoryPath, "utf8")),
        coderModel: "not-registered",
        env: fakeEnv({ JSON_KEY: "k" }),
        warn: silent,
      });
      expect.unreachable();
    } catch (error) {
      // Typed `unknown_model` naming BOTH the inventory/profile and the override.
      expect(error).toBeInstanceOf(RegistryError);
      const re = error as RegistryError;
      expect(re.code).toBe("unknown_model");
      expect(re.detail).toBe("not-registered");
      expect(re.message).toContain('inventory "json-profile"');
      expect(re.message).toContain('"not-registered"');
    }
    // The preset path (no inventory) keeps the registry's own error, which does
    // NOT name an inventory: it is the existing generic `unknown_model`/profile
    // refusal, unchanged.
    try {
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        registryConfig: defaultRegistry(),
        coderModel: "not-registered",
        env: fakeEnv({ LOCAL_KEY: "k" }),
        warn: silent,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("inventory");
      expect((error as Error).message).toContain("not-registered");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(e2) present models.yaml with no default and no selected profile is a typed error", () => {
  const dir = scratch();
  try {
    // No `default:` key, and no `inventoryProfile` flag.
    const modelsPath = writeModels(dir, modelsYaml().replace("default: daily\n", ""));
    expect(() =>
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        modelsConfigPath: modelsPath,
        inventoryPath: path.join(dir, "inventories.json"),
        settingsConfigPath: path.join(dir, "settings.yaml"),
        env: fakeEnv({ OPENCODE_API_KEY: "k" }),
        warn: silent,
      }),
    ).toThrow(ConfigError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c) role@complexity replaces the bare row at that tier ONLY

test("(c) a role@complexity row replaces that tier only, keeping the bare row elsewhere", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://opencode.example.com",
        credential: "OPENCODE_API_KEY",
        models: {
          "glm-5.3-flash": { input: 0.15, output: 0.5 },
          "minimax-m3": { input: 0.3, output: 1.2 },
        },
      },
    },
    profiles: {
      daily: {
        coder: "opencode-go:glm-5.3-flash",
        "coder@complex": "opencode-go:minimax-m3",
      },
    },
  });
  const { profile } = toRegistryAndProfile(config, "daily");
  const cells = Object.fromEntries(
    profile.entries.map((e) => [`${e.role}@${e.complexity}`, e.model]),
  );
  expect(cells["coder@trivial"]).toBe("glm-5.3-flash");
  expect(cells["coder@medium"]).toBe("glm-5.3-flash");
  expect(cells["coder@complex"]).toBe("minimax-m3");
});

// ---------------------------------------------------------------------------
// (#280) cache prices and maxTokens complete the per-model vocabulary

function oneModel(model: Record<string, unknown>) {
  return parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://opencode.example.com",
        credential: "OPENCODE_API_KEY",
        models: { "glm-5.3-flash": model as never },
      },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
}

test("(#280) declared cacheRead/cacheWrite project into the registry cost", () => {
  const { registry } = toRegistryAndProfile(
    oneModel({ input: 0.15, output: 0.5, cacheRead: 0.02, cacheWrite: 0.04 }),
    "daily",
  );
  expect(registry.providers[0]?.models?.[0]?.cost).toEqual({
    input: 0.15,
    output: 0.5,
    cacheRead: 0.02,
    cacheWrite: 0.04,
  });
});

test("(#280) absent cacheRead/cacheWrite settle at zero, the only value not invented", () => {
  const { registry } = toRegistryAndProfile(oneModel({ input: 0.15, output: 0.5 }), "daily");
  expect(registry.providers[0]?.models?.[0]?.cost).toEqual({
    input: 0.15,
    output: 0.5,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("(#280) a declared maxTokens projects as the registry model's maxTokens", () => {
  const { registry } = toRegistryAndProfile(
    oneModel({ input: 0.15, output: 0.5, contextWindow: 131072, maxTokens: 8192 }),
    "daily",
  );
  expect(registry.providers[0]?.models?.[0]?.maxTokens).toBe(8192);
});

test("(#280) an absent maxTokens keeps the window default unchanged", () => {
  const config = oneModel({
    input: 0.15,
    output: 0.5,
    contextWindow: 131072,
  });
  const absent = oneModel({ input: 0.15, output: 0.5 });
  const { registry } = toRegistryAndProfile(config, "daily");
  const { registry: second } = toRegistryAndProfile(absent, "daily");
  // A declared window still fills maxTokens; no window at all keeps the shared
  // 200000 ceiling -- exactly the pre-#280 defaults.
  expect(registry.providers[0]?.models?.[0]?.maxTokens).toBe(131072);
  expect(second.providers[0]?.models?.[0]?.maxTokens).toBe(DEFAULT_CONTEXT_WINDOW);
});

test("(#280) a non-numeric cache price is refused, naming the field path", () => {
  expect(() => oneModel({ input: 0.15, output: 0.5, cacheRead: "free" })).toThrow(ConfigError);
  try {
    oneModel({ input: 0.15, output: 0.5, cacheRead: "free" });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const ce = error as ConfigError;
    expect(ce.code).toBe("invalid_config");
    expect(ce.detail).toBe("opencode-go.models.glm-5.3-flash.cacheRead");
    expect(ce.message).toContain("opencode-go.models.glm-5.3-flash.cacheRead");
  }
});

test("(#280) a negative cache price is refused, naming the field path", () => {
  expect(() => oneModel({ input: 0.15, output: 0.5, cacheWrite: -1 })).toThrow(ConfigError);
  try {
    oneModel({ input: 0.15, output: 0.5, cacheWrite: -1 });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const ce = error as ConfigError;
    expect(ce.code).toBe("invalid_config");
    expect(ce.detail).toBe("opencode-go.models.glm-5.3-flash.cacheWrite");
    expect(ce.message).toContain("opencode-go.models.glm-5.3-flash.cacheWrite");
  }
});

test("(#280) a non-positive maxTokens is refused, naming the field path", () => {
  expect(() => oneModel({ input: 0.15, output: 0.5, maxTokens: 0 })).toThrow(ConfigError);
  try {
    oneModel({ input: 0.15, output: 0.5, maxTokens: 0 });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    const ce = error as ConfigError;
    expect(ce.code).toBe("invalid_config");
    expect(ce.detail).toBe("opencode-go.models.glm-5.3-flash.maxTokens");
    expect(ce.message).toContain("opencode-go.models.glm-5.3-flash.maxTokens");
  }
});
