import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePipelineConfig } from "../src/cli/resolve-config";
import { deriveContextBudget } from "../src/context/budget";
import { buildDefaultProfile } from "../src/profiles/default-profile";
import { resolveProfile } from "../src/profiles/resolve";
import { RegistryError } from "../src/registry/errors";
import type { RegistryConfig } from "../src/registry/types";

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
    securityModel: "large",
    coderModel: "small",
    reviewerModel: "large",
    orchestratorModel: "small",
    summarizerModel: "large",
    env: fakeEnv({ LOCAL_KEY: "k" }),
    warn: silent,
  });
  expect(config.roles.planner?.model.contextWindow).toBe(32000);
  expect(config.roles.security?.model.contextWindow).toBe(200000);
  expect(config.roles.coder.role.contextBudget.maxTokens).toBe(28800);
  expect(config.roles.reviewer.role.contextBudget.maxTokens).toBe(180000);
  expect(config.roles.orchestrator?.model.contextWindow).toBe(32000);
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
    for (const role of ["planner", "security", "coder", "reviewer"] as const) {
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
  expect(config.maxRounds).toBe(3);
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
  expect(config.routing?.registry.getModel("codex-gpt-5.5")).toBeDefined();
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
