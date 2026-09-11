import { expect, test } from "bun:test";
import { resolvePipelineConfig } from "../src/cli/resolve-config";
import { RegistryError } from "../src/registry/errors";

/** A fake env accessor over a plain record; nothing touches the real process.env. */
function fakeEnv(vars: Record<string, string>): (name: string) => string | undefined {
  return (name: string) => vars[name];
}

/** Swallow the resolver's stderr notices so tests stay quiet. */
const silent = () => {};

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
