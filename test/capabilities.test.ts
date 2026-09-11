import { expect, test } from "bun:test";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import {
  breakEvenReads,
  cacheEfficiency,
  deriveCapabilities,
  reconcileRoleWithModel,
} from "../src/capabilities/capabilities";
import type { Role } from "../src/role";

/** A base Model literal; each case spread-overrides only the fields it exercises. */
function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "base",
    name: "Base",
    api: "openai-completions",
    provider: "acme",
    baseUrl: "https://api.acme.example/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_000,
    ...overrides,
  };
}

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function role(overrides: Partial<Role> = {}): Role {
  return {
    name: "coder",
    provider: "acme",
    modelId: "base",
    systemPrompt: "x",
    activeToolNames: [],
    cacheRetention: "short",
    contextBudget: { maxTokens: 1000, reserveTokens: 100, keepRecentTokens: 100 },
    ...overrides,
  };
}

test("costMode: per-token when any cost field is nonzero", () => {
  const caps = deriveCapabilities(
    model({ cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 12.5 } }),
  );
  expect(caps.costMode).toBe("per-token");
});

test("costMode: local via loopback baseUrl with all-zero cost", () => {
  const caps = deriveCapabilities(model({ baseUrl: "http://localhost:1234/v1" }));
  expect(caps.costMode).toBe("local");
});

test("costMode: local via IPv6 loopback in bracket form", () => {
  // URL.hostname returns "[::1]" bracketed; the bare "::1" in LOOPBACK_HOSTS
  // never matches it, so a local IPv6 endpoint must be de-bracketed first.
  expect(deriveCapabilities(model({ baseUrl: "http://[::1]:11434/v1" })).costMode).toBe("local");
});

test("costMode: local via private 172.16-31 range", () => {
  expect(deriveCapabilities(model({ baseUrl: "http://172.20.0.5:8000/v1" })).costMode).toBe(
    "local",
  );
  // Outside 16-31 is NOT private and stays prepaid.
  expect(deriveCapabilities(model({ baseUrl: "http://172.40.0.5:8000/v1" })).costMode).toBe(
    "prepaid",
  );
});

test("costMode: local via provider name match", () => {
  const caps = deriveCapabilities(
    model({ provider: "lmstudio", baseUrl: "https://api.acme.example/v1" }),
  );
  expect(caps.costMode).toBe("local");
});

test("costMode: prepaid when all-zero cost and a non-local public baseUrl", () => {
  const caps = deriveCapabilities(
    model({ baseUrl: "https://dashscope.aliyuncs.com/v1", provider: "qwen" }),
  );
  expect(caps.costMode).toBe("prepaid");
});

test("costMode: unparseable baseUrl falls through to prepaid, not local, and does not throw", () => {
  const caps = deriveCapabilities(model({ baseUrl: "not a url" }));
  expect(caps.costMode).toBe("prepaid");
});

test("cacheControllable: true for anthropic-messages with no compat", () => {
  const caps = deriveCapabilities(model({ id: "claude-fable-5", api: "anthropic-messages" }));
  expect(caps.cacheControllable).toBe(true);
});

test("cacheControllable: true for openai-completions with compat.cacheControlFormat anthropic", () => {
  const caps = deriveCapabilities(
    model({ api: "openai-completions", compat: { cacheControlFormat: "anthropic" } }),
  );
  expect(caps.cacheControllable).toBe(true);
});

test("cacheControllable: false for openai-completions with no format (deepseek-like)", () => {
  const caps = deriveCapabilities(model({ id: "deepseek-v4-flash", api: "openai-completions" }));
  expect(caps.cacheControllable).toBe(false);
});

test("descriptor: outInRatio and unit costs", () => {
  const caps = deriveCapabilities(
    model({ cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 12.5 } }),
  );
  expect(caps.outInRatio).toBe(3);
  expect(caps.cacheReadUnitCost).toBe(1);
  expect(caps.cacheWriteUnitCost).toBe(12.5);
  // input 0 guards the ratio against divide-by-zero.
  expect(deriveCapabilities(model()).outInRatio).toBe(0);
});

test("cacheEfficiency: normal ratio", () => {
  expect(cacheEfficiency(usage({ cacheRead: 900, input: 100 }))).toBeCloseTo(0.9, 5);
});

test("cacheEfficiency: both-zero guard returns 0", () => {
  expect(cacheEfficiency(usage())).toBe(0);
});

test("breakEvenReads: fable-5 case is ~1.4", () => {
  const result = breakEvenReads(
    model({ cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 12.5 } }),
  );
  expect(result).toBeCloseTo(1.4, 1);
});

test("breakEvenReads: 'always' when cacheWrite is 0", () => {
  expect(
    breakEvenReads(model({ cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 0 } })),
  ).toBe("always");
});

test("breakEvenReads: 'degenerate' when input <= cacheRead", () => {
  expect(
    breakEvenReads(model({ cost: { input: 1, output: 30, cacheRead: 1, cacheWrite: 5 } })),
  ).toBe("degenerate");
});

test("reconcileRoleWithModel: warns for cacheRetention on a non-controllable model", () => {
  const warnings = reconcileRoleWithModel(
    role({ name: "coder", cacheRetention: "long" }),
    model({ id: "deepseek-v4-flash", api: "openai-completions" }),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]?.code).toBe("inert-cache-retention");
  expect(warnings[0]?.role).toBe("coder");
  expect(warnings[0]?.modelId).toBe("deepseek-v4-flash");
});

test("reconcileRoleWithModel: empty for cacheRetention none", () => {
  const warnings = reconcileRoleWithModel(
    role({ cacheRetention: "none" }),
    model({ api: "openai-completions" }),
  );
  expect(warnings).toEqual([]);
});

test("reconcileRoleWithModel: empty for a controllable model even when cacheRetention is set", () => {
  const warnings = reconcileRoleWithModel(
    role({ cacheRetention: "long" }),
    model({ api: "anthropic-messages" }),
  );
  expect(warnings).toEqual([]);
});
