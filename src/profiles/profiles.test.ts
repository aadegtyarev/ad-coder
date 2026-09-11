import { expect, test } from "bun:test";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { RegistryError } from "../registry/errors";
import type { ResolvedRegistry } from "../registry/types";
import { buildDefaultProfile } from "./default-profile";
import { ProfileError } from "./errors";
import { resolveProfile } from "./resolve";
import type { Profile } from "./types";
import { parseProfile } from "./validate";

/**
 * A network-free, key-free `ResolvedRegistry` stub. `getModel` returns a marker
 * object carrying the requested NAME as its `id` (enough to assert which model a
 * resolution picked) and throws `RegistryError('unknown_model', name)` for any
 * name not in `known` exactly as the real resolver does so the profile layer's
 * catch/rethrow is exercised against the genuine error class.
 */
function stubRegistry(known: readonly string[]): ResolvedRegistry {
  const getModel = (name: string): Model<Api> => {
    if (!known.includes(name)) {
      throw new RegistryError("unknown_model", name, `no model named "${name}" is registered`);
    }
    return { id: name } as unknown as Model<Api>;
  };
  return {
    models: {} as unknown as Models,
    getModel,
    lookup: (name: string) => ({ models: {} as unknown as Models, model: getModel(name) }),
  };
}

const wellFormed: Profile = {
  entries: [
    { role: "coder", complexity: "complex", model: "big" },
    {
      role: "coder",
      complexity: "trivial",
      model: "small",
      maxOutput: 1024,
      cacheRetention: "short",
    },
    { role: "reviewer", complexity: "medium", model: "mid" },
  ],
};

test("parseProfile accepts a well-formed profile and returns it", () => {
  const parsed = parseProfile(wellFormed);
  expect(parsed.entries).toHaveLength(3);
  expect(parsed.entries[0]).toEqual({ role: "coder", complexity: "complex", model: "big" });
  expect(parsed.entries[1]).toEqual({
    role: "coder",
    complexity: "trivial",
    model: "small",
    maxOutput: 1024,
    cacheRetention: "short",
  });
});

test("parseProfile rejects a non-object", () => {
  try {
    parseProfile(null);
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("invalid_config");
    expect((err as ProfileError).detail).toBe("profile");
  }
});

test("parseProfile rejects an empty entries array", () => {
  try {
    parseProfile({ entries: [] });
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("invalid_config");
    expect((err as ProfileError).detail).toBe("entries");
  }
});

test("parseProfile rejects a duplicate (role, complexity) with a names-only key detail", () => {
  const dup: unknown = {
    entries: [
      { role: "coder", complexity: "complex", model: "a" },
      { role: "coder", complexity: "complex", model: "b" },
    ],
  };
  try {
    parseProfile(dup);
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("duplicate_entry");
    expect((err as ProfileError).detail).toBe("coder:complex");
  }
});

test("parseProfile rejects an unknown role with a names-only detail", () => {
  const bad: unknown = { entries: [{ role: "wizard", complexity: "complex", model: "a" }] };
  try {
    parseProfile(bad);
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("unknown_role");
    expect((err as ProfileError).detail).toBe("wizard");
  }
});

test("parseProfile rejects a bad complexity", () => {
  const bad: unknown = { entries: [{ role: "coder", complexity: "epic", model: "a" }] };
  try {
    parseProfile(bad);
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("invalid_complexity");
    expect((err as ProfileError).detail).toBe("epic");
  }
});

test("parseProfile rejects a missing model field with a names-only detail", () => {
  const bad: unknown = { entries: [{ role: "coder", complexity: "complex" }] };
  try {
    parseProfile(bad);
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("invalid_config");
    expect((err as ProfileError).detail).toBe("coder:complex.model");
  }
});

test("parseProfile rejects a non-positive maxOutput", () => {
  const bad: unknown = {
    entries: [{ role: "coder", complexity: "complex", model: "a", maxOutput: 0 }],
  };
  try {
    parseProfile(bad);
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("invalid_config");
    expect((err as ProfileError).detail).toBe("coder:complex.maxOutput");
  }
});

test("parseProfile rejects an invalid cacheRetention", () => {
  const bad: unknown = {
    entries: [{ role: "coder", complexity: "complex", model: "a", cacheRetention: "forever" }],
  };
  try {
    parseProfile(bad);
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("invalid_config");
    expect((err as ProfileError).detail).toBe("coder:complex.cacheRetention");
  }
});

test("resolveProfile picks the entry model for a (role, complexity)", () => {
  const registry = stubRegistry(["big", "small", "mid"]);
  const selection = resolveProfile(wellFormed, registry, "coder", "complex");
  expect(selection.model.id).toBe("big");
  expect(selection.maxOutput).toBeUndefined();
});

test("resolveProfile surfaces the advisory maxOutput/cacheRetention from the entry", () => {
  const registry = stubRegistry(["big", "small", "mid"]);
  const selection = resolveProfile(wellFormed, registry, "coder", "trivial");
  expect(selection.model.id).toBe("small");
  expect(selection.maxOutput).toBe(1024);
  expect(selection.cacheRetention).toBe("short");
});

test("resolveProfile lets a SpawnOverride model win over the (role, complexity) cell", () => {
  const registry = stubRegistry(["big", "small", "mid", "pinned"]);
  const selection = resolveProfile(wellFormed, registry, "coder", "complex", {
    model: "pinned",
    maxOutput: 42,
  });
  expect(selection.model.id).toBe("pinned");
  expect(selection.maxOutput).toBe(42);
});

test("resolveProfile rethrows an unknown model as ProfileError('unknown_model'), never a RegistryError", () => {
  const registry = stubRegistry(["mid"]);
  try {
    resolveProfile(wellFormed, registry, "coder", "complex");
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect(err).not.toBeInstanceOf(RegistryError);
    expect((err as ProfileError).code).toBe("unknown_model");
    expect((err as ProfileError).detail).toBe("big");
  }
});

test("resolveProfile throws missing_mapping for a (role, complexity) with no entry", () => {
  const registry = stubRegistry(["big", "small", "mid"]);
  try {
    resolveProfile(wellFormed, registry, "security", "complex");
    throw new Error("expected throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).code).toBe("missing_mapping");
    expect((err as ProfileError).detail).toBe("security:complex");
  }
});

test("buildDefaultProfile routes each role and coder scales with complexity", () => {
  const profile = buildDefaultProfile({ strong: "S", mid: "M", cheap: "C" });
  // 5 roles x 3 complexities.
  expect(profile.entries).toHaveLength(15);
  // parseProfile must accept the builder output unchanged (self-consistent, no dupes).
  expect(parseProfile(profile).entries).toHaveLength(15);

  const registry = stubRegistry(["S", "M", "C"]);
  expect(resolveProfile(profile, registry, "coder", "complex").model.id).toBe("S");
  expect(resolveProfile(profile, registry, "coder", "medium").model.id).toBe("M");
  expect(resolveProfile(profile, registry, "coder", "trivial").model.id).toBe("C");
  expect(resolveProfile(profile, registry, "planner", "trivial").model.id).toBe("S");
  expect(resolveProfile(profile, registry, "security", "complex").model.id).toBe("S");
  expect(resolveProfile(profile, registry, "reviewer", "medium").model.id).toBe("M");
  expect(resolveProfile(profile, registry, "recorder", "complex").model.id).toBe("C");
});
