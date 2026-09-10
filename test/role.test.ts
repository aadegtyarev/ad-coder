import { expect, test } from "bun:test";
import type { Session } from "@earendil-works/pi-agent-core";
import { defineRole, resolveRoleModel, toHarnessOptions } from "../src/role";
import type { Role } from "../src/role";

const valid: Role = {
  name: "planner",
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
  systemPrompt: "You plan.",
  activeToolNames: ["read_file"],
  cacheRetention: "short",
  contextBudget: { maxTokens: 200_000, reserveTokens: 20_000, keepRecentTokens: 50_000 },
};

// Offline builtin-catalog resolution -- no network. Its 1,000,000-token window
// is the ceiling the over-window budget case is measured against.
const { model } = resolveRoleModel(valid);

test("defineRole returns a valid role unchanged", () => {
  expect(defineRole(valid, model)).toBe(valid);
  expect(defineRole({ ...valid, activeToolNames: [] }, model).activeToolNames).toEqual([]);
});

test("defineRole throws on each malformed field", () => {
  expect(() => defineRole({ ...valid, name: "   " }, model)).toThrow(/name/);
  expect(() => defineRole({ ...valid, provider: "" }, model)).toThrow(/provider/);
  expect(() => defineRole({ ...valid, modelId: "" }, model)).toThrow(/modelId/);
  expect(() => defineRole({ ...valid, systemPrompt: "" }, model)).toThrow(/systemPrompt/);
  expect(() => defineRole({ ...valid, activeToolNames: ["a", ""] }, model)).toThrow(/empty entry/);
  expect(() => defineRole({ ...valid, activeToolNames: ["a", "a"] }, model)).toThrow(/duplicate/);
  expect(() =>
    defineRole({ ...valid, cacheRetention: "forever" as Role["cacheRetention"] }, model),
  ).toThrow(/cacheRetention/);
  expect(() =>
    defineRole({ ...valid, activeToolNames: "read_file" as unknown as string[] }, model),
  ).toThrow(/must be an array/);
});

test("defineRole rejects a malformed or over-window context budget", () => {
  const withBudget = (budget: Role["contextBudget"]) => ({ ...valid, contextBudget: budget });

  expect(() =>
    defineRole(withBudget({ maxTokens: 1.5, reserveTokens: 20_000, keepRecentTokens: 50_000 }), model),
  ).toThrow(/maxTokens must be a positive integer/);
  expect(() =>
    defineRole(withBudget({ maxTokens: 0, reserveTokens: 20_000, keepRecentTokens: 50_000 }), model),
  ).toThrow(/maxTokens must be a positive integer/);
  expect(() =>
    defineRole(withBudget({ maxTokens: 200_000, reserveTokens: -1, keepRecentTokens: 50_000 }), model),
  ).toThrow(/reserveTokens must be a positive integer/);
  expect(() =>
    defineRole(withBudget({ maxTokens: 200_000, reserveTokens: 20_000, keepRecentTokens: 0 }), model),
  ).toThrow(/keepRecentTokens must be a positive integer/);

  // maxTokens over the model's window: the message names BOTH numbers.
  const overWindow = () =>
    defineRole(
      withBudget({ maxTokens: 2_000_000, reserveTokens: 20_000, keepRecentTokens: 50_000 }),
      model,
    );
  expect(overWindow).toThrow(/2000000/);
  expect(overWindow).toThrow(/1000000/);

  expect(() =>
    defineRole(
      withBudget({ maxTokens: 100_000, reserveTokens: 60_000, keepRecentTokens: 40_000 }),
      model,
    ),
  ).toThrow(/must be below maxTokens/);
});

test("toHarnessOptions passes the system prompt through verbatim and disables compaction", () => {
  const { model: runModel, models } = resolveRoleModel(valid);
  const opts = toHarnessOptions(valid, { session: {} as Session, models, model: runModel });

  expect(opts.systemPrompt).toBe(valid.systemPrompt);
  expect(typeof opts.systemPrompt).toBe("string");
  // The real budget numbers are NOT mirrored into Pi's CompactionSettings.
  expect(opts.compaction).toEqual({ enabled: false, reserveTokens: 0, keepRecentTokens: 0 });
  expect(opts.streamOptions?.cacheRetention).toBe(valid.cacheRetention);
  expect(opts.model).toBe(runModel);
  expect(opts.models).toBe(models);
});

test("an empty allow-list is emitted as an empty array, never omitted", () => {
  const denyAll = defineRole({ ...valid, activeToolNames: [] }, model);
  const { model: runModel, models } = resolveRoleModel(denyAll);
  const opts = toHarnessOptions(denyAll, { session: {} as Session, models, model: runModel });

  // An absent activeToolNames means "every registered tool" in the harness, so
  // deny-all must survive the projection as a present empty array.
  expect("activeToolNames" in opts).toBe(true);
  expect(opts.activeToolNames).toEqual([]);
});

test("toHarnessOptions copies the allow-list rather than aliasing the role's array", () => {
  const role = defineRole({ ...valid, activeToolNames: ["read_file"] }, model);
  const { model: runModel, models } = resolveRoleModel(role);
  const opts = toHarnessOptions(role, { session: {} as Session, models, model: runModel });

  opts.activeToolNames?.push("shell");
  expect(role.activeToolNames).toEqual(["read_file"]);
});

test("resolveRoleModel throws for a model that is not in the built-in catalog", () => {
  expect(() => resolveRoleModel({ ...valid, modelId: "no-such-model" })).toThrow(/no built-in model/);
  expect(() => resolveRoleModel({ ...valid, provider: "no-such-provider" })).toThrow(/no built-in model/);
});
