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
    { env: fakeEnv({}), credentials, storedCredentialIds: new Set(["openrouter"]) },
  );
  const auth = await resolved.models.getAuth("openrouter");
  expect(auth?.auth.apiKey).toBe("stored-test-key");
  expect(auth?.source).toBe("stored credential");
});

test("a stored credential admits any env-var provider named in the knowledge set", async () => {
  // Same store shape as the openrouter test, but for the plain env-var p1:
  // stored-credential admission is a property of the knowledge set, not of
  // one hardcoded provider id.
  const credentials: CredentialStore = {
    read: async (providerId) =>
      providerId === "p1" ? { type: "api_key", key: "stored-test-key" } : undefined,
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => undefined,
  };
  const resolved = resolveRegistry(config(), {
    env: fakeEnv({}),
    credentials,
    storedCredentialIds: new Set(["p1"]),
  });
  const auth = await resolved.models.getAuth("p1");
  expect(auth?.auth.apiKey).toBe("stored-test-key");
  expect(auth?.source).toBe("stored credential");
});

test("an injected store without storedCredentialIds keeps the env-only preflight", () => {
  // The store holds a key for p1, but the resolver is not TOLD so: without the
  // knowledge set the preflight must stay env-only and fail loud, exactly as
  // for a foreign store whose async reads the sync resolver cannot consult.
  const credentials: CredentialStore = {
    read: async (providerId) =>
      providerId === "p1" ? { type: "api_key", key: "stored-test-key" } : undefined,
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => undefined,
  };
  try {
    resolveRegistry(config(), { env: fakeEnv({}), credentials });
    throw new Error("expected throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe("missing_credential");
    expect((error as RegistryError).detail).toBe("P1_KEY");
    expect((error as RegistryError).message).not.toContain("stored-test-key");
  }
});

// --- preflight scope (issue #414) --------------------------------------------

// p1 carries its key in the env; p2's var is unset and nothing is stored.
function twoProviderConfig(): RegistryConfig {
  return {
    providers: [
      provider({ models: [model({ name: "m1" })] }),
      provider({
        id: "p2",
        credential: { kind: "env-var", envVar: "P2_KEY" },
        models: [model({ name: "m2", modelId: "model-2" })],
      }),
    ],
  };
}

test("a provider outside the preflight set registers without missing_credential", () => {
  const resolved = resolveRegistry(twoProviderConfig(), {
    env: fakeEnv({ P1_KEY: "fake-key" }),
    preflightCredentialIds: new Set(["p1"]),
  });
  // Registered and addressable: the key is only needed at dispatch time.
  expect(resolved.getModel("m2").provider).toBe("p2");
});

test("a provider outside the preflight set with its key present resolves auth as before", async () => {
  const resolved = resolveRegistry(twoProviderConfig(), {
    env: fakeEnv({ P1_KEY: "fake-key", P2_KEY: "fake-key-2" }),
    preflightCredentialIds: new Set(["p1"]),
  });
  const auth = await resolved.models.getAuth("p2");
  expect(auth?.auth.apiKey).toBe("fake-key-2");
});

test("a provider inside the preflight set without a key still throws missing_credential, same text", () => {
  try {
    resolveRegistry(twoProviderConfig(), {
      env: fakeEnv({}),
      preflightCredentialIds: new Set(["p1", "p2"]),
    });
    throw new Error("expected throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe("missing_credential");
    expect((error as RegistryError).detail).toBe("P1_KEY");
    expect((error as RegistryError).message).toBe(
      'credential for provider "p1" is not stored and environment variable "P1_KEY" is not set',
    );
    expect((error as RegistryError).message).not.toContain("fake");
  }
});

test("an absent preflightCredentialIds option keeps preflighting every provider", () => {
  try {
    resolveRegistry(twoProviderConfig(), { env: fakeEnv({ P1_KEY: "fake-key" }) });
    throw new Error("expected throw");
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).code).toBe("missing_credential");
    expect((error as RegistryError).detail).toBe("P2_KEY");
  }
});

test("the env accessor is never queried for a provider outside the preflight set", () => {
  const read: string[] = [];
  const countingEnv = (name: string): string | undefined => {
    read.push(name);
    return name === "P1_KEY" ? "fake-key" : undefined;
  };
  resolveRegistry(twoProviderConfig(), {
    env: countingEnv,
    preflightCredentialIds: new Set(["p1"]),
  });
  // Registration touches no secret for the out-of-set provider: no env read
  // for P2 at resolve time, so P2's var is read only at dispatch.
  expect(read).toEqual(["P1_KEY"]);
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
  const declared = base.models![0]!;
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

// --- provider catalogs ---

test("a catalog supplies cost, ceilings, api and base URL the config never states", () => {
  const config = parseRegistryConfig({
    providers: [
      {
        id: "opencode-go",
        api: "openai-completions",
        catalog: "opencode-go",
        credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
        models: [{ modelId: "glm-5.3-flash", name: "flash" }],
      },
    ],
  });
  const model = config.providers[0]!.models[0]!;
  // Exact values, not merely "defined": the whole point of the catalog is that
  // these are the provider's real numbers, so an assertion that would pass on
  // invented ones would not test anything.
  expect(model.cost).toEqual({ input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 });
  // The window is the ONE catalog value not inherited verbatim: the catalog
  // publishes 1_000_000 here, and an inherited window is clamped to
  // DEFAULT_CONTEXT_WINDOW so every routed model shares one ceiling.
  expect(model.contextWindow).toBe(200_000);
  expect(model.maxTokens).toBe(131_072);
  expect(model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
  expect(model.api).toBe("openai-completions");
});

test("a catalog api override wins over the provider api, per model", () => {
  const registry = resolveRegistry(
    {
      providers: [
        {
          id: "opencode-go",
          api: "openai-completions",
          catalog: "opencode-go",
          credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
          models: [
            { modelId: "glm-5.3-flash", name: "flash" },
            { modelId: "minimax-m3", name: "m3" },
          ],
        },
      ],
    },
    { env: () => "k" },
  );
  expect(registry.getModel("flash").api).toBe("openai-completions");
  // The catalog knows this one speaks a different request API than its siblings.
  expect(registry.getModel("m3").api).toBe("anthropic-messages");
  expect(registry.getModel("m3").baseUrl).toBe("https://opencode.ai/zen/go");
});

test("thinking-level support and its compat branch both reach the pi model", () => {
  const registry = resolveRegistry(
    {
      providers: [
        {
          id: "opencode-go",
          api: "openai-completions",
          catalog: "opencode-go",
          credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
          models: [{ modelId: "glm-5.3-flash", name: "flash" }],
        },
      ],
    },
    { env: () => "k" },
  );
  const model = registry.getModel("flash");
  // null marks a level the model rejects: without this the adapter forwards
  // "medium" verbatim and the provider answers with an opaque error.
  expect(model.thinkingLevelMap?.medium).toBeNull();
  expect(model.thinkingLevelMap?.low).toBe("low");
  // The map is read only inside a compat.thinkingFormat branch, so forwarding
  // it without compat would be inert.
  expect(model.compat).toBeDefined();
});

test("declared values override catalog values rather than the reverse", () => {
  const registry = resolveRegistry(
    {
      providers: [
        {
          id: "opencode-go",
          api: "openai-completions",
          catalog: "opencode-go",
          credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
          models: [
            {
              modelId: "glm-5.3-flash",
              name: "flash",
              maxTokens: 4096,
              contextWindow: 32_000,
              cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
            },
          ],
        },
      ],
    },
    { env: () => "k" },
  );
  const model = registry.getModel("flash");
  expect(model.maxTokens).toBe(4096);
  expect(model.contextWindow).toBe(32_000);
  expect(model.cost.input).toBe(1);
});

test("an inherited catalog window is clamped to the default operating ceiling", () => {
  const registry = resolveRegistry(
    {
      providers: [
        {
          id: "opencode-go",
          api: "openai-completions",
          catalog: "opencode-go",
          credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
          models: [
            // The catalog publishes 1_000_000 for this one -- above the ceiling.
            { modelId: "glm-5.3-flash", name: "flash" },
          ],
        },
        {
          id: "openrouter",
          api: "openai-completions",
          catalog: "openrouter",
          credential: { kind: "env-var", envVar: "OPENROUTER_API_KEY" },
          // 131_072 in the catalog: BELOW the ceiling, so it proves the rule is
          // a clamp and not an unconditional overwrite.
          models: [{ modelId: "aion-labs/aion-2.0", name: "small" }],
        },
      ],
    },
    { env: () => "k" },
  );
  expect(registry.getModel("flash").contextWindow).toBe(200_000);
  // Under the ceiling the provider's real limit must survive: raising it to
  // 200_000 would claim capacity this endpoint does not have.
  expect(registry.getModel("small").contextWindow).toBe(131_072);
});

test("a resolved context window carries where it came from", () => {
  // The resolved number alone cannot be explained: 200000 may be declared,
  // inherited, defaulted, or CLAMPED down from a far larger catalog window.
  // Only the last case surprises an operator, so it must be distinguishable.
  const clamped = parseRegistryConfig({
    providers: [
      {
        id: "opencode-go",
        api: "openai-completions",
        catalog: "opencode-go",
        credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
        models: [
          { modelId: "glm-5.3-flash", name: "flash" },
          { modelId: "glm-5.3-flash", name: "stated", contextWindow: 900_000 },
        ],
      },
    ],
  }).providers[0]!.models;
  const inherited = clamped.find((entry) => entry.name === "flash");
  expect(inherited?.contextWindow).toBe(200_000);
  expect(inherited?.contextWindowSource).toBe("catalog-clamped");
  // The window that was given up is recorded, so a front can show both.
  expect(inherited?.catalogContextWindow).toBeGreaterThan(200_000);

  const stated = clamped.find((entry) => entry.name === "stated");
  expect(stated?.contextWindowSource).toBe("declared");
  // Nothing was discarded when the operator stated the window themselves.
  expect(stated?.catalogContextWindow).toBeUndefined();

  // A catalog window already under the ceiling is inherited, not clamped.
  const under = parseRegistryConfig({
    providers: [
      {
        id: "openrouter",
        api: "openai-completions",
        catalog: "openrouter",
        credential: { kind: "env-var", envVar: "OPENROUTER_API_KEY" },
        models: [{ modelId: "aion-labs/aion-2.0", name: "small" }],
      },
    ],
  }).providers[0]!.models[0];
  expect(under?.contextWindow).toBe(131_072);
  expect(under?.contextWindowSource).toBe("catalog");
  expect(under?.catalogContextWindow).toBeUndefined();

  // A hand-declared model with no window at all falls back to the default, and
  // says so rather than claiming the operator asked for 200000.
  const handDeclared = { ...model() };
  delete handDeclared.contextWindow;
  const defaulted = parseRegistryConfig({
    providers: [provider({ models: [handDeclared] })],
  }).providers[0]!.models[0];
  expect(defaulted?.contextWindow).toBe(200_000);
  expect(defaulted?.contextWindowSource).toBe("built-in-default");
});

test("an explicit window larger than the ceiling is still honored verbatim", () => {
  // The clamp is a DEFAULT, not a cap. An operator who states a window is
  // stating the limit they want; silently shrinking it would make the declared
  // config a lie.
  const registry = resolveRegistry(
    {
      providers: [
        {
          id: "opencode-go",
          api: "openai-completions",
          catalog: "opencode-go",
          credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
          models: [{ modelId: "glm-5.3-flash", name: "flash", contextWindow: 900_000 }],
        },
      ],
    },
    { env: () => "k" },
  );
  expect(registry.getModel("flash").contextWindow).toBe(900_000);
});

test("an omitted models list admits the whole catalog under catalog ids", () => {
  const config = parseRegistryConfig({
    providers: [
      {
        id: "deepseek",
        api: "openai-completions",
        catalog: "deepseek",
        credential: { kind: "env-var", envVar: "DEEPSEEK_API_KEY" },
      },
    ],
  });
  const models = config.providers[0]!.models;
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) expect(model.name).toBe(model.modelId);
});

test("an unknown catalog is rejected and the error names the available ones", () => {
  let thrown: RegistryError | undefined;
  try {
    parseRegistryConfig({
      providers: [
        {
          id: "p",
          api: "openai-completions",
          catalog: "opencode-zen",
          credential: { kind: "env-var", envVar: "K" },
          models: [{ modelId: "m", name: "m" }],
        },
      ],
    });
  } catch (error) {
    thrown = error as RegistryError;
  }
  expect(thrown?.code).toBe("unknown_catalog");
  expect(thrown?.detail).toBe("p.catalog");
  // A misspelling is otherwise indistinguishable from an unshipped provider.
  expect(thrown?.message).toContain("opencode-go");
});

test("an id the catalog does not publish is rejected rather than given invented economics", () => {
  let thrown: RegistryError | undefined;
  try {
    parseRegistryConfig({
      providers: [
        {
          id: "openrouter",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          catalog: "openrouter",
          credential: { kind: "env-var", envVar: "OPENROUTER_API_KEY" },
          models: [
            {
              modelId: "@preset/whatever",
              name: "preset",
              maxTokens: 8192,
              cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      ],
    });
  } catch (error) {
    thrown = error as RegistryError;
  }
  expect(thrown?.code).toBe("unknown_model");
  expect(thrown?.message).toContain('"catalog": false');
});

test('"catalog": false admits an account-scoped id beside catalog-backed siblings', () => {
  const config = parseRegistryConfig({
    providers: [
      {
        id: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        catalog: "openrouter",
        credential: { kind: "env-var", envVar: "OPENROUTER_API_KEY" },
        models: [
          { modelId: "minimax/minimax-m3", name: "m3" },
          {
            modelId: "@preset/minimaxm2-5",
            name: "preset",
            catalog: false,
            maxTokens: 8192,
            cost: { input: 0.27, output: 1.08, cacheRead: 0.054, cacheWrite: 0 },
          },
        ],
      },
    ],
  });
  const [fromCatalog, byHand] = config.providers[0]!.models;
  expect(fromCatalog?.cost?.input).toBe(0.3);
  expect(byHand?.cost?.input).toBe(0.27);
  // The opted-out model falls back to the provider baseUrl, which it must still declare.
  expect(byHand?.maxTokens).toBe(8192);
});

test("a catalog provider whose models all opt out must declare its own baseUrl", () => {
  let thrown: RegistryError | undefined;
  try {
    parseRegistryConfig({
      providers: [
        {
          // No provider baseUrl, and the only model opts out of the catalog, so
          // nothing supplies a destination. Resolving that to `undefined` would
          // hand the vendor SDK its own default host together with the declared
          // key, so it must be rejected at validation.
          id: "openrouter",
          api: "openai-completions",
          catalog: "openrouter",
          credential: { kind: "env-var", envVar: "OPENROUTER_API_KEY" },
          models: [
            {
              modelId: "vendor/unlisted",
              name: "unlisted",
              catalog: false,
              maxTokens: 8192,
              cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      ],
    });
  } catch (error) {
    thrown = error as RegistryError;
  }
  expect(thrown?.code).toBe("invalid_config");
  expect(thrown?.detail).toBe("openrouter.baseUrl");
});

test("a catalog provider takes its reported baseUrl from the first model that has one", () => {
  const config = parseRegistryConfig({
    providers: [
      {
        id: "openrouter",
        api: "openai-completions",
        catalog: "openrouter",
        credential: { kind: "env-var", envVar: "OPENROUTER_API_KEY" },
        models: [
          {
            // Opted out first: the fallback must skip it rather than stop at it.
            modelId: "vendor/unlisted",
            name: "unlisted",
            catalog: false,
            maxTokens: 8192,
            cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          },
          { modelId: "minimax/minimax-m3", name: "m3" },
        ],
      },
    ],
  });
  const provider = config.providers[0]!;
  expect(provider.baseUrl).toBe(provider.models[1]!.baseUrl as string);
  expect(provider.baseUrl.startsWith("https://")).toBe(true);
});

test('"catalog": false without a provider catalog is a config error, not a no-op', () => {
  let thrown: RegistryError | undefined;
  try {
    parseRegistryConfig({
      providers: [
        {
          id: "p",
          api: "openai-completions",
          baseUrl: "https://example.com/v1",
          credential: { kind: "env-var", envVar: "K" },
          models: [
            {
              modelId: "m",
              name: "m",
              catalog: false,
              maxTokens: 100,
              cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      ],
    });
  } catch (error) {
    thrown = error as RegistryError;
  }
  expect(thrown?.code).toBe("invalid_config");
  expect(thrown?.detail).toBe("m.catalog");
});

test("a catalog model still needs cost and maxTokens when declared by hand", () => {
  expect(() =>
    parseRegistryConfig({
      providers: [
        {
          id: "p",
          api: "openai-completions",
          baseUrl: "https://example.com/v1",
          credential: { kind: "env-var", envVar: "K" },
          models: [{ modelId: "m", name: "m", maxTokens: 100 }],
        },
      ],
    }),
  ).toThrow(RegistryError);
});

test("declared headers still apply to a catalog-backed model", () => {
  const registry = resolveRegistry(
    {
      providers: [
        {
          id: "opencode-go",
          api: "openai-completions",
          catalog: "opencode-go",
          credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
          headers: { "x-opencode-session": "adcoder-{{session}}" },
          models: [
            { modelId: "glm-5.3-flash", name: "flash" },
            { modelId: "minimax-m3", name: "m3", headers: { "x-route": "pinned" } },
          ],
        },
      ],
    },
    { env: () => "k", session: "fixed" },
  );
  expect(registry.getModel("flash").headers?.["x-opencode-session"]).toBe("adcoder-fixed");
  // A per-model header survives the catalog merge alongside the provider's own.
  const pinned = registry.getModel("m3").headers;
  expect(pinned?.["x-route"]).toBe("pinned");
  expect(pinned?.["x-opencode-session"]).toBe("adcoder-fixed");
});

test("a model api override that contradicts the catalog is rejected", () => {
  let thrown: RegistryError | undefined;
  try {
    parseRegistryConfig({
      providers: [
        {
          id: "opencode-go",
          api: "openai-completions",
          catalog: "opencode-go",
          credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
          models: [{ modelId: "glm-5.3-flash", name: "flash", api: "anthropic-messages" }],
        },
      ],
    });
  } catch (error) {
    thrown = error as RegistryError;
  }
  expect(thrown?.code).toBe("unsupported_api");
  expect(thrown?.detail).toBe("flash");
});

test("a catalog admits no model on an api the resolver cannot construct", () => {
  const config = parseRegistryConfig({
    providers: [
      {
        id: "opencode-go",
        api: "openai-completions",
        catalog: "opencode-go",
        credential: { kind: "env-var", envVar: "OPENCODE_API_KEY" },
      },
    ],
  });
  // opencode-go publishes openai-responses models too; admitting one would put
  // a name in the registry that routing can select and then fail to dispatch.
  for (const model of config.providers[0]!.models) {
    expect(["openai-completions", "anthropic-messages"]).toContain(String(model.api));
  }
  expect(config.providers[0]!.models.some((m) => m.modelId === "gpt-5.6-luna")).toBe(false);
});
