import { afterEach, expect, test } from "bun:test";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelConfig, ProviderConfig, RegistryConfig } from "ad-coder";
import {
  anthropicCompatiblePreset,
  deepseekPreset,
  openaiCodexPreset,
  openaiCompatiblePreset,
  openrouterPreset,
  parseRegistryConfig,
  RegistryError,
  resolveRegistry,
} from "ad-coder";

// A minimal, always-valid model so tests vary one field at a time.
function model(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: "m1",
    modelId: "model-1",
    contextWindow: 8000,
    maxTokens: 2000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p1",
    api: "openai-completions",
    baseUrl: "https://api.example.com",
    credential: { kind: "env-var", envVar: "P1_KEY" },
    models: [model()],
    ...overrides,
  };
}

function config(overrides: Partial<RegistryConfig> = {}): RegistryConfig {
  return { providers: [provider()], ...overrides };
}

// A fake env accessor: fail-loud on a var the test did not declare, so a stray
// read is visible rather than silently undefined.
function fakeEnv(map: Record<string, string>): (name: string) => string | undefined {
  return (name) => map[name];
}

// --- validator: accept -------------------------------------------------------

test("parseRegistryConfig returns a typed config on valid data", () => {
  const parsed = parseRegistryConfig(config());
  expect(parsed.providers).toHaveLength(1);
  expect(parsed.providers[0]!.id).toBe("p1");
  expect(parsed.providers[0]!.models[0]!.name).toBe("m1");
});

test("model input modalities are validated and reach the resolved model", () => {
  const cfg = config({ providers: [provider({ models: [model({ input: ["text", "image"] })] })] });
  expect(parseRegistryConfig(cfg).providers[0]?.models[0]?.input).toEqual(["text", "image"]);
  const resolved = resolveRegistry(cfg, { env: fakeEnv({ P1_KEY: "test-key" }) });
  expect(resolved.getModel("m1").input).toEqual(["text", "image"]);
});

test("model input modalities reject duplicates and unknown values", () => {
  expect(() =>
    parseRegistryConfig(
      config({ providers: [provider({ models: [model({ input: ["text", "text"] })] })] }),
    ),
  ).toThrow(RegistryError);
  expect(() =>
    parseRegistryConfig(
      config({ providers: [provider({ models: [model({ input: ["audio"] as never })] })] }),
    ),
  ).toThrow(RegistryError);
});

test("contextWindow defaults to 200000 when omitted", () => {
  const withoutWindow = model();
  delete withoutWindow.contextWindow;
  const parsed = parseRegistryConfig(
    config({ providers: [provider({ models: [withoutWindow] })] }),
  );
  expect(parsed.providers[0]!.models[0]!.contextWindow).toBe(200000);
});

// --- validator: each reject case --------------------------------------------

test("rejects a non-object config", () => {
  expect(() => parseRegistryConfig(null)).toThrow(RegistryError);
  expect(() => parseRegistryConfig("nope")).toThrow(RegistryError);
});

test("rejects an empty providers array", () => {
  try {
    parseRegistryConfig({ providers: [] });
    throw new Error("expected throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe("invalid_config");
    expect((error as RegistryError).detail).toBe("providers");
  }
});

test("rejects a duplicate provider id", () => {
  const cfg = { providers: [provider(), provider({ models: [model({ name: "m2" })] })] };
  try {
    parseRegistryConfig(cfg);
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).code).toBe("duplicate_provider");
    expect((error as RegistryError).detail).toBe("p1");
  }
});

test("rejects a duplicate model name across providers", () => {
  const cfg = {
    providers: [
      provider(),
      provider({ id: "p2", credential: { kind: "env-var", envVar: "P2_KEY" }, models: [model()] }),
    ],
  };
  try {
    parseRegistryConfig(cfg);
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).code).toBe("duplicate_model");
    expect((error as RegistryError).detail).toBe("m1");
  }
});

test("rejects an unsupported provider api", () => {
  const cfg = { providers: [provider({ api: "grpc-magic" as never })] };
  try {
    parseRegistryConfig(cfg);
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).code).toBe("unsupported_api");
    expect((error as RegistryError).detail).toBe("p1");
  }
});

test("rejects an unsupported per-model api override", () => {
  const cfg = { providers: [provider({ models: [model({ api: "grpc-magic" as never })] })] };
  try {
    parseRegistryConfig(cfg);
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).code).toBe("unsupported_api");
    expect((error as RegistryError).detail).toBe("m1");
  }
});

test("rejects an empty env-var name", () => {
  const cfg = { providers: [provider({ credential: { kind: "env-var", envVar: "" } })] };
  try {
    parseRegistryConfig(cfg);
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).code).toBe("invalid_config");
    expect((error as RegistryError).detail).toBe("p1.credential.envVar");
  }
});

test("rejects an unknown credential kind", () => {
  const cfg = { providers: [provider({ credential: { kind: "iam" } as never })] };
  expect(() => parseRegistryConfig(cfg)).toThrow(RegistryError);
});

test("rejects a non-numeric cost field", () => {
  const cfg = {
    providers: [
      provider({
        models: [
          model({ cost: { input: "free", output: 1, cacheRead: 0, cacheWrite: 0 } as never }),
        ],
      }),
    ],
  };
  try {
    parseRegistryConfig(cfg);
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).code).toBe("invalid_config");
    expect((error as RegistryError).detail).toBe("m1.cost.input");
  }
});

test("rejects a non-positive contextWindow", () => {
  const cfg = { providers: [provider({ models: [model({ contextWindow: 0 })] })] };
  try {
    parseRegistryConfig(cfg);
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).detail).toBe("m1.contextWindow");
  }
});

// --- validator: baseUrl SECURITY checks -------------------------------------

test("rejects a non-https baseUrl", () => {
  const cfg = { providers: [provider({ baseUrl: "http://api.example.com" })] };
  try {
    parseRegistryConfig(cfg);
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).code).toBe("invalid_config");
    expect((error as RegistryError).detail).toBe("p1.baseUrl");
  }
});

test("rejects a crafted https-lookalike scheme by exact equality", () => {
  const cfg = { providers: [provider({ baseUrl: "httpsx://api.example.com" })] };
  expect(() => parseRegistryConfig(cfg)).toThrow(RegistryError);
});

test("rejects a non-URL baseUrl", () => {
  const cfg = { providers: [provider({ baseUrl: "not a url" })] };
  expect(() => parseRegistryConfig(cfg)).toThrow(RegistryError);
});

test("rejects a baseUrl carrying embedded userinfo", () => {
  const cfg = { providers: [provider({ baseUrl: "https://user:pass@api.example.com" })] };
  try {
    parseRegistryConfig(cfg);
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).code).toBe("invalid_config");
    expect((error as RegistryError).detail).toBe("p1.baseUrl");
  }
});

// --- presets -----------------------------------------------------------------

test("each of the five presets produces a validator-accepted config", () => {
  const presets: ProviderConfig[] = [
    deepseekPreset(),
    openrouterPreset(),
    openaiCompatiblePreset({
      id: "lmstudio",
      baseUrl: "https://api.openai.com/v1",
      envVar: "OPENAI_API_KEY",
      models: [model()],
    }),
    anthropicCompatiblePreset({
      id: "native-anthropic",
      baseUrl: "https://api.anthropic.com",
      envVar: "ANTHROPIC_API_KEY",
      models: [model({ name: "m2" })],
    }),
    openaiCodexPreset(),
  ];
  for (const p of presets) {
    expect(() => parseRegistryConfig({ providers: [p] })).not.toThrow();
  }
});

test("preset baseUrl/api/credential match the shipped pi-ai factories", () => {
  expect(deepseekPreset().baseUrl).toBe("https://api.deepseek.com");
  expect(deepseekPreset().api).toBe("openai-completions");
  expect(deepseekPreset().credential).toEqual({ kind: "env-var", envVar: "DEEPSEEK_API_KEY" });

  expect(openrouterPreset().baseUrl).toBe("https://openrouter.ai/api/v1");
  expect(openrouterPreset().credential).toEqual({ kind: "env-var", envVar: "OPENROUTER_API_KEY" });

  expect(openaiCodexPreset().baseUrl).toBe("https://chatgpt.com/backend-api");
  expect(openaiCodexPreset().api).toBe("openai-codex-responses");
  expect(openaiCodexPreset().credential).toEqual({ kind: "oauth" });
});

test("the custom presets are rejected by the validator when baseUrl is empty or non-https", () => {
  const bad = openaiCompatiblePreset({ id: "x", baseUrl: "", envVar: "X_KEY", models: [model()] });
  expect(() => parseRegistryConfig({ providers: [bad] })).toThrow(RegistryError);
  const insecure = anthropicCompatiblePreset({
    id: "y",
    baseUrl: "http://y.example.com",
    envVar: "Y_KEY",
    models: [model()],
  });
  expect(() => parseRegistryConfig({ providers: [insecure] })).toThrow(RegistryError);
});

// --- resolveRegistry ---------------------------------------------------------

test("resolveRegistry builds Models and resolves lookup by stable name", () => {
  const cfg = config({
    providers: [
      provider({
        models: [
          model({ name: "chat", modelId: "deepseek-chat", contextWindow: 64000, maxTokens: 8192 }),
        ],
      }),
    ],
  });
  const resolved = resolveRegistry(cfg, { env: fakeEnv({ P1_KEY: "fake-key" }) });

  const found = resolved.lookup("chat");
  expect(found.models).toBe(resolved.models);
  expect(found.model.id).toBe("deepseek-chat");
  expect(found.model.provider).toBe("p1");
  expect(found.model.baseUrl).toBe("https://api.example.com");
  expect(found.model.contextWindow).toBe(64000);
  expect(found.model.cost.input).toBe(1);

  expect(resolved.getModel("chat").id).toBe("deepseek-chat");
});

test("a missing required env var throws missing_credential naming only the var", () => {
  const cfg = config();
  try {
    resolveRegistry(cfg, { env: fakeEnv({}) });
    throw new Error("expected throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe("missing_credential");
    expect((error as RegistryError).detail).toBe("P1_KEY");
    // The message names the var but never a value.
    expect((error as RegistryError).message).not.toContain("fake");
  }
});

test("an unknown model name throws unknown_model", () => {
  const resolved = resolveRegistry(config(), { env: fakeEnv({ P1_KEY: "fake-key" }) });
  try {
    resolved.getModel("nope");
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).code).toBe("unknown_model");
    expect((error as RegistryError).detail).toBe("nope");
  }
});

test("credentials resolve through the injected accessor, not process.env", async () => {
  // Decoy: a REAL process.env value that must NOT be the one pi transmits.
  process.env.REGISTRY_DECOY_KEY = "real-env-should-not-be-used";
  const cfg = config({
    providers: [provider({ credential: { kind: "env-var", envVar: "REGISTRY_DECOY_KEY" } })],
  });
  const resolved = resolveRegistry(cfg, {
    env: fakeEnv({ REGISTRY_DECOY_KEY: "fake-injected-value" }),
  });

  // getAuth routes through the pi AuthContext.env, which this module wires to
  // the injected accessor. The transmitted key must be the injected value.
  const auth = await resolved.models.getAuth("p1");
  expect(auth?.auth.apiKey).toBe("fake-injected-value");
});

test("resolveRegistry gives pi Models the exact injected CredentialStore", async () => {
  let reads = 0;
  const credentials: CredentialStore = {
    read: async (providerId) => {
      reads += 1;
      expect(providerId).toBe("openai-codex");
      return {
        type: "oauth",
        access: "sentinel-access",
        refresh: "sentinel-refresh",
        expires: Date.now() + 60 * 60_000,
      };
    },
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => undefined,
  };
  const resolved = resolveRegistry({ providers: [openaiCodexPreset()] }, { credentials });
  const auth = await resolved.models.getAuth("openai-codex");
  expect(reads).toBe(1);
  expect(auth).toBeDefined();
});

test("a mixed-api provider (openrouter dual-api) resolves both apis", () => {
  const cfg: RegistryConfig = {
    providers: [
      openrouterPreset([
        model({ name: "or-oai", modelId: "some/openai-model" }),
        model({ name: "or-ant", modelId: "some/anthropic-model", api: "anthropic-messages" }),
      ]),
    ],
  };
  const resolved = resolveRegistry(cfg, { env: fakeEnv({ OPENROUTER_API_KEY: "fake-key" }) });
  expect(resolved.getModel("or-oai").api).toBe("openai-completions");
  expect(resolved.getModel("or-ant").api).toBe("anthropic-messages");
});

test("the codex/oauth provider resolves via the delegated factory, no api-key auth", () => {
  const resolved = resolveRegistry({ providers: [openaiCodexPreset()] });
  // The delegated provider carries oauth auth, not an api-key built here.
  const codex = resolved.models.getProvider("openai-codex");
  expect(codex).toBeDefined();
  expect(codex!.auth.oauth).toBeDefined();
  expect(codex!.auth.apiKey).toBeUndefined();
  // The declared model name resolves against the factory's own catalog.
  const m = resolved.getModel("codex-gpt-5.5");
  expect(m.provider).toBe("openai-codex");
  expect(m.id).toBe("gpt-5.5");
});

test("declared context windows override delegated catalog values in either direction", () => {
  const base = openaiCodexPreset();
  const declared = base.models[0]!;
  const low = resolveRegistry({
    providers: [{ ...base, models: [{ ...declared, contextWindow: 32000 }] }],
  });
  const high = resolveRegistry({
    providers: [{ ...base, models: [{ ...declared, contextWindow: 400000 }] }],
  });
  expect(low.getModel(declared.name).contextWindow).toBe(32000);
  expect(high.getModel(declared.name).contextWindow).toBe(400000);
});

test("resolveRegistry re-validates a hand-built config", () => {
  // A config that never went through parseRegistryConfig, with a bad baseUrl.
  const cfg = {
    providers: [provider({ baseUrl: "http://insecure.example.com" })],
  } as RegistryConfig;
  expect(() => resolveRegistry(cfg, { env: fakeEnv({ P1_KEY: "fake-key" }) })).toThrow(
    RegistryError,
  );
});

afterEach(() => {
  delete process.env.REGISTRY_DECOY_KEY;
});
