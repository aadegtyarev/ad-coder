import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigError } from "../src/config/errors";
import { defaultModelsPath, loadModelsConfig, saveModelsConfig } from "../src/config/store";
import { toRegistryAndProfile } from "../src/config/to-registry";
import { parseModelsConfig } from "../src/config/validate";

const SAMPLE = `providers:
  opencode-go:
    enabled: true          # switched off when the balance runs out
    models:
      glm-5.3-flash: {input: 0.15, output: 0.5}
      minimax-m3: {input: 0.3, output: 1.2}

default: daily

profiles:
  daily:
    coder: opencode-go:glm-5.3-flash      # measured best of four
    reviewer: opencode-go:minimax-m3
`;

function scratch(contents = SAMPLE): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-config-"));
  const file = path.join(dir, "models.yaml");
  fs.writeFileSync(file, contents);
  return file;
}

test("a machine edit leaves the operator's comments where they were", () => {
  // The whole reason the format is YAML: a row explains itself, and a comment
  // records why a cell is what it is (issue #280). A save that reserialised
  // would erase exactly what the format exists for, so this is the property the
  // store is built around rather than a nicety.
  const file = scratch();
  saveModelsConfig(file, (doc) => {
    doc.setIn(["providers", "opencode-go", "enabled"], false);
  });
  const after = fs.readFileSync(file, "utf8");
  expect(after).toContain("# switched off when the balance runs out");
  expect(after).toContain("# measured best of four");
  expect(after).toContain("enabled: false");
  // And the edit is readable back through the validator, not just present as text.
  expect(loadModelsConfig(file).providers["opencode-go"]?.enabled).toBe(false);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("saving replaces an existing document instead of failing as a false race", () => {
  // `link` cannot overwrite its target: it fails EEXIST, which for an update is
  // *always*, not a collision. The inventory store links because it only ever
  // creates; copying that shape here made every save report a concurrent writer
  // on a file the caller had just read.
  const file = scratch();
  saveModelsConfig(file, (doc) => doc.setIn(["default"], "daily"));
  expect(() => saveModelsConfig(file, (doc) => doc.setIn(["default"], "daily"))).not.toThrow();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("a bad edit is refused before anything reaches disk", () => {
  // Validate-then-write, not write-then-discover: a config that names a profile
  // nobody declared must never become the file the next run reads.
  const file = scratch();
  const before = fs.readFileSync(file, "utf8");
  expect(() => saveModelsConfig(file, (doc) => doc.setIn(["default"], "nonexistent"))).toThrow(
    ConfigError,
  );
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("the config path follows XDG, and falls back to ~/.config", () => {
  expect(defaultModelsPath("/home/x", "/custom")).toBe("/custom/ad-coder/models.yaml");

  // An empty value counts as unset, per the XDG spec. Without this,
  // `path.join("", "ad-coder")` yields a RELATIVE path resolving against
  // whatever the working directory happens to be -- worse than wrong, because it
  // silently reads and writes somewhere plausible.
  expect(defaultModelsPath("/home/x", "")).toBe("/home/x/.config/ad-coder/models.yaml");

  // The unset case must REMOVE the variable, not pass `undefined`: an explicit
  // `undefined` argument selects the parameter's default, which is
  // `process.env.XDG_CONFIG_HOME` -- so the assertion read the machine it ran
  // on. It passed here, where the variable is absent, and failed in CI, where it
  // is set, having never tested the fallback at all.
  const saved = process.env.XDG_CONFIG_HOME;
  // `delete`, not assignment: assigning `undefined` to a process env value
  // stores the STRING "undefined", which then resolves to `undefined/ad-coder`.
  delete process.env.XDG_CONFIG_HOME;
  try {
    expect(defaultModelsPath("/home/x")).toBe("/home/x/.config/ad-coder/models.yaml");
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
});

test("a role row naming an undeclared provider or model is refused", () => {
  // The join these files replace is what made a typo surface three layers down
  // as a lookup miss; refusing at the boundary is the point of the rewrite.
  expect(() =>
    parseModelsConfig({
      providers: { "opencode-go": { enabled: true, models: { "glm-5.3-flash": {} } } },
      profiles: { daily: { coder: "openrouter:whatever" } },
    }),
  ).toThrow(ConfigError);
  expect(() =>
    parseModelsConfig({
      providers: { "opencode-go": { enabled: true, models: { "glm-5.3-flash": {} } } },
      profiles: { daily: { coder: "opencode-go:not-a-model" } },
    }),
  ).toThrow(ConfigError);
});

test("a role row becomes one entry per tier, and a qualified row replaces its own", () => {
  // The format's core rule (#280): a bare row is every tier, `role@complexity`
  // REPLACES that tier rather than merging with it. Getting this backwards would
  // be invisible in the file and wrong at run time, which is the class of defect
  // the rewrite exists to remove.
  const config = parseModelsConfig({
    providers: {
      "opencode-go": {
        enabled: true,
        api: "openai-completions",
        baseUrl: "https://opencode.example.com",
        credential: "OPENCODE_API_KEY",
        models: {
          "glm-5.3-flash": { input: 0.15, output: 0.5 },
          "minimax-m3": { input: 0.3, output: 1.2 },
        },
      },
      openrouter: {
        enabled: false,
        models: { "deepseek/deepseek-v4.1": { input: 0.2, output: 0.6 } },
      },
    },
    default: "daily",
    profiles: {
      daily: {
        coder: "opencode-go:glm-5.3-flash",
        "coder@complex": ["opencode-go:minimax-m3", "openrouter:deepseek/deepseek-v4.1"],
      },
    },
  });
  const { registry, profile, name } = toRegistryAndProfile(config);
  expect(name).toBe("daily");
  // A disabled provider is absent from the registry entirely: `enabled: false`
  // is the operator's manual counterpart to the fallback ladder, so its models
  // must not be reachable at all.
  expect(registry.providers.map((p) => p.id)).toEqual(["opencode-go"]);
  const cells = Object.fromEntries(
    profile.entries.map((e) => [`${e.role}@${e.complexity}`, e.model]),
  );
  expect(cells["coder@trivial"]).toBe("glm-5.3-flash");
  expect(cells["coder@medium"]).toBe("glm-5.3-flash");
  // Replaced, not merged, and taken from the ladder's first rung.
  expect(cells["coder@complex"]).toBe("minimax-m3");
});

test("a profile that does not exist is refused by name", () => {
  const config = parseModelsConfig({
    providers: {
      "opencode-go": { enabled: true, models: { "glm-5.3-flash": { input: 0.15, output: 0.5 } } },
    },
    profiles: { daily: { coder: "opencode-go:glm-5.3-flash" } },
  });
  expect(() => toRegistryAndProfile(config, "nocturnal")).toThrow(ConfigError);
  // And a config with neither a named profile nor a default cannot silently pick one.
  expect(() => toRegistryAndProfile(config)).toThrow(ConfigError);
});
