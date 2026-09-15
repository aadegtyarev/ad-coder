import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { resolvePipelineConfig } from "../src/cli/resolve-config";
import { deriveContextBudget } from "../src/context/budget";
import {
  COST_ANOMALY_STATE_PATH,
  CostAnomalyDetector,
  FileCostAnomalyStore,
} from "../src/economics/cost-anomaly";
import type { ModelInventoryConfig } from "../src/inventory/types";
import { buildDefaultProfile } from "../src/profiles/default-profile";
import { resolveProfile } from "../src/profiles/resolve";
import { writeProjectCalibrationSnapshot } from "../src/project-calibration";
import { RegistryError } from "../src/registry/errors";
import type { RegistryConfig } from "../src/registry/types";
import { parseRegistryConfig } from "../src/registry/validate";

/** A fake env accessor over a plain record; nothing touches the real process.env. */
function fakeEnv(vars: Record<string, string>): (name: string) => string | undefined {
  return (name: string) => vars[name];
}

/** Swallow the resolver's stderr notices so tests stay quiet. */
const silent = () => {};

function mixedRegistry(): RegistryConfig {
  const make = (name: string, contextWindow: number) => ({
    name,
    modelId: name,
    contextWindow,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  return {
    providers: [
      {
        id: "local",
        api: "openai-completions",
        baseUrl: "https://localhost.example/v1",
        credential: { kind: "env-var", envVar: "LOCAL_KEY" },
        models: [make("small", 32000), make("large", 200000)],
      },
    ],
  };
}

test("a resolved pipeline carries a live cost-anomaly detector, so default-on is real", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-anomaly-"));
  try {
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: dir,
      registryConfig: mixedRegistry(),
      profile: buildDefaultProfile({ strong: "small", mid: "small", cheap: "small" }),
      summarizerModel: "small",
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    });

    // The contract makes detection default-on. A detector nobody constructs
    // protects nobody, so the wiring -- not just the class -- is what this pins.
    const detector = config.costAnomalyDetector;
    expect(detector).toBeDefined();
    expect(detector?.config.enabled).toBe(true);

    // And it is backed by this project's own durable state: a block it raises
    // is still standing for the `cost release` that lifts it.
    const spike = (rate: number) => ({
      provider: "local",
      model: "small",
      costUsd: rate * 1000,
      totalTokens: 1000,
    });
    for (let index = 0; index < 5; index += 1) detector?.observe(spike(0.000002));
    detector?.observe(spike(0.000008));
    detector?.observe(spike(0.000008));
    expect(fs.existsSync(path.join(dir, COST_ANOMALY_STATE_PATH))).toBe(true);
    expect(new CostAnomalyDetector({}, new FileCostAnomalyStore(dir)).blocked()).toHaveLength(1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [modelName, window, expectedBudget] of [
  ["small", 32_000, 28_800],
  ["large", 200_000, 180_000],
] as const) {
  test(`homogeneous ${window}-token configuration derives role-local budgets`, () => {
    const config = resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp/target",
      registryConfig: mixedRegistry(),
      profile: buildDefaultProfile({ strong: modelName, mid: modelName, cheap: modelName }),
      summarizerModel: modelName,
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    });
    expect(config.roles.planner?.role.contextBudget.maxTokens).toBe(expectedBudget);
    expect(config.roles.coder.role.contextBudget.maxTokens).toBe(expectedBudget);
    expect(config.compaction?.mode).toBe("auto");
  });
}

test("mixed-window roles select independently and derive independent budgets", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    plannerModel: "small",
    researcherModel: "large",
    securityModel: "large",
    coderModel: "small",
    reviewerModel: "large",
    auditorModel: "small",
    orchestratorModel: "small",
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  });
  expect(config.roles.planner?.model.contextWindow).toBe(32000);
  expect(config.roles.security?.model.contextWindow).toBe(200000);
  expect(config.roles.researcher?.model.contextWindow).toBe(200000);
  expect(config.roles.coder.role.contextBudget.maxTokens).toBe(28800);
  expect(config.roles.reviewer.role.contextBudget.maxTokens).toBe(180000);
  expect(config.roles.auditor?.role.contextBudget.maxTokens).toBe(28800);
  expect(config.roles.orchestrator?.model.contextWindow).toBe(32000);
});

test("config show reports the context window each role will actually use", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    plannerModel: "small",
    reviewerModel: "large",
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  });
  // Per-role, because two roles on different models have different windows and
  // a single number would be wrong for at least one of them.
  expect(config.effectiveConfig?.["contextWindow.planner"]).toEqual({
    value: 32_000,
    source: "declared",
  });
  expect(config.effectiveConfig?.["contextWindow.reviewer"]).toEqual({
    value: 200_000,
    source: "declared",
  });
  // The window is not the ceiling a turn gets; the derived budget is, so both
  // are projected and the operator can see the relationship.
  expect(config.effectiveConfig?.["contextBudgetMaxTokens.planner"]).toEqual({
    value: 28_800,
    source: "derived",
  });
  expect(config.effectiveConfig?.["contextWindow.orchestrator"]).toBeDefined();
});

test("a clamped context window names the window it was clamped from", () => {
  // The operator's actual complaint: a config that reads 1000000 runs at
  // 200000 with nothing anywhere saying so.
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    registryConfig: {
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
    profile: buildDefaultProfile({ strong: "flash", mid: "flash", cheap: "flash" }),
    summarizerModel: "flash",
    env: fakeEnv({ OPENCODE_API_KEY: "k" }),
    warn: silent,
  });
  const projected = config.effectiveConfig?.["contextWindow.coder"];
  expect(projected?.value).toBe(200_000);
  // Both halves of the surprise: that it was clamped, and what it lost.
  expect(String(projected?.source)).toContain("catalog-clamped");
  expect(String(projected?.source)).toMatch(/from \d+/);
});

test("the clamp stays visible when the registry was already validated once", () => {
  // THE PATH EVERY REAL `config show` TAKES. `cli.ts` validates the registry at
  // its entry points and `resolveConfig` validates again, so the config that
  // reaches the projection has been through two passes. The test above calls
  // the library with a raw object and takes only one, which is why it passed
  // while the CLI printed "declared" for a window nobody declared -- the second
  // pass read back the number the first pass had written and concluded an
  // operator must have written it.
  const authored = {
    providers: [
      {
        id: "opencode-go",
        api: "openai-completions" as const,
        catalog: "opencode-go",
        credential: { kind: "env-var" as const, envVar: "OPENCODE_API_KEY" },
        models: [{ modelId: "glm-5.3-flash", name: "flash" }],
      },
    ],
  };
  const once = parseRegistryConfig(authored);
  // Validation is idempotent at the source, so the projection cannot depend on
  // how many times the config was handled on its way there.
  const twice = parseRegistryConfig(once);
  expect(twice.providers[0]?.models[0]?.contextWindowSource).toBe("catalog-clamped");
  expect(twice.providers[0]?.models[0]?.catalogContextWindow).toBe(1_000_000);

  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    registryConfig: once,
    profile: buildDefaultProfile({ strong: "flash", mid: "flash", cheap: "flash" }),
    summarizerModel: "flash",
    env: fakeEnv({ OPENCODE_API_KEY: "k" }),
    warn: silent,
  });
  const projected = config.effectiveConfig?.["contextWindow.coder"];
  expect(projected?.value).toBe(200_000);
  expect(String(projected?.source)).toContain("catalog-clamped");
  expect(String(projected?.source)).toContain("1000000");
});

test("two entries sharing a native id under different windows are left unlabelled", () => {
  // A real ambiguity: both are hand-declared, so both read `declared` with no
  // catalog number, and comparing labels alone called them identical. The
  // first one registered then answered for the other -- a specific number,
  // confidently sourced, and arbitrary. Dropping the label is the honest
  // answer, and it is what the docstring already promised.
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    registryConfig: {
      providers: [
        {
          id: "one",
          api: "openai-completions",
          baseUrl: "https://one.example",
          credential: { kind: "env-var", envVar: "LOCAL_KEY" },
          models: [
            {
              modelId: "shared-id",
              name: "wide",
              contextWindow: 128_000,
              maxTokens: 4_000,
              cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
        {
          id: "two",
          api: "openai-completions",
          baseUrl: "https://two.example",
          credential: { kind: "env-var", envVar: "LOCAL_KEY" },
          models: [
            {
              modelId: "shared-id",
              name: "narrow",
              contextWindow: 32_000,
              maxTokens: 4_000,
              cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      ],
    },
    profile: buildDefaultProfile({ strong: "wide", mid: "wide", cheap: "wide" }),
    summarizerModel: "wide",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  });
  const projected = config.effectiveConfig?.["contextWindow.coder"];
  // The number is still the one the role actually uses -- only the claim about
  // where it came from is withheld.
  expect(projected?.value).toBe(128_000);
  expect(projected?.source).toBe("registry");
});

test("every complexity route and override derives from its dispatched model window", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    summarizerModel: "large",
    overrides: { reviewer: { model: "large" } },
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  });
  const routing = config.routing!;
  for (const complexity of ["trivial", "medium", "complex"] as const) {
    for (const role of [
      "planner",
      "researcher",
      "security",
      "coder",
      "reviewer",
      "auditor",
    ] as const) {
      const model = resolveProfile(
        routing.profile,
        routing.registry,
        role,
        complexity,
        routing.overrides?.[role],
      ).model;
      const budget = deriveContextBudget(model.contextWindow, routing.budgetPercents?.[role]);
      expect(budget.maxTokens).toBe(model.contextWindow === 200000 ? 180000 : 28800);
    }
  }
});

test("undersized summarizer rejects every reachable routing cell and override", () => {
  expect(() =>
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp/target",
      registryConfig: mixedRegistry(),
      profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
      coderModel: "large",
      summarizerModel: "small",
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    }),
  ).toThrow("summarizer context window 32000 is below reachable maximum 200000");
});

test("budget percentages validate centrally", () => {
  expect(() =>
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp/target",
      registryConfig: mixedRegistry(),
      profile: buildDefaultProfile({ strong: "small", mid: "small", cheap: "small" }),
      summarizerModel: "small",
      budgetPercents: { maxTokensPercent: 1 },
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    }),
  ).toThrow("maxTokensPercent");
});

test("all pipeline roles automatically use byte-verbatim target prompt overrides", () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-role-prompts-"));
  const promptDir = path.join(targetDir, ".ad-coder", "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  const names = ["planner", "security", "coder", "reviewer"] as const;
  for (const name of names) {
    fs.writeFileSync(path.join(promptDir, `${name}.md`), `target ${name} \t\n`, "utf8");
  }

  const config = resolvePipelineConfig({
    task: "x",
    targetDir,
    env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
    warn: silent,
  });

  for (const name of names) {
    expect(config.roles[name]?.role.systemPrompt).toBe(`target ${name} \t\n`);
  }
});

test("selects deepseek by env presence and builds a valid PipelineConfig", () => {
  const config = resolvePipelineConfig({
    task: "do a thing",
    targetDir: "/tmp/target",
    env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
    warn: silent,
  });

  expect(config.routing?.registry.getModel("deepseek-chat")).toBeDefined();
  expect(config.roles.planner).toBeDefined();
  expect(config.roles.security).toBeDefined();
  expect(config.roles.coder).toBeDefined();
  expect(config.roles.reviewer).toBeDefined();
  expect(config.maxRounds).toBe(2);
  expect(config.routing?.defaultComplexity).toBe("medium");
  expect(config.models).toBe(config.routing?.registry.models as typeof config.models);
  expect(config.ledgerSink).toBeDefined();
  expect(config.task).toBe("do a thing");
  expect(config.targetDir).toBe("/tmp/target");
  expect(config.compaction?.mode).toBe("auto");
  expect(config.compaction?.summarizerModel?.id).toBe("deepseek-chat");
  expect(config.compaction?.summarizer).toBeUndefined();
});

test("threads ProjectStore policy into the resolved pipeline config", () => {
  const projectStoreConfig = {
    retention: { sessions: 0, tmp: 7 },
    byteLimits: { attachment: 0, state: 1024, jsonlRecord: 2048 },
    projectOperations: {
      backlogBackend: "github" as const,
      evidenceLimit: 0,
      aggregationLimit: 12,
      claimLeaseMs: 30_000,
      github: { repository: "owner/repository" },
    },
  };
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
    warn: silent,
    projectStoreConfig,
  });
  expect(config.projectStoreConfig).toBe(projectStoreConfig);
});

test("compaction resolution carries its model but defers construction to limited Models", () => {
  const auto = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    provider: "deepseek",
    env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
    summarizerModel: "deepseek-chat",
    warn: silent,
  });
  expect(auto.compaction?.summarizerModel?.id).toBe("deepseek-chat");

  const disabled = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
    compactionMode: "disabled-then-halt",
    warn: silent,
  });
  expect(disabled.compaction).toEqual({ mode: "disabled-then-halt" });
});

test("cache-aware fails loudly instead of degrading", () => {
  expect(() =>
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp/target",
      env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
      compactionMode: "cache-aware",
      warn: silent,
    }),
  ).toThrow('"cache-aware" is not supported');
});

test("an unknown summarizer model uses the registry's names-only error", () => {
  expect(() =>
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp/target",
      env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
      summarizerModel: "missing",
      warn: silent,
    }),
  ).toThrow(RegistryError);
});

test("selects openrouter when only OPENROUTER_API_KEY is present", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    env: fakeEnv({ OPENROUTER_API_KEY: "k" }),
    warn: silent,
  });
  expect(config.routing?.registry.getModel("openrouter-auto")).toBeDefined();
});

test("provider override wins when both provider keys are present", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    provider: "openrouter",
    env: fakeEnv({ DEEPSEEK_API_KEY: "d", OPENROUTER_API_KEY: "o" }),
    warn: silent,
  });
  expect(config.routing?.registry.getModel("openrouter-auto")).toBeDefined();
});

test("falls back to codex OAuth when no env-var key is present", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    env: fakeEnv({}),
    warn: silent,
  });
  expect(config.roles.planner?.model.id).toBe("gpt-5.6-sol");
  expect(config.roles.security?.model.id).toBe("gpt-5.6-sol");
  expect(config.roles.coder.model.id).toBe("gpt-5.6-sol");
  expect(config.roles.coder.role.thinkingLevel).toBe("medium");
  expect(config.roles.reviewer.model.id).toBe("gpt-5.6-terra");
  expect(config.roles.orchestrator?.model.id).toBe("gpt-5.6-sol");
  expect(config.roles.orchestrator?.role.thinkingLevel).toBe("low");
  expect(
    config.routing?.profile.entries
      .filter((entry) => entry.role === "coder")
      .map((entry) => [entry.complexity, entry.model, entry.thinkingLevel]),
  ).toEqual([
    ["trivial", "codex-sol", "medium"],
    ["medium", "codex-sol", "medium"],
    ["complex", "codex-sol", "medium"],
  ]);
  expect(config.compaction?.summarizerModel?.id).toBe("gpt-5.6-luna");
  expect(config.routing?.registry.getModel("codex-gpt-5.5")).toBeDefined();
});

test("explicit profile and spawn override keep precedence over provider defaults", () => {
  const profile = buildDefaultProfile({
    strong: "codex-astra",
    mid: "codex-terra",
    cheap: "codex-luna",
  });
  profile.entries = profile.entries.map((entry) =>
    entry.role === "coder" ? { ...entry, thinkingLevel: "minimal" as const } : entry,
  );
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    provider: "openai-codex",
    profile,
    overrides: { coder: { model: "codex-sol", thinkingLevel: "high" } },
    env: fakeEnv({}),
    warn: silent,
  });
  expect(config.roles.coder.model.id).toBe("gpt-5.6-sol");
  expect(config.roles.coder.role.thinkingLevel).toBe("high");
});

test("a profile cacheRetention reaches the role instead of being discarded", () => {
  // The whole point: "long" is parsed and validated upstream, so the only way
  // it can fail is by being dropped between the profile and the role. On an
  // Anthropic-shaped model that difference is a 5-minute vs 1-hour cache TTL,
  // i.e. real money, and it fails silently.
  const profile = buildDefaultProfile({
    strong: "codex-astra",
    mid: "codex-terra",
    cheap: "codex-luna",
  });
  profile.entries = profile.entries.map((entry) =>
    entry.role === "coder" ? { ...entry, cacheRetention: "long" as const } : entry,
  );
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    provider: "openai-codex",
    profile,
    env: fakeEnv({}),
    warn: silent,
  });
  expect(config.roles.coder.role.cacheRetention).toBe("long");
  // A role the profile says nothing about keeps the default, so the wiring is
  // "honor what was stated", not "overwrite everything".
  expect(config.roles.reviewer.role.cacheRetention).toBe("short");
  // The orchestrator has no cell of its own -- it selects through the coder's,
  // so the declared value has to reach it too. Asserted separately because the
  // orchestrator is built by a different code path than the routed roles, and
  // that path is exactly where the value was dropped a second time.
  expect(config.roles.orchestrator?.role.cacheRetention).toBe("long");
});

test("non-Codex provider retains generic profile defaults without a thinking level", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  });
  expect(config.roles.coder.role.thinkingLevel).toBeUndefined();
  expect(config.roles.orchestrator?.role.thinkingLevel).toBeUndefined();
});

test("orchestrator thinking override wins over the Codex OAuth default", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    env: fakeEnv({}),
    orchestratorThinkingLevel: "high",
    warn: silent,
  });
  expect(config.roles.orchestrator?.role.thinkingLevel).toBe("high");
});

test("resolvePipelineConfig gives its Models the injected CredentialStore", async () => {
  let reads = 0;
  const credentials: CredentialStore = {
    read: async () => {
      reads += 1;
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
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    env: fakeEnv({}),
    credentials,
    warn: silent,
  });
  const auth = await config.models.getAuth("openai-codex");
  expect(reads).toBe(1);
  expect(auth).toBeDefined();
});

test("a forced env-var provider with no key throws missing_credential naming the var only", () => {
  let thrown: unknown;
  try {
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp/target",
      provider: "deepseek",
      env: fakeEnv({}),
      warn: silent,
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(RegistryError);
  const err = thrown as RegistryError;
  expect(err.code).toBe("missing_credential");
  expect(err.detail).toBe("DEEPSEEK_API_KEY");
});

test("the four roles carry a context budget that validates against the chosen model window", () => {
  // deepseek-chat's window is 64000; the derived maxTokens must not exceed it,
  // and reserve + keepRecent must stay below maxTokens (defineRole enforces
  // this at build time, so a returned config already proves it).
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    env: fakeEnv({ DEEPSEEK_API_KEY: "k" }),
    warn: silent,
  });
  const budget = config.roles.coder.role.contextBudget;
  expect(budget.maxTokens).toBeLessThanOrEqual(64000);
  expect(budget.reserveTokens + budget.keepRecentTokens).toBeLessThan(budget.maxTokens);
});

test("multiple provider keys with no explicit provider warns and selects by precedence", () => {
  const messages: string[] = [];
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    env: fakeEnv({ DEEPSEEK_API_KEY: "d", OPENROUTER_API_KEY: "o" }),
    warn: (m) => messages.push(m),
  });
  expect(config.routing?.registry.getModel("deepseek-chat")).toBeDefined();
  expect(messages.some((m) => m.includes("multiple provider keys"))).toBe(true);
});

test("surface analysis limits expose effective values and winning provenance", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp/target",
    env: fakeEnv({}),
    warn: silent,
    surfaceAnalysisLimits: { maxItems: 7 },
  });
  expect(config.surfaceAnalysisLimits).toEqual({
    maxItems: 7,
    maxTextBytes: 0,
    maxAggregateBytes: 0,
    maxDepth: 0,
  });
  expect(config.effectiveConfig?.["surfaceAnalysisLimits.maxItems"]).toEqual({
    value: 7,
    source: "cli",
  });
  expect(config.effectiveConfig?.["surfaceAnalysisLimits.maxDepth"]).toEqual({
    value: 0,
    source: "built-in-default",
  });
  expect(() =>
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp/target",
      env: fakeEnv({}),
      warn: silent,
      surfaceAnalysisLimits: { maxItems: Number.MAX_SAFE_INTEGER + 1 },
    }),
  ).toThrow("non-negative safe integer");
});

test("built-in plugin groups are selectable, visible, and mutually exclusive with custom tools", () => {
  const base = {
    task: "x",
    targetDir: "/tmp",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  } as const;
  const selected = resolvePipelineConfig({ ...base, enabledPlugins: ["explore"] });
  expect(selected.pluginTools?.map(({ name }) => name)).toEqual([
    "explore_project",
    "search_project",
    "read_project",
  ]);
  expect(selected.roles.planner?.role.activeToolNames).toEqual([
    "read",
    "explore_project",
    "search_project",
    "read_project",
    "submit_plan",
    "submit_follow_up",
  ]);
  expect(selected.roles.coder?.role.activeToolNames).toEqual([
    "read",
    "write",
    "edit",
    "bash",
    "search_project",
    "read_project",
    "submit_follow_up",
  ]);
  for (const role of ["security", "reviewer", "auditor"] as const) {
    expect(selected.roles[role]?.role.activeToolNames).toContain("explore_project");
    expect(selected.roles[role]?.role.activeToolNames).toContain("read");
    expect(selected.roles[role]?.role.activeToolNames).toContain("bash");
  }
  expect(selected.roles.researcher?.role.activeToolNames).toContain("read_project");
  expect(selected.effectiveConfig?.enabledPlugins).toEqual({ value: "explore", source: "cli" });
  const disabled = resolvePipelineConfig({ ...base, enabledPlugins: [] });
  for (const spec of Object.values(disabled.roles)) {
    expect(spec?.role.activeToolNames).not.toContain("explore_project");
    expect(spec?.role.activeToolNames).not.toContain("search_project");
    expect(spec?.role.activeToolNames).not.toContain("read_project");
    expect(spec?.role.activeToolNames).not.toContain("web_search");
    expect(spec?.role.activeToolNames).not.toContain("web_read");
  }
  expect(disabled.roles.planner?.role.activeToolNames).toContain("read");
  expect(() => resolvePipelineConfig({ ...base, enabledPlugins: [], pluginTools: [] })).toThrow(
    "pluginTools cannot be combined with enabledPlugins",
  );
  const custom = resolvePipelineConfig({ ...base, pluginTools: [] });
  const customUsingBuiltInNames = resolvePipelineConfig({
    ...base,
    pluginTools: selected.pluginTools ?? [],
  });
  for (const resolved of [custom, customUsingBuiltInNames]) {
    for (const spec of Object.values(resolved.roles)) {
      expect(spec?.role.activeToolNames).not.toContain("explore_project");
      expect(spec?.role.activeToolNames).not.toContain("search_project");
      expect(spec?.role.activeToolNames).not.toContain("read_project");
      expect(spec?.role.activeToolNames).not.toContain("web_search");
      expect(spec?.role.activeToolNames).not.toContain("web_read");
    }
  }
});

test("every built-in plugin combination keeps role tools and prompt fallbacks aligned", () => {
  const base = {
    task: "x",
    targetDir: "/tmp",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  } as const;
  const combinations = [
    [],
    ["explore"],
    ["web"],
    ["vision"],
    ["explore", "web"],
    ["explore", "vision"],
    ["web", "vision"],
    ["explore", "web", "vision"],
  ] as const;
  for (const enabledPlugins of combinations) {
    const resolved = resolvePipelineConfig({ ...base, enabledPlugins: [...enabledPlugins] });
    const pluginNames: readonly string[] = enabledPlugins;
    const hasExplore = pluginNames.includes("explore");
    const hasWeb = pluginNames.includes("web");
    for (const role of [
      "planner",
      "researcher",
      "security",
      "coder",
      "reviewer",
      "auditor",
    ] as const) {
      const spec = resolved.roles[role];
      expect(spec).toBeDefined();
      for (const tool of ["explore_project", "search_project", "read_project"]) {
        expect(spec?.role.activeToolNames?.includes(tool)).toBe(
          hasExplore && !(role === "coder" && tool === "explore_project"),
        );
      }
      expect(spec?.role.systemPrompt).toMatch(/when\s+(?:[^\n]*tools are\s+)?available/i);
    }
    for (const role of ["researcher", "auditor"] as const) {
      expect(resolved.roles[role]?.role.activeToolNames?.includes("web_search")).toBe(hasWeb);
      expect(resolved.roles[role]?.role.activeToolNames?.includes("web_read")).toBe(hasWeb);
    }
  }
});

test("provider request timeout is effective, visible, and zero-disabled", () => {
  const base = {
    task: "x",
    targetDir: "/tmp",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  } as const;
  const defaults = resolvePipelineConfig(base);
  expect(defaults.roles.coder.role.requestTimeoutMs).toBe(120_000);
  expect(defaults.effectiveConfig?.requestTimeoutMs).toEqual({
    value: 120_000,
    source: "built-in-default",
  });
  const disabled = resolvePipelineConfig({ ...base, requestTimeoutMs: 0 });
  expect(disabled.roles.coder.role.requestTimeoutMs).toBe(0);
  expect(disabled.effectiveConfig?.requestTimeoutMs).toEqual({ value: 0, source: "cli" });
});

test("pipeline context defaults to incremental and exposes validated overrides", () => {
  const base = {
    task: "x",
    targetDir: "/tmp",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  } as const;
  const defaults = resolvePipelineConfig(base);
  expect(defaults.pipelineContext).toEqual({
    mode: "incremental",
    maxFocusedDiffBytes: 65_536,
    projection: { maxPaths: 128, maxPathBytes: 1024, maxAggregateBytes: 32_768 },
  });
  expect(defaults.effectiveConfig?.pipelineContextMode).toEqual({
    value: "incremental",
    source: "built-in-default",
  });
  const full = resolvePipelineConfig({
    ...base,
    pipelineContextMode: "full",
    pipelineContextMaxDiffBytes: 0,
    pipelineContextMaxPaths: 4,
  });
  expect(full.pipelineContext?.mode).toBe("full");
  expect(full.pipelineContext?.maxFocusedDiffBytes).toBe(0);
  expect(full.pipelineContext?.projection?.maxPaths).toBe(4);
  expect(full.effectiveConfig?.pipelineContextMaxPaths?.source).toBe("cli");
  expect(() => resolvePipelineConfig({ ...base, pipelineContextMaxPaths: 0 })).toThrow(
    "positive safe integer",
  );
});

test("stage budgets have finite defaults, expose provenance, and are zero-disableable", () => {
  const base = {
    task: "x",
    targetDir: "/tmp",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  } as const;
  const defaults = resolvePipelineConfig(base);
  expect(defaults.stageLimits).toEqual({
    maxDurationMs: 600_000,
    maxModelTurns: 32,
    maxToolTurns: 128,
    maxInputTokens: 500_000,
    maxCostUsd: 2,
    finalResponseReserveModelTurns: 4,
    finalResponseReserveDurationMs: 30_000,
    finalResponseReserveToolTurns: 8,
    finalResponseReserveInputTokens: 100_000,
  });
  expect(defaults.effectiveConfig?.["stageLimits.maxDurationMs"]).toEqual({
    value: 600_000,
    source: "built-in-default",
  });
  const disabled = resolvePipelineConfig({
    ...base,
    stageLimits: {
      maxDurationMs: 0,
      maxModelTurns: 0,
      maxToolTurns: 0,
      maxInputTokens: 0,
      maxCostUsd: 0,
      finalResponseReserveModelTurns: 0,
      finalResponseReserveDurationMs: 0,
      finalResponseReserveToolTurns: 0,
      finalResponseReserveInputTokens: 0,
    },
  });
  expect(disabled.stageLimits).toEqual({
    maxDurationMs: 0,
    maxModelTurns: 0,
    maxToolTurns: 0,
    maxInputTokens: 0,
    maxCostUsd: 0,
    finalResponseReserveModelTurns: 0,
    finalResponseReserveDurationMs: 0,
    finalResponseReserveToolTurns: 0,
    finalResponseReserveInputTokens: 0,
  });
  expect(disabled.effectiveConfig?.["stageLimits.maxCostUsd"]?.source).toBe("cli");
});

test("role stage-budget overlays inherit global limits and preserve explicit zero", () => {
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp",
    registryConfig: mixedRegistry(),
    profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
    stageLimits: { maxToolTurns: 10 },
    roleStageLimits: { reviewer: { maxModelTurns: 3, maxToolTurns: 0 } },
  });
  expect(config.roleStageLimits?.reviewer).toMatchObject({
    maxModelTurns: 3,
    maxToolTurns: 0,
    maxDurationMs: 300_000,
  });
  expect(config.roleStageLimits?.planner?.maxToolTurns).toBe(10);
});

test("named inventory selects one atomic registry/profile pair and rejects source mixing", () => {
  const inventory: ModelInventoryConfig = {
    profiles: [
      {
        name: "primary",
        registry: mixedRegistry(),
        profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
      },
    ],
    default: "primary",
  };
  const config = resolvePipelineConfig({
    task: "x",
    targetDir: "/tmp",
    inventoryConfig: inventory,
    compactionMode: "disabled-then-halt",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  });
  expect(config.roles.planner?.model.id).toBe("large");
  expect(config.roles.coder.model.id).toBe("small");
  expect(config.effectiveConfig?.inventoryProfile).toEqual({
    value: "primary",
    source: "default",
  });
  expect(() =>
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp",
      inventoryConfig: inventory,
      registryConfig: mixedRegistry(),
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    }),
  ).toThrow("cannot be combined");
  expect(() =>
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp",
      inventoryConfig: inventory,
      coderModel: "large",
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    }),
  ).toThrow("cannot be combined");
  expect(() =>
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp",
      inventoryConfig: inventory,
      overrides: { coder: { model: "large" } },
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    }),
  ).toThrow("cannot be combined");
  expect(
    resolvePipelineConfig({
      task: "x",
      targetDir: "/tmp",
      inventoryConfig: inventory,
      compactionMode: "disabled-then-halt",
      pipelineContextMode: "full",
      stageLimits: { maxInputTokens: 123_456 },
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    }).stageLimits?.maxInputTokens,
  ).toBe(123_456);
});

test("matching project calibration overrides named inventory routing and can be disabled", () => {
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-project-routing-"));
  const inventory: ModelInventoryConfig = {
    profiles: [
      {
        name: "primary",
        registry: mixedRegistry(),
        profile: buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" }),
      },
    ],
    default: "primary",
  };
  try {
    const calibrated = buildDefaultProfile({ strong: "large", mid: "small", cheap: "small" });
    calibrated.entries = calibrated.entries.map((entry) =>
      entry.role === "coder" && entry.complexity === "medium"
        ? { ...entry, model: "large" }
        : entry,
    );
    writeProjectCalibrationSnapshot(targetDir, {
      version: 1,
      inventory: { name: "primary", providers: [{ id: "local", models: ["small", "large"] }] },
      routing: calibrated,
      observedOn: "2026-09-13",
      economics: [],
      subscriptionCapacityRanges: [],
    });
    const base = {
      task: "x",
      targetDir,
      inventoryConfig: inventory,
      compactionMode: "disabled-then-halt" as const,
      env: fakeEnv({ LOCAL_KEY: "k" }),
      warn: silent,
    };
    expect(resolvePipelineConfig(base).roles.coder.model.id).toBe("large");
    expect(
      resolvePipelineConfig({ ...base, useProjectCalibration: false }).roles.coder.model.id,
    ).toBe("small");
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});
