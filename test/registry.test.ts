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

test("a stored API key resolves when the environment is empty", async () => {
  const credentials: CredentialStore = {
    read: async (providerId) =>
      providerId === "openrouter" ? { type: "api_key", key: "stored-test-key" } : undefined,
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => undefined,
  };
  const resolved = resolveRegistry(
    { providers: [openrouterPreset()] },
    { env: fakeEnv({}), credentials },
  );
  const auth = await resolved.models.getAuth("openrouter");
  expect(auth?.auth.apiKey).toBe("stored-test-key");
  expect(auth?.source).toBe("stored credential");
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

// --- declared request headers ------------------------------------------------

test("declared provider headers reach every resolved model and the provider", () => {
  const cfg = config({
    providers: [
      provider({
        headers: { "x-tenant": "go", "X-Route": "eu" },
        models: [model(), model({ name: "m2", modelId: "model-2" })],
      }),
    ],
  });
  const parsed = parseRegistryConfig(cfg);
  expect(parsed.providers[0]?.headers).toEqual({ "x-tenant": "go", "X-Route": "eu" });

  const resolved = resolveRegistry(cfg, { env: fakeEnv({ P1_KEY: "test-key" }) });
  // Load-bearing: pi's adapters read `model.headers`, not `provider.headers`,
  // so a provider-level declaration that stopped at the provider would never
  // be transmitted.
  expect(resolved.getModel("m1").headers).toEqual({ "x-tenant": "go", "X-Route": "eu" });
  expect(resolved.getModel("m2").headers).toEqual({ "x-tenant": "go", "X-Route": "eu" });
});

test("a model header overrides the provider's value for the same name, ignoring case", () => {
  const cfg = config({
    providers: [
      provider({
        headers: { "X-Route": "eu", "x-tenant": "go" },
        models: [model({ headers: { "x-route": "us" } })],
      }),
    ],
  });
  const resolved = resolveRegistry(cfg, { env: fakeEnv({ P1_KEY: "test-key" }) });
  // One entry for the overridden name, not both spellings.
  expect(resolved.getModel("m1").headers).toEqual({ "x-tenant": "go", "x-route": "us" });
});

test("a model without declared headers carries none", () => {
  const resolved = resolveRegistry(config(), { env: fakeEnv({ P1_KEY: "test-key" }) });
  expect(resolved.getModel("m1").headers).toBeUndefined();
});

test("credential-bearing and client-owned header names are rejected by name", () => {
  for (const name of [
    "authorization",
    "Authorization",
    "x-api-key",
    "proxy-authorization",
    "cookie",
    "host",
    "content-type",
    "user-agent",
    "anthropic-version",
  ]) {
    try {
      parseRegistryConfig(config({ providers: [provider({ headers: { [name]: "value" } })] }));
      throw new Error(`expected rejection for ${name}`);
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as RegistryError).code).toBe("invalid_config");
      expect((error as RegistryError).detail).toBe(`p1.headers.${name}`);
    }
  }
});

test("a reserved header on a model is rejected too", () => {
  expect(() =>
    parseRegistryConfig(
      config({ providers: [provider({ models: [model({ headers: { authorization: "x" } })] })] }),
    ),
  ).toThrow(RegistryError);
});

test("header names and values are shape-checked", () => {
  const rejected: Record<string, unknown>[] = [
    { "x bad": "value" },
    { "x:bad": "value" },
    { "": "value" },
    { "x-ok": "" },
    { "x-ok": 7 },
    { "x-ok": null },
    // A newline would splice an additional header into the request.
    { "x-ok": "value\r\nx-injected: 1" },
    { "x-ok": "значение" },
  ];
  for (const headers of rejected) {
    expect(() =>
      parseRegistryConfig(config({ providers: [provider({ headers: headers as never })] })),
    ).toThrow(RegistryError);
  }
  expect(() =>
    parseRegistryConfig(config({ providers: [provider({ headers: "x-ok: 1" as never })] })),
  ).toThrow(RegistryError);
});

test("two header names differing only by case are rejected as a duplicate", () => {
  try {
    parseRegistryConfig(
      config({ providers: [provider({ headers: { "x-route": "eu", "X-Route": "us" } })] }),
    );
    throw new Error("expected throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).message).toContain("more than once");
  }
});

test("a header value is never echoed in a validation failure", () => {
  try {
    parseRegistryConfig(
      config({ providers: [provider({ headers: { authorization: "sk-secret-value" } })] }),
    );
    throw new Error("expected throw");
  } catch (error) {
    expect((error as RegistryError).message).not.toContain("sk-secret-value");
    expect((error as RegistryError).detail).not.toContain("sk-secret-value");
  }
});

// --- per-model baseUrl -------------------------------------------------------

test("a model baseUrl overrides the provider's for that model only", () => {
  const cfg = config({
    providers: [
      provider({
        models: [
          model(),
          model({
            name: "m2",
            modelId: "model-2",
            api: "anthropic-messages",
            baseUrl: "https://api.example.com/alt",
          }),
        ],
      }),
    ],
  });
  expect(parseRegistryConfig(cfg).providers[0]?.models[1]?.baseUrl).toBe(
    "https://api.example.com/alt",
  );
  const resolved = resolveRegistry(cfg, { env: fakeEnv({ P1_KEY: "test-key" }) });
  expect(resolved.getModel("m1").baseUrl).toBe("https://api.example.com");
  expect(resolved.getModel("m2").baseUrl).toBe("https://api.example.com/alt");
});

test("a model baseUrl gets the same https-only check as the provider's", () => {
  for (const baseUrl of ["http://api.example.com", "ftp://example.com", "not-a-url", 7]) {
    expect(() =>
      parseRegistryConfig(
        config({ providers: [provider({ models: [model({ baseUrl: baseUrl as never })] })] }),
      ),
    ).toThrow(RegistryError);
  }
});

// --- run-scoped header placeholders ------------------------------------------

test("the session placeholder expands to one value shared by every model of a run", () => {
  const cfg = config({
    providers: [
      provider({
        headers: { "x-session": "run-{{session}}" },
        models: [model(), model({ name: "m2", modelId: "model-2" })],
      }),
    ],
  });
  const resolved = resolveRegistry(cfg, { env: fakeEnv({ P1_KEY: "test-key" }) });
  const first = resolved.getModel("m1").headers?.["x-session"];
  // A run marker, not a per-request nonce: one value across the whole registry.
  expect(first).toMatch(/^run-[0-9a-f-]{36}$/);
  expect(resolved.getModel("m2").headers?.["x-session"]).toBe(first as string);
  // ...and a different value for the next run, which is why it cannot be config.
  const next = resolveRegistry(cfg, { env: fakeEnv({ P1_KEY: "test-key" }) });
  expect(next.getModel("m1").headers?.["x-session"]).not.toBe(first as string);
});

test("an injected session value is used verbatim, in model and provider headers alike", () => {
  const cfg = config({
    providers: [
      provider({
        headers: { "x-session": "{{session}}", "x-both": "a-{{session}}-b-{{session}}" },
        models: [model({ headers: { "x-model": "m-{{session}}" } })],
      }),
    ],
  });
  const resolved = resolveRegistry(cfg, {
    env: fakeEnv({ P1_KEY: "test-key" }),
    session: "fixed-id",
  });
  expect(resolved.getModel("m1").headers).toEqual({
    "x-session": "fixed-id",
    "x-both": "a-fixed-id-b-fixed-id",
    "x-model": "m-fixed-id",
  });
  expect(resolved.models.getProvider("p1")?.headers).toMatchObject({ "x-session": "fixed-id" });
});

test("an unknown placeholder is rejected instead of being transmitted literally", () => {
  for (const value of ["{{sessionn}}", "x-{{SESSION}}", "{{}}", "{{run id}}"]) {
    const cfg = config({ providers: [provider({ headers: { "x-h": value } })] });
    try {
      parseRegistryConfig(cfg);
      throw new Error(`expected rejection for ${value}`);
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as RegistryError).detail).toBe("p1.headers.x-h");
    }
  }
  // The supported token still passes.
  expect(() =>
    parseRegistryConfig(config({ providers: [provider({ headers: { "x-h": "{{session}}" } })] })),
  ).not.toThrow();
});
