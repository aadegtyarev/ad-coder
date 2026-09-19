import { expect, test } from "bun:test";
import { cellFactsEqual, migrateInventoriesToModels } from "../src/config/migrate";
import type { ModelInventoryConfig, ModelInventoryProfile } from "../src/inventory/types";
import type { Complexity } from "../src/orchestration/types";
import type { ProfileEntry, ProfileRole } from "../src/profiles/types";
import type {
  CredentialSource,
  ModelConfig as RegistryModel,
  ProviderConfig as RegistryProvider,
} from "../src/registry/types";

/** Synthetic fixtures only: fake names, no temp files, no real environment. */
const KEY: CredentialSource = { kind: "env-var", envVar: "TEST_PROVIDER_API_KEY" };

function mdl(name: string, modelId: string, over: Partial<RegistryModel> = {}): RegistryModel {
  return {
    name,
    modelId,
    contextWindow: 128000,
    maxTokens: 32000,
    cost: { input: 3, output: 15, cacheRead: 1.5, cacheWrite: 3 },
    ...over,
  };
}

function prov(
  id: string,
  models: RegistryModel[],
  over: Partial<RegistryProvider> = {},
): RegistryProvider {
  return {
    id,
    api: "openai-completions",
    baseUrl: "https://test.example.com/v1",
    credential: KEY,
    models,
    ...over,
  };
}

function entry(
  role: ProfileRole,
  complexity: Complexity,
  model: string,
  over: Partial<ProfileEntry> = {},
): ProfileEntry {
  return { role, complexity, model, ...over };
}

function tiers(role: ProfileRole, model: string): ProfileEntry[] {
  return (["trivial", "medium", "complex"] as const).map((tier) => entry(role, tier, model));
}

function inv(profiles: ModelInventoryProfile[], def?: string): ModelInventoryConfig {
  return { profiles, ...(def === undefined ? {} : { default: def }) };
}

test("single profile: exact parity, bare rows, cache prices only when nonzero", () => {
  const config = inv(
    [
      {
        name: "p1",
        registry: {
          providers: [
            prov("test-provider", [
              mdl("big", "test-big"),
              mdl("small", "test-small", {
                contextWindow: 64000,
                maxTokens: 8000,
                cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 },
              }),
            ]),
          ],
        },
        profile: { entries: [...tiers("coder", "big"), ...tiers("reviewer", "small")] },
      },
    ],
    "p1",
  );
  const { models, report } = migrateInventoriesToModels(config);

  expect(report.profiles[0]).toMatchObject({ name: "p1", status: "migrated" });
  expect(models.defaultProfile).toBe("p1");
  expect(report.parity).toHaveLength(6);
  expect(report.parity.every((row) => row.equal)).toBe(true);
  expect(report.providerConflicts).toEqual([]);

  const provider = models.providers["test-provider"]!;
  expect(provider.enabled).toBe(true);
  expect(provider.credential).toBe("TEST_PROVIDER_API_KEY");
  expect(provider.baseUrl).toBe("https://test.example.com/v1");
  expect(Object.keys(provider.models)).toEqual(["test-big", "test-small"]);
  expect(provider.models["test-small"]!).toEqual({
    input: 0.5,
    output: 2,
    contextWindow: 64000,
    maxTokens: 8000,
  });
  expect(provider.models["test-big"]!.cacheRead).toBe(1.5);
  expect(provider.models["test-big"]!.cacheWrite).toBe(3);

  expect(models.profiles.p1!.routes).toEqual({
    coder: ["test-provider:test-big"],
    reviewer: ["test-provider:test-small"],
  });
  // The stub credential value and no real secret may appear anywhere in the output.
  const dumped = JSON.stringify({ models, report });
  expect(dumped).not.toContain("stub-credential");
  JSON.parse(dumped); // report is serializable
});

test("alias name != modelId: row keys are modelIds, rungs rewritten", () => {
  const config = inv(
    [
      {
        name: "p1",
        registry: { providers: [prov("test-provider", [mdl("sol", "test-sol-1")])] },
        profile: { entries: tiers("coder", "sol") },
      },
    ],
    "p1",
  );
  const { models, report } = migrateInventoriesToModels(config);

  expect(report.parity.every((row) => row.equal)).toBe(true);
  expect(Object.keys(models.providers["test-provider"]!.models)).toEqual(["test-sol-1"]);
  expect(models.profiles.p1!.routes.coder).toEqual(["test-provider:test-sol-1"]);
  expect(JSON.stringify(models)).not.toContain('"sol"');
});

test("tier-differing cells: bare + overrides only, exact round-trip", () => {
  const config = inv(
    [
      {
        name: "p1",
        registry: {
          providers: [
            prov("test-provider", [
              mdl("big", "test-big"),
              mdl("small", "test-small", {
                contextWindow: 64000,
                maxTokens: 8000,
                cost: { input: 0.5, output: 2, cacheRead: 0, cacheWrite: 0 },
              }),
            ]),
          ],
        },
        profile: {
          entries: [
            entry("coder", "trivial", "big"),
            entry("coder", "medium", "big"),
            entry("coder", "complex", "small"),
          ],
        },
      },
    ],
    "p1",
  );
  const { models, report } = migrateInventoriesToModels(config);

  expect(models.profiles.p1!.routes).toEqual({
    coder: ["test-provider:test-big"],
    "coder@complex": ["test-provider:test-small"],
  });
  expect(Object.keys(models.profiles.p1!.routes)).not.toContain("coder@medium");
  expect(report.parity).toHaveLength(3);
  expect(report.parity.every((row) => row.equal)).toBe(true);
  const complexRow = report.parity.find((row) => row.tier === "complex")!;
  expect(complexRow.inventory).toMatchObject({
    providerId: "test-provider",
    modelId: "test-small",
  });
  expect(complexRow.projected).toMatchObject({
    providerId: "test-provider",
    modelId: "test-small",
  });
});

test("extras reported dropped while identity stays at parity", () => {
  const config = inv(
    [
      {
        name: "p1",
        registry: {
          providers: [
            prov(
              "test-provider",
              [
                mdl("big", "test-big", {
                  reasoning: true,
                  api: "anthropic-messages",
                  input: ["text", "image"],
                  compat: { some: "compat" },
                  headers: { "x-tenant": "team1" },
                }),
              ],
              { displayName: "Test Provider" },
            ),
          ],
        },
        profile: {
          entries: [
            entry("coder", "trivial", "big", {
              maxOutput: 1234,
              cacheRetention: "long",
              thinkingLevel: "low",
            }),
            entry("coder", "medium", "big", {
              maxOutput: 1234,
              cacheRetention: "long",
              thinkingLevel: "low",
            }),
            entry("coder", "complex", "big", {
              maxOutput: 1234,
              cacheRetention: "long",
              thinkingLevel: "low",
            }),
          ],
        },
      },
    ],
    "p1",
  );
  const { models, report } = migrateInventoriesToModels(config);

  const droppedFields = report.dropped.map((item) => item.field).sort();
  expect(droppedFields).toEqual([
    "api",
    "cacheRetention",
    "cacheRetention",
    "cacheRetention",
    "compat",
    "displayName",
    "headers",
    "input",
    "maxOutput",
    "maxOutput",
    "maxOutput",
    "reasoning",
    "thinkingLevel",
    "thinkingLevel",
    "thinkingLevel",
  ]);
  // No dropped item carries an unrestricted value: compat/headers name only.
  const compat = report.dropped.find((item) => item.field === "compat")!;
  expect(compat).toEqual({
    profile: "p1",
    provider: "test-provider",
    model: "big",
    field: "compat",
  });
  // The emitted row carries only expressible identity, and it round-trips.
  expect(models.providers["test-provider"]!.models["test-big"]).toEqual({
    input: 3,
    output: 15,
    cacheRead: 1.5,
    cacheWrite: 3,
    contextWindow: 128000,
    maxTokens: 32000,
  });
  expect(report.parity.every((row) => row.equal)).toBe(true);
});

test("oauth provider: reported not expressible, never silently dropped", () => {
  const config = inv(
    [
      {
        name: "p1",
        registry: {
          providers: [
            prov("codex-provider", [mdl("sol", "test-sol")], { credential: { kind: "oauth" } }),
          ],
        },
        profile: { entries: tiers("coder", "sol") },
      },
    ],
    "p1",
  );
  const { models, report } = migrateInventoriesToModels(config);

  expect(report.profiles[0]).toMatchObject({ name: "p1", status: "not-expressible" });
  expect(report.notExpressible).toHaveLength(1);
  expect(report.notExpressible[0]).toMatchObject({ profile: "p1", provider: "codex-provider" });
  expect(report.notExpressible[0]!.reason).toContain("oauth");
  expect(Object.keys(models.providers)).toEqual([]);
  expect(Object.keys(models.profiles)).toEqual([]);
  expect(models.defaultProfile).toBeUndefined();
  expect(report.parity).toEqual([]);
});

test("provider union: two profiles sharing one identical provider merge", () => {
  const shared = prov("test-provider", [mdl("big", "test-big")]);
  const config = inv(
    [
      {
        name: "p1",
        registry: {
          providers: [
            shared,
            prov("other-provider", [mdl("small", "test-small")], {
              baseUrl: "https://other.example.com/v1",
            }),
          ],
        },
        profile: { entries: tiers("coder", "big") },
      },
      {
        name: "p2",
        registry: {
          providers: [
            prov("test-provider", [
              mdl("big", "test-big"),
              mdl("tiny", "test-tiny", {
                contextWindow: 32000,
                maxTokens: 4000,
                cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
              }),
            ]),
          ],
        },
        profile: { entries: tiers("coder", "tiny") },
      },
    ],
    "p1",
  );
  const { models, report } = migrateInventoriesToModels(config);

  expect(report.providers).toEqual(["test-provider", "other-provider"]);
  expect(report.providerConflicts).toEqual([]);
  expect(Object.keys(models.providers["test-provider"]!.models)).toEqual(["test-big", "test-tiny"]);
  expect(Object.keys(models.providers)).toHaveLength(2);
  expect(Object.keys(models.profiles)).toEqual(["p1", "p2"]);
  expect(report.parity).toHaveLength(6);
  expect(report.parity.every((row) => row.equal)).toBe(true);
  expect(models.defaultProfile).toBe("p1");
});

test("conflicting effective declarations: reported, first wins, parity catches the loser", () => {
  const config = inv(
    [
      {
        name: "p1",
        registry: { providers: [prov("test-provider", [mdl("big", "test-big")])] },
        profile: { entries: tiers("coder", "big") },
      },
      {
        name: "p2",
        registry: {
          providers: [
            prov(
              "test-provider",
              [
                mdl("big", "test-big", {
                  cost: { input: 4, output: 15, cacheRead: 1.5, cacheWrite: 3 },
                }),
              ],
              {
                baseUrl: "https://other.example.com/v1",
              },
            ),
          ],
        },
        profile: { entries: tiers("coder", "big") },
      },
    ],
    "p1",
  );
  const { models, report } = migrateInventoriesToModels(config);

  const fields = report.providerConflicts.map((conflict) => conflict.field).sort();
  expect(fields).toEqual(["baseUrl", "model:big"]);
  expect(report.providerConflicts[0]!.profiles).toEqual(["p1", "p2"]);
  // First declaration stands in the output.
  expect(models.providers["test-provider"]!.baseUrl).toBe("https://test.example.com/v1");
  expect(models.providers["test-provider"]!.models["test-big"]!.input).toBe(3);
  // p1 (whose declaration won) is at parity; p2 resolves against p1's numbers
  // and its cost mismatch is exactly what the parity comparator exists to catch.
  const p1Rows = report.parity.filter((row) => row.profile === "p1");
  const p2Rows = report.parity.filter((row) => row.profile === "p2");
  expect(p1Rows.every((row) => row.equal)).toBe(true);
  expect(p2Rows.every((row) => row.equal)).toBe(false);
  const mismatch = p2Rows[0]!;
  expect(mismatch.equal).toBe(false);
  expect(mismatch.inventory!.cost.input).toBe(4);
  expect(mismatch.projected!.cost.input).toBe(3);
});

test("parity comparator rejects an injected wrong number in every field", () => {
  const facts = {
    providerId: "test-provider",
    modelId: "test-big",
    contextWindow: 128000,
    maxTokens: 32000,
    cost: { input: 3, output: 15, cacheRead: 1.5, cacheWrite: 3 },
  };
  expect(cellFactsEqual(facts, facts)).toBe(true);
  expect(cellFactsEqual(facts, { ...facts, providerId: "other" })).toBe(false);
  expect(cellFactsEqual(facts, { ...facts, modelId: "other" })).toBe(false);
  expect(cellFactsEqual(facts, { ...facts, contextWindow: 127999 })).toBe(false);
  expect(cellFactsEqual(facts, { ...facts, maxTokens: 31999 })).toBe(false);
  expect(cellFactsEqual(facts, { ...facts, cost: { ...facts.cost, input: 3.0001 } })).toBe(false);
  expect(cellFactsEqual(facts, { ...facts, cost: { ...facts.cost, output: 15.5 } })).toBe(false);
  expect(cellFactsEqual(facts, { ...facts, cost: { ...facts.cost, cacheRead: 0 } })).toBe(false);
  expect(cellFactsEqual(facts, { ...facts, cost: { ...facts.cost, cacheWrite: 0 } })).toBe(false);
});

test("unresolvable profile: reported not expressible, others still migrate, no crash", () => {
  const config = inv(
    [
      {
        name: "good",
        registry: { providers: [prov("test-provider", [mdl("big", "test-big")])] },
        profile: { entries: tiers("coder", "big") },
      },
      {
        name: "broken",
        registry: {
          providers: [
            // Passes the registry validator, fails resolution: codex-responses
            // has no env-var stream factory, so resolveModelInventory throws.
            prov("broken-provider", [mdl("sol", "test-sol")], { api: "openai-codex-responses" }),
          ],
        },
        profile: { entries: tiers("coder", "sol") },
      },
    ],
    "good",
  );
  const { models, report } = migrateInventoriesToModels(config);

  const statuses = Object.fromEntries(
    report.profiles.map((profile) => [profile.name, profile.status]),
  );
  expect(statuses).toEqual({ good: "migrated", broken: "not-expressible" });
  expect(report.notExpressible).toHaveLength(1);
  expect(report.notExpressible[0]).toMatchObject({ profile: "broken" });
  expect(report.notExpressible[0]!.reason).toContain("openai-codex-responses");
  // The broken profile left no rows and no default, the good one is intact.
  expect(Object.keys(models.providers)).toEqual(["test-provider"]);
  expect(Object.keys(models.profiles)).toEqual(["good"]);
  expect(models.defaultProfile).toBe("good");
  expect(report.parity.every((row) => row.profile === "good" && row.equal)).toBe(true);
  expect(JSON.parse(JSON.stringify(report))).toMatchObject({ profiles: report.profiles });
});
