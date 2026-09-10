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
};

test("defineRole returns a valid role unchanged", () => {
  expect(defineRole(valid)).toBe(valid);
  expect(defineRole({ ...valid, activeToolNames: [] }).activeToolNames).toEqual([]);
});

test("defineRole throws on each malformed field", () => {
  expect(() => defineRole({ ...valid, name: "   " })).toThrow(/name/);
  expect(() => defineRole({ ...valid, provider: "" })).toThrow(/provider/);
  expect(() => defineRole({ ...valid, modelId: "" })).toThrow(/modelId/);
  expect(() => defineRole({ ...valid, systemPrompt: "" })).toThrow(/systemPrompt/);
  expect(() => defineRole({ ...valid, activeToolNames: ["a", ""] })).toThrow(/empty entry/);
  expect(() => defineRole({ ...valid, activeToolNames: ["a", "a"] })).toThrow(/duplicate/);
  expect(() =>
    defineRole({ ...valid, cacheRetention: "forever" as Role["cacheRetention"] }),
  ).toThrow(/cacheRetention/);
  expect(() =>
    defineRole({ ...valid, activeToolNames: "read_file" as unknown as string[] }),
  ).toThrow(/must be an array/);
});

test("toHarnessOptions passes the system prompt through verbatim and disables compaction", () => {
  const { model, models } = resolveRoleModel(valid);
  const opts = toHarnessOptions(valid, { session: {} as Session, models, model });

  expect(opts.systemPrompt).toBe(valid.systemPrompt);
  expect(typeof opts.systemPrompt).toBe("string");
  expect(opts.compaction).toEqual({ enabled: false, reserveTokens: 0, keepRecentTokens: 0 });
  expect(opts.streamOptions?.cacheRetention).toBe(valid.cacheRetention);
  expect(opts.model).toBe(model);
  expect(opts.models).toBe(models);
});

test("an empty allow-list is emitted as an empty array, never omitted", () => {
  const denyAll = defineRole({ ...valid, activeToolNames: [] });
  const { model, models } = resolveRoleModel(denyAll);
  const opts = toHarnessOptions(denyAll, { session: {} as Session, models, model });

  // An absent activeToolNames means "every registered tool" in the harness, so
  // deny-all must survive the projection as a present empty array.
  expect("activeToolNames" in opts).toBe(true);
  expect(opts.activeToolNames).toEqual([]);
});

test("toHarnessOptions copies the allow-list rather than aliasing the role's array", () => {
  const role = defineRole({ ...valid, activeToolNames: ["read_file"] });
  const { model, models } = resolveRoleModel(role);
  const opts = toHarnessOptions(role, { session: {} as Session, models, model });

  opts.activeToolNames?.push("shell");
  expect(role.activeToolNames).toEqual(["read_file"]);
});

test("resolveRoleModel throws for a model that is not in the built-in catalog", () => {
  expect(() => resolveRoleModel({ ...valid, modelId: "no-such-model" })).toThrow(/no built-in model/);
  expect(() => resolveRoleModel({ ...valid, provider: "no-such-provider" })).toThrow(/no built-in model/);
});
