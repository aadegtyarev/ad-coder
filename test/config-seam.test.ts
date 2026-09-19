import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePipelineConfig } from "../src/cli/resolve-config";
import { ConfigError } from "../src/config/errors";
import { loadModelsConfigSeam, loadSettingsConfigSeam } from "../src/config/seam";
import { modelsProfileSource, toRegistryAndProfile } from "../src/config/to-registry";
import type { SettingsConfig } from "../src/config/types";
import { parseModelsConfig } from "../src/config/validate";
import { buildDefaultProfile } from "../src/profiles/default-profile";
import { resolveProfile } from "../src/profiles/resolve";
import { writeProjectCalibrationSnapshot } from "../src/project-calibration";
import { parseSettingsConfig } from "../src/config/validate";
import { RegistryError } from "../src/registry/errors";
import { resolveRegistry } from "../src/registry/resolve";
import type { RegistryConfig } from "../src/registry/types";
import { DEFAULT_CONTEXT_WINDOW, parseRegistryConfig } from "../src/registry/validate";
import {
  checkReviewStamps,
  recordReviewStampFromResult,
  resolveStampRequirement,
  STAMPS_MARKER_FILE,
} from "../src/stamp/record-review-stamp";
import { UserProfileError } from "../src/user-profile";

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

test("the reserved literal `oauth` projects to the oauth source, and the registry accepts it (#503)", () => {
  const config = parseModelsConfig({
    providers: {
      "openai-codex": {
        enabled: true,
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        credential: "oauth",
        models: {
          "gpt-5.6-terra": {
            input: 2,
            output: 12,
            cacheRead: 0.2,
            contextWindow: 200000,
            maxTokens: 128000,
          },
        },
      },
    },
    profiles: { "codex-pro100": { coder: "openai-codex:gpt-5.6-terra" } },
  });
  const { registry } = toRegistryAndProfile(config, "codex-pro100");
  expect(registry.providers[0]?.credential).toEqual({ kind: "oauth" });
  // The registry's own validator admits it -- the same shape the shipped
  // `openaiCodexPreset()` carries.
  expect(parseRegistryConfig(registry).providers[0]?.credential).toEqual({ kind: "oauth" });
});

test("the literal is EXACT: `oauth2` is an env-var name, not the oauth source (#503)", () => {
  // The reserved word is a literal, not a prefix or a case-folded match. A
  // near-miss must read as the env-var NAME it is, because the alternative --
  // a fuzzy match -- would route an operator's `OAUTH_...`-shaped variable to
  // a codex account they never named.
  const config = parseModelsConfig({
    providers: {
      "test-provider": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://test.example.com/v1",
        credential: "oauth2",
        models: { "test-big": { input: 3, output: 15 } },
      },
    },
    profiles: { p: { coder: "test-provider:test-big" } },
  });
  const { registry } = toRegistryAndProfile(config, "p");
  expect(registry.providers[0]?.credential).toEqual({ kind: "env-var", envVar: "oauth2" });
});

test("a declared price row does not price a delegated catalog model, a declared window does (#503)", () => {
  // The asymmetry the CHANGELOG states: `getModel` overrides contextWindow,
  // maxTokens and input on the delegated codex model and leaves `cost` alone,
  // so a codex row's prices are the catalog's while its window and ceiling are
  // the operator's. Declaring a sentinel price and a distinctive window pins
  // both halves -- a future change that started honouring the declared price
  // (or stopped honouring the declared window) turns this red.
  const config = parseModelsConfig({
    providers: {
      "openai-codex": {
        enabled: true,
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        credential: "oauth",
        models: {
          "gpt-5.6-terra": {
            input: 999,
            output: 999,
            contextWindow: 300000,
            maxTokens: 4096,
          },
        },
      },
    },
    profiles: { p: { coder: "openai-codex:gpt-5.6-terra" } },
  });
  const { registry } = toRegistryAndProfile(config, "p");
  const model = resolveRegistry(parseRegistryConfig(registry)).getModel("gpt-5.6-terra");

  expect(model.contextWindow).toBe(300000);
  expect(model.maxTokens).toBe(4096);
  // Every price, not just `input`: the sentinel is declared on both, and the
  // two cache rates are declared NOWHERE -- a projection that honoured its own
  // defaults would settle them at zero, so a positive value here is the
  // catalog's and only the catalog's.
  expect(model.cost.input).toBeGreaterThan(0);
  expect(model.cost.input).not.toBe(999);
  expect(model.cost.output).toBeGreaterThan(0);
  expect(model.cost.output).not.toBe(999);
  expect(model.cost.cacheRead).toBeGreaterThan(0);
  expect(model.cost.cacheWrite).toBeGreaterThan(0);
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
    // The refusal teaches both spellings (#503): a name, or the reserved
    // literal -- otherwise a codex provider reads as an operator mistake.
    expect(ce.message).toContain("oauth");
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
    expect(settings).toEqual({
      review: { requireStamp: "auto", costSignature: false },
      providerAdmission: {},
      sessionManager: { allowedRoots: [] },
    });
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

// (h) session-manager section (issue #365 layer 2)

test("(h) the session-manager section parses allowed roots and creation volume", () => {
  const parsed = parseSettingsConfig({
    review: { "require-stamp": "on" },
    "session-manager": {
      "allowed-roots": ["/srv/projects"],
      "max-projects": 8,
    },
  });
  expect(parsed.sessionManager).toEqual({ allowedRoots: ["/srv/projects"], maxProjects: 8 });
});

test("(h) an absent session-manager section parses to the refusal-to-serve default", () => {
  expect(parseSettingsConfig({ review: {} }).sessionManager).toEqual({ allowedRoots: [] });
});

const SESSION_MANAGER_BAD = [
  ["relative allowed root", { "session-manager": { "allowed-roots": ["srv/relative"] } }],
  ["non-list allowed roots", { "session-manager": { "allowed-roots": "/srv" } }],
  ["non-integer max-projects", { "session-manager": { "max-projects": 1.5 } }],
  ["negative max-projects", { "session-manager": { "max-projects": -1 } }],
  ["unknown section key", { "session-manager": { volume: 3 } }],
  ["unknown top key", { "session-manager-x": {} }],
] as const;

test.each(SESSION_MANAGER_BAD)("(h) session-manager parsing refuses %s", (_ignore, document) => {
  expect(() => parseSettingsConfig(document)).toThrow(ConfigError);
});

function settingsWith(requireStamp: "auto" | "on" | "off"): SettingsConfig {
  return {
    review: { requireStamp, costSignature: false },
    providerAdmission: {},
    sessionManager: { allowedRoots: [] },
  };
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

test("(a) models.yaml is the route even with a leftover inventories.json present", () => {
  const dir = scratch();
  try {
    const modelsPath = writeModels(dir, modelsYaml());
    // The JSON inventory is read by NOTHING (issue #513): a file left on disk
    // is neither a competing source nor a fallback, so models.yaml is the
    // route and the file beside it changes nothing.
    writeInventory(dir, "json-profile");
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: modelsPath,
      settingsConfigPath: path.join(dir, "settings.yaml"),
      env: fakeEnv({ OPENCODE_API_KEY: "k" }),
      warn: silent,
    });
    // YAML is the route: the banner/effectiveConfig name models.yaml.
    expect(config.delegatedRoute?.source).toBe('models.yaml "daily"');
    expect(config.effectiveConfig?.modelsProfile?.source).toBe("models.yaml");
    expect(config.effectiveConfig?.modelsProfile?.value).toBe("daily");
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
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: modelsPath,
      settingsConfigPath: path.join(dir, "settings.yaml"),
      coderModel: "glm-5.3-pro",
      env: fakeEnv({ OPENCODE_API_KEY: "k" }),
      warn: silent,
    });
    // The seam stays ENTERED (models.yaml won), not disabled by the role flag.
    expect(config.delegatedRoute?.source).toBe('models.yaml "daily"');
    expect(config.effectiveConfig?.modelsProfile?.source).toBe("models.yaml");
    // The override pinches just the coder cell; the planner still takes the
    // profile's own route.
    expect(config.roles.coder.model.name).toBe("glm-5.3-pro");
    expect(config.roles.planner?.model.name).toBe("glm-5.3-flash");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(e2) present models.yaml with no default and no selected profile is a typed error", () => {
  const dir = scratch();
  try {
    // No `default:` key, and no `--models-profile` selection.
    const modelsPath = writeModels(dir, modelsYaml().replace("default: daily\n", ""));
    expect(() =>
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        modelsConfigPath: modelsPath,
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
// (#414) reachableProviders: the preflight scope mirrors the profile's reach

test("(#414) reachableProviders names the selected rungs' providers, not foreign enabled ones", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://opencode.example.com",
        credential: "OPENCODE_API_KEY",
        models: { "glm-5.3-flash": { input: 0.15, output: 0.5 } },
      },
      // Enabled, declared, VALID -- but no selected rung reaches it.
      spare: {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://spare.example.com",
        credential: "SPARE_API_KEY",
        models: { "spare-model": { input: 0.1, output: 0.2 } },
      },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
  const { reachableProviders, registry } = toRegistryAndProfile(config, "daily");
  // The registry itself stays FULL: both enabled providers are projected.
  expect(registry.providers.map((p) => p.id).sort()).toEqual(["opencode-go", "spare"]);
  // ...but only what the profile names is reachable.
  expect(reachableProviders).toEqual(["opencode-go"]);
});

test("(#414) overrides and every ladder row contribute their providers", () => {
  const config = parseModelsConfig({
    providers: {
      one: {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://one.example.com",
        credential: "ONE_KEY",
        models: { "m-a": { input: 0.1, output: 0.2 } },
      },
      two: {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://two.example.com",
        credential: "TWO_KEY",
        models: { "m-b": { input: 0.1, output: 0.2 } },
      },
    },
    profiles: {
      daily: {
        coder: "one:m-a",
        "coder@complex": "two:m-b",
        // Only the first rung is served today, but every rung is reachable
        // data: a future ladder walk landing here is preflighted up front.
        orchestrator: ["one:m-a", "two:m-b"],
      },
    },
  });
  const { reachableProviders } = toRegistryAndProfile(config, "daily");
  // First-seen order, deduped.
  expect(reachableProviders).toEqual(["one", "two"]);
});

test("(#414) reachability resolves the model's REGISTERING provider, never the rung prefix", () => {
  // parseModelsConfig would refuse a rung whose prefix does not own the model,
  // so this shaped-as-validated input pins the rule for hand-built input: the
  // set must follow the registry's model -> owner index, not the prefix.
  // The DECLARED profile shape (`routes` per name) is what this layer consumes;
  // only validation refusal is simulated here by the prefix lie.
  const config = {
    defaultProfile: "daily",
    providers: {
      one: {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://one.example.com",
        credential: "ONE_KEY",
        models: { "m-a": { input: 0.1, output: 0.2 } },
      },
    },
    profiles: { daily: { name: "daily", routes: { coder: ["spare:m-a"] } } },
  } as Parameters<typeof toRegistryAndProfile>[0];
  const { reachableProviders } = toRegistryAndProfile(config, "daily");
  expect(reachableProviders).toEqual(["one"]);
});

// ---------------------------------------------------------------------------
// (#414) e2e: one keyless enabled provider must not break every route

const twoProviderYaml = (profile: string): string => `providers:
  opencode-go:
    enabled: true
    api: openai-completions
    baseUrl: https://opencode.example.com
    credential: OPENCODE_API_KEY
    models:
      glm-5.3-flash: {input: 0.15, output: 0.5}
  spare:
    enabled: true
    api: openai-completions
    baseUrl: https://spare.example.com
    credential: SPARE_API_KEY
    models:
      spare-model: {input: 0.1, output: 0.2}
default: daily
profiles:
${profile}
`;

const routesTo = (rung: string): string =>
  [
    "orchestrator",
    "planner",
    "researcher",
    "coder",
    "reviewer",
    "auditor",
    "security",
    "summarizer",
  ]
    .map((role) => `    ${role}: ${rung}`)
    .join("\n");

test("(#414) an enabled provider without a key stays inert while the profile ignores it", () => {
  const dir = scratch();
  try {
    const modelsPath = writeModels(
      dir,
      twoProviderYaml(`  daily:\n${routesTo("opencode-go:glm-5.3-flash")}`),
    );
    // SPARE_API_KEY is set NOWHERE: no env (and the store is outside the
    // target dir), yet the profile never names the spare provider.
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: modelsPath,
      settingsConfigPath: path.join(dir, "settings.yaml"),
      env: fakeEnv({ OPENCODE_API_KEY: "k" }),
      warn: silent,
    });
    expect(config.delegatedRoute?.source).toBe('models.yaml "daily"');
    // Every served role routes to opencode-go's model, never the spare one.
    expect(Object.values(config.roles).map((role) => role?.model.name)).toEqual(
      Array(Object.values(config.roles).length).fill("glm-5.3-flash"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#414) a profile that routes to the keyless provider still fails missing_credential", () => {
  const dir = scratch();
  try {
    const modelsPath = writeModels(
      dir,
      twoProviderYaml(`  daily:\n${routesTo("spare:spare-model")}`),
    );
    try {
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        modelsConfigPath: modelsPath,
        settingsConfigPath: path.join(dir, "settings.yaml"),
        env: fakeEnv({ OPENCODE_API_KEY: "k" }),
        warn: silent,
      });
      expect.unreachable();
    } catch (error) {
      // The profile DOES name the keyless provider: the preflight stays
      // fail-loud with the verbatim missing_credential error.
      expect(error).toBeInstanceOf(RegistryError);
      const re = error as RegistryError;
      expect(re.code).toBe("missing_credential");
      expect(re.detail).toBe("SPARE_API_KEY");
      expect(re.message).toContain('provider "spare"');
      expect(re.message).not.toContain("k");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// ---------------------------------------------------------------------------
// (#453) requireResolvableRoute: the resolver throws a typed `route_unresolved`
// instead of substituting the env-preset/codex fallback when the option is
// set and nothing resolves. The console and every other caller (the option
// absent) keep their present behaviour.

/** No env-var provider key, no models.yaml, no inventory, no registry config. */
function emptyResolveEnv(): (name: string) => string | undefined {
  return () => undefined;
}

test("(#453) requireResolvableRoute: nothing resolvable throws the typed error", () => {
  const dir = scratch();
  try {
    let thrown: unknown;
    try {
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        env: emptyResolveEnv(),
        warn: silent,
        requireResolvableRoute: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const ce = thrown as ConfigError;
    expect(ce.code).toBe("route_unresolved");
    // Names only -- absent rungs and env-var NAMES, never a value, never a URL.
    // The rungs are the sources a run can still select: the retired
    // `--inventory-config` is not one of them (issue #513) and naming it would
    // send the operator to a flag that does not exist.
    expect(ce.detail).toContain("models.yaml");
    expect(ce.detail).toContain("--registry-config");
    expect(ce.detail).toContain("--provider");
    expect(ce.detail).toContain("DEEPSEEK_API_KEY");
    expect(ce.detail).toContain("OPENROUTER_API_KEY");
    expect(ce.message).toContain("--models-config");
    // No credential value, no provider URL, no raw response.
    expect(ce.detail).not.toMatch(/sk-|https?:\/\//);
    expect(ce.message).not.toMatch(/sk-|https?:\/\//);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#453) requireResolvableRoute: absent keeps the env-preset/codex fallback", () => {
  const dir = scratch();
  try {
    // No `requireResolvableRoute`: the console keeps its present behaviour --
    // the env-preset/codex fallback substitutes a route and no error is thrown.
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      env: emptyResolveEnv(),
      warn: silent,
    });
    expect(config.delegatedRoute?.source).toBe('provider "openai-codex"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#453) requireResolvableRoute: false (explicit) also keeps the fallback", () => {
  const dir = scratch();
  try {
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      env: emptyResolveEnv(),
      warn: silent,
      requireResolvableRoute: false,
    });
    expect(config.delegatedRoute?.source).toBe('provider "openai-codex"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#453) requireResolvableRoute: a stored models.yaml selection still resolves", () => {
  const dir = scratch();
  try {
    const modelsPath = writeModels(dir, modelsYaml());
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: modelsPath,
      settingsConfigPath: path.join(dir, "settings.yaml"),
      env: fakeEnv({ OPENCODE_API_KEY: "k" }),
      warn: silent,
      requireResolvableRoute: true,
    });
    expect(config.delegatedRoute?.source).toBe('models.yaml "daily"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#453) requireResolvableRoute: an explicit --provider with no credential is refused", () => {
  const dir = scratch();
  try {
    // The explicit pin skips the route guard -- and that guard is what would
    // have thrown `route_unresolved`. Resolution therefore proceeds to the
    // registry, which refuses the provider it was pinned to, because its
    // credential is absent from the injected env. That refusal is the correct
    // outcome: the operator's typed selection is honoured, not substituted.
    let thrown: unknown;
    try {
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        env: emptyResolveEnv(),
        warn: silent,
        requireResolvableRoute: true,
        provider: "deepseek",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RegistryError);
    const re = thrown as RegistryError;
    expect(re.code).toBe("missing_credential");
    // Names only -- the credential VARIABLE, never a value, never a URL.
    expect(re.detail).toBe("DEEPSEEK_API_KEY");
    expect(re.message).toContain("DEEPSEEK_API_KEY");
    expect(re.message).toContain('"deepseek"');
    // Never the env-preset/codex fallback: the pinned provider is not swapped
    // for a route that would have "resolved" without a credential.
    expect(re.message).not.toContain("openai-codex");
    expect(re.message).not.toMatch(/sk-|https?:\/\//);
    expect(re.detail).not.toMatch(/sk-|https?:\/\//);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#453) requireResolvableRoute: an env-preset provider key still resolves", () => {
  const dir = scratch();
  try {
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      env: fakeEnv({ OPENROUTER_API_KEY: "k" }),
      warn: silent,
      requireResolvableRoute: true,
    });
    expect(config.delegatedRoute?.source).toBe('provider "openrouter"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (#477 step 2) a rung MAY declare a thinking level: the mapping form carries
// it through the seam onto the live role; the level-less rung is unchanged.

/** The fixture with the coder row replaced by `replacement` (indented 4). */
function modelsYamlWithCoder(replacement: string): string {
  return modelsYaml().replace("    coder: opencode-go:glm-5.3-flash\n", replacement);
}

test("(#477) a mapping rung's thinkingLevel reaches the resolved role through the seam", () => {
  const dir = scratch();
  try {
    const modelsPath = writeModels(
      dir,
      modelsYamlWithCoder(
        "    coder:\n      - model: opencode-go:glm-5.3-flash\n        thinkingLevel: low\n",
      ),
    );
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: modelsPath,
      settingsConfigPath: path.join(dir, "settings.yaml"),
      env: fakeEnv({ OPENCODE_API_KEY: "k" }),
      warn: silent,
    });
    // YAML -> parse -> projection -> registry resolution -> the live role, all
    // local (the credential is a name and no request is made).
    expect(config.roles.coder?.model.name).toBe("glm-5.3-flash");
    // The ticket's acceptance is on the RESOLVED SELECTION, not on a `RoleSpec`
    // (a `RoleSpec` carries no `thinkingLevel`). `config.routing` is the
    // profile/registry pair the runner hands to `resolveProfile`.
    const routing = config.routing;
    if (routing === undefined) throw new Error("expected the seam to resolve routing");
    const coder = resolveProfile(routing.profile, routing.registry, "coder", "trivial");
    expect(coder.thinkingLevel).toBe("low");
    expect(coder.model.name).toBe("glm-5.3-flash");
    // A rung that declares no level stays ABSENT, never defaulted.
    const planner = resolveProfile(routing.profile, routing.registry, "planner", "trivial");
    expect(planner.thinkingLevel).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#477) a level-less list rung parses and projects exactly as before", () => {
  const dir = scratch();
  try {
    const listFile = writeModels(
      dir,
      modelsYamlWithCoder("    coder:\n      - opencode-go:glm-5.3-flash\n"),
    );
    const list = loadModelsConfigSeam(listFile);
    const bare = loadModelsConfigSeam(writeModels(dir, modelsYaml()));
    if (list === undefined || bare === undefined) {
      throw new Error("expected the seam to load both rung fixtures");
    }
    // The one-rung list is byte-identical to the bare string form.
    expect(list).toEqual(bare);
    const entries = toRegistryAndProfile(list, "daily").profile.entries;
    const coder = entries.find((e) => e.role === "coder" && e.complexity === "trivial");
    expect(coder?.model).toBe("glm-5.3-flash");
    // No key materialised: the entry is still exactly {role, complexity, model}.
    expect(Object.keys(coder ?? {})).toEqual(["role", "complexity", "model"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#477) an off-vocabulary rung thinkingLevel is refused, naming the allowed values", () => {
  const dir = scratch();
  try {
    const modelsPath = writeModels(
      dir,
      modelsYamlWithCoder(
        "    coder:\n      - model: opencode-go:glm-5.3-flash\n        thinkingLevel: deep\n",
      ),
    );
    try {
      loadModelsConfigSeam(modelsPath);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const ce = error as ConfigError;
      expect(ce.code).toBe("invalid_config");
      // Named by field path, and the message names the whole allow-list.
      expect(ce.detail).toBe("profiles.daily.coder.thinkingLevel");
      expect(ce.message).toContain("rung thinkingLevel must be one of");
      expect(ce.message).toContain("low");
      expect(ce.message).toContain("xhigh");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The operator's own pre-#477 file shape for one row (step (vii) back-compat):
 * a BLOCK SEQUENCE under the role key, whose first rung is a bare
 * `provider:model` string and whose second is the mapping form carrying a
 * level. The `openrouter` provider is declared so that second rung's model is a
 * real ladder entry, not a typo the parser would have to refuse.
 */
function modelsYamlMixedRungList(): string {
  return modelsYaml()
    .replace(
      "default: daily",
      `  openrouter:
    enabled: true
    api: openai-completions
    baseUrl: https://openrouter.example.com
    credential: OPENROUTER_API_KEY
    models:
      minimax/minimax-m3: {input: 0.2, output: 0.8}
default: daily`,
    )
    .replace(
      "    coder: opencode-go:glm-5.3-flash\n",
      "    coder:\n      - opencode-go:glm-5.3-flash\n      - model: openrouter:minimax/minimax-m3\n        thinkingLevel: low\n",
    );
}

test("(#477) a bare rung beside a level-bearing one keeps projecting as before", () => {
  const dir = scratch();
  try {
    const config = loadModelsConfigSeam(writeModels(dir, modelsYamlMixedRungList()));
    if (config === undefined) throw new Error("expected the seam to load the mixed-rung fixture");
    const ladder = config.profiles.daily?.routes.coder;
    if (ladder === undefined) throw new Error("expected the block-sequence coder row to parse");
    // Rung 0 is the bare reference, byte-for-byte; rung 1 is the mapping form
    // and it is where the level lives (the parse, not the projection, is level-
    // bearing: ladder failover still reads rung 0 only).
    expect(ladder[0]).toBe("opencode-go:glm-5.3-flash");
    expect(ladder[1]).toEqual({ model: "openrouter:minimax/minimax-m3", thinkingLevel: "low" });
    const entries = toRegistryAndProfile(config, "daily").profile.entries;
    const coder = entries.find((e) => e.role === "coder" && e.complexity === "trivial");
    if (coder === undefined) throw new Error("expected the coder entry to project");
    // The bare rung projects EXACTLY as before #477: no key materialised and
    // no level inherited from the mapping rung beside it.
    expect(Object.keys(coder)).toEqual(["role", "complexity", "model"]);
    expect(coder.thinkingLevel).toBeUndefined();
    expect(coder.model).toBe("glm-5.3-flash");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (#506) a calibration source is a models.yaml profile, not only a JSON inventory

/** `modelsYaml()` with a second model, so a calibrated cell can differ from the
 * profile's own route. */
function modelsYamlTwoModels(): string {
  return modelsYaml().replace(
    "      glm-5.3-flash: {input: 0.15, output: 0.5}\n",
    "      glm-5.3-flash: {input: 0.15, output: 0.5}\n      glm-5.3-pro: {input: 0.5, output: 2}\n",
  );
}

test("(#506) a models.yaml profile's reachable pairs are what a snapshot scopes by", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://opencode.example.com",
        credential: "OPENCODE_API_KEY",
        models: {
          "glm-5.3-flash": { input: 0.15, output: 0.5 },
          "glm-5.3-pro": { input: 0.5, output: 2 },
        },
      },
      // Reached only as a SECOND rung of the summarizer row: still part of the
      // source, because "reachable" is the meaning `reachableProviders` already
      // carries -- every rung, served or not -- and calibration must not invent
      // a second definition of it.
      "other-provider": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://other.example.com",
        credential: "OTHER_API_KEY",
        models: { "other-model": { input: 1, output: 3 } },
      },
    },
    profiles: {
      daily: {
        coder: "opencode-go:glm-5.3-flash",
        reviewer: "opencode-go:glm-5.3-pro",
        summarizer: ["opencode-go:glm-5.3-flash", "other-provider:other-model"],
      },
    },
    default: "daily",
  });
  const source = modelsProfileSource(config, "daily");
  expect(source.name).toBe("daily");
  // First-reached order, one entry per provider, each provider's models deduped.
  expect(source.providers).toEqual([
    { id: "opencode-go", models: ["glm-5.3-flash", "glm-5.3-pro"] },
    { id: "other-provider", models: ["other-model"] },
  ]);
  // An unknown profile is the same typed refusal the registry projection makes.
  expect(() => modelsProfileSource(config, "missing")).toThrow(ConfigError);
});

test("(#506) a project snapshot named after a models profile drives that profile", () => {
  const dir = scratch();
  try {
    const modelsPath = writeModels(dir, modelsYamlTwoModels());
    // The default profile sends the planner (strong) to glm-5.3-pro; the
    // models.yaml profile routes EVERY role to glm-5.3-flash. So a planner
    // cell served by glm-5.3-pro can only have come from the snapshot.
    const calibrated = buildDefaultProfile({
      strong: "glm-5.3-pro",
      mid: "glm-5.3-flash",
      cheap: "glm-5.3-flash",
    });
    const base = {
      task: "x",
      targetDir: dir,
      modelsConfigPath: modelsPath,
      settingsConfigPath: path.join(dir, "settings.yaml"),
      env: fakeEnv({ OPENCODE_API_KEY: "k" }),
      warn: silent,
    };
    expect(resolvePipelineConfig(base).roles.planner?.model.name).toBe("glm-5.3-flash");

    writeProjectCalibrationSnapshot(dir, {
      version: 1,
      modelsProfile: "daily",
      routing: calibrated,
      observedOn: "2026-09-20",
      economics: [],
      subscriptionCapacityRanges: [],
    });
    // The target directory's own committed calibration now applies on the YAML
    // route -- it used to be skipped entirely, so a project could never ship
    // the routing it measured once routing moved to models.yaml.
    expect(resolvePipelineConfig(base).roles.planner?.model.name).toBe("glm-5.3-pro");
    expect(
      resolvePipelineConfig({ ...base, useProjectCalibration: false }).roles.planner?.model.name,
    ).toBe("glm-5.3-flash");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#506) an unreadable snapshot cannot fail a run with nothing to apply it to", () => {
  const dir = scratch();
  try {
    fs.mkdirSync(path.join(dir, ".ad-coder"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".ad-coder", "calibration.json"), "{not-json");
    // The preset route selects neither a JSON inventory nor a models.yaml
    // profile, so no snapshot could ever apply to it: reading the file anyway
    // would let a stray one fail a run that never consults it.
    expect(
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        registryConfig: defaultRegistry(),
        env: fakeEnv({ LOCAL_KEY: "k" }),
        warn: silent,
      }).roles.coder,
    ).toBeDefined();
    // The same bytes on a route that CAN apply a snapshot still fail loudly.
    expect(() =>
      resolvePipelineConfig({
        task: "x",
        targetDir: dir,
        modelsConfigPath: writeModels(dir, modelsYamlTwoModels()),
        settingsConfigPath: path.join(dir, "settings.yaml"),
        env: fakeEnv({ OPENCODE_API_KEY: "k" }),
        warn: silent,
      }),
    ).toThrow(UserProfileError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("(#497) a route addresses the row's local name and the request carries its `id`", () => {
  const dir = scratch();
  try {
    // The whole point of the key: a second provider for one upstream model.
    // The role is named by the local key, and the id the provider is asked for
    // is the row's `id` -- so the name an operator reads in the file is never
    // something they have to also make true upstream.
    const modelsPath = writeModels(
      dir,
      `providers:
  openrouter-2:
    enabled: true
    api: openai-completions
    baseUrl: https://openrouter.example.com/api/v1
    credential: OPENROUTER_API_KEY_2
    models:
      minimax-m3-key2: {id: "minimax/minimax-m3", input: 0.3, output: 1.2}
default: daily
profiles:
  daily:
    orchestrator: openrouter-2:minimax-m3-key2
    planner: openrouter-2:minimax-m3-key2
    researcher: openrouter-2:minimax-m3-key2
    coder: openrouter-2:minimax-m3-key2
    reviewer: openrouter-2:minimax-m3-key2
    auditor: openrouter-2:minimax-m3-key2
    security: openrouter-2:minimax-m3-key2
    summarizer: openrouter-2:minimax-m3-key2
`,
    );
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      modelsConfigPath: modelsPath,
      settingsConfigPath: path.join(dir, "settings.yaml"),
      env: fakeEnv({ OPENROUTER_API_KEY_2: "k" }),
      warn: silent,
    });
    // YAML -> parse -> projection -> registry -> the live role, all local.
    expect(config.roles.coder?.model.name).toBe("minimax-m3-key2");
    // ...and the id the request carries, which is the row's `id`: the role
    // addresses a provider by the id it answers to, and the local name is the
    // file's business.
    expect(config.roles.coder?.role.modelId).toBe("minimax/minimax-m3");
    expect(config.roles.coder?.role.provider).toBe("openrouter-2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
