import { expect, test } from "bun:test";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelInventoryConfig, Profile, RegistryConfig } from "ad-coder";
import {
  ModelInventoryError,
  parseModelInventoryConfig,
  RegistryError,
  resolveModelInventory,
} from "ad-coder";

function registry(name = "model-a", envVar = "INVENTORY_TEST_KEY"): RegistryConfig {
  return {
    providers: [
      {
        id: `provider-${name}`,
        api: "openai-completions",
        baseUrl: "https://api.example.com",
        credential: { kind: "env-var", envVar },
        models: [
          {
            name,
            modelId: `native-${name}`,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ],
  };
}

function profile(model = "model-a"): Profile {
  return { entries: [{ role: "coder", complexity: "medium", model }] };
}

function inventory(): ModelInventoryConfig {
  return {
    profiles: [
      { name: "primary", registry: registry(), profile: profile() },
      { name: "backup", registry: registry("model-b", "BACKUP_KEY"), profile: profile("model-b") },
    ],
    default: "primary",
  };
}

test("validates and resolves a named atomic registry/profile pair", () => {
  const parsed = parseModelInventoryConfig(inventory());
  expect(parsed.profiles.map((entry) => entry.name)).toEqual(["primary", "backup"]);
  const resolved = resolveModelInventory(parsed, "backup", {
    env: (name) => (name === "BACKUP_KEY" ? "secret-value" : undefined),
  });
  expect(resolved.name).toBe("backup");
  expect(resolved.profile.entries[0]?.model).toBe("model-b");
  expect(resolved.registry.getModel("model-b").id).toBe("native-model-b");
  expect(resolved.summary).toEqual({
    name: "backup",
    providerIds: ["provider-model-b"],
    modelNames: ["model-b"],
  });
  expect(JSON.stringify(resolved.summary)).not.toContain("secret-value");
  expect(JSON.stringify(resolved.summary)).not.toContain("BACKUP_KEY");
});

test("storedCredentialIds threads through to the registry preflight", async () => {
  // Direct callers of resolveModelInventory own the same seam resolveConfig
  // does: without the knowledge set the injected store's async read is
  // invisible to the sync preflight and the resolution must fail loud.
  const credentials: CredentialStore = {
    read: async (providerId) =>
      providerId === "provider-model-a" ? { type: "api_key", key: "stored-test-key" } : undefined,
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => undefined,
  };
  const admitted = resolveModelInventory(inventory(), undefined, {
    env: () => undefined,
    credentials,
    storedCredentialIds: new Set(["provider-model-a"]),
  });
  const auth = await admitted.registry.models.getAuth("provider-model-a");
  expect(auth?.auth.apiKey).toBe("stored-test-key");
  expect(auth?.source).toBe("stored credential");

  let thrown: unknown;
  try {
    resolveModelInventory(inventory(), undefined, { env: () => undefined, credentials });
    throw new Error("expected throw");
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RegistryError);
  expect((thrown as RegistryError).code).toBe("missing_credential");
  expect((thrown as RegistryError).detail).toBe("INVENTORY_TEST_KEY");
});

test("uses the optional default and requires selection when absent", () => {
  const selected = resolveModelInventory(inventory(), undefined, {
    env: (name) => (name === "INVENTORY_TEST_KEY" ? "key" : undefined),
  });
  expect(selected.name).toBe("primary");
  expect(selected.source).toBe("default");

  const withoutDefault = inventory();
  delete withoutDefault.default;
  expect(() => resolveModelInventory(withoutDefault)).toThrow(ModelInventoryError);
});

test("rejects malformed, duplicate, and unknown default names", () => {
  expect(() => parseModelInventoryConfig({ profiles: [] })).toThrow(ModelInventoryError);
  expect(() =>
    parseModelInventoryConfig({
      profiles: [{ name: "bad name", registry: registry(), profile: profile() }],
    }),
  ).toThrow(ModelInventoryError);
  expect(() =>
    parseModelInventoryConfig({
      profiles: [
        { name: "same", registry: registry(), profile: profile() },
        { name: "same", registry: registry("model-b"), profile: profile("model-b") },
      ],
    }),
  ).toThrow(ModelInventoryError);
  expect(() =>
    parseModelInventoryConfig({
      profiles: [{ name: "primary", registry: registry(), profile: profile() }],
      default: "missing",
    }),
  ).toThrow(ModelInventoryError);
});

test("rejects profile references outside its paired registry", () => {
  try {
    parseModelInventoryConfig({
      profiles: [{ name: "primary", registry: registry(), profile: profile("model-b") }],
    });
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ModelInventoryError);
    expect((error as ModelInventoryError).code).toBe("unknown_model");
    expect((error as ModelInventoryError).detail).toBe("model-b");
  }
});

test("one inventory routes coder and reviewer across different providers", () => {
  const coderRegistry = registry("coder-model", "CODER_KEY");
  const reviewerRegistry = registry("reviewer-model", "REVIEWER_KEY");
  const mixed: ModelInventoryConfig = {
    profiles: [
      {
        name: "mixed",
        registry: {
          providers: [...(coderRegistry.providers ?? []), ...(reviewerRegistry.providers ?? [])],
        },
        profile: {
          entries: [
            { role: "coder", complexity: "medium", model: "coder-model" },
            { role: "reviewer", complexity: "medium", model: "reviewer-model" },
          ],
        },
      },
    ],
  };
  const resolved = resolveModelInventory(mixed, "mixed", {
    env: (name) => (name === "CODER_KEY" || name === "REVIEWER_KEY" ? "secret" : undefined),
  });
  expect(resolved.registry.getModel("coder-model").provider).toBe("provider-coder-model");
  expect(resolved.registry.getModel("reviewer-model").provider).toBe("provider-reviewer-model");
  expect(resolved.summary.providerIds).toEqual(["provider-coder-model", "provider-reviewer-model"]);
});
