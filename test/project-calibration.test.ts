import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createProjectCalibrationSnapshot,
  ProjectStore,
  readProjectCalibrationSnapshot,
  UserProfileError,
  writeProjectCalibrationSnapshot,
} from "../src";
import { parseProjectCalibrationSnapshot, snapshotSource } from "../src/project-calibration";

/** The models.yaml profile a snapshot under test is calibrated against, with
 * the (provider, model) pairs that profile serves -- the config layer derives
 * these from its own walk over models.yaml and hands them to the snapshot. */
const workSource = {
  kind: "models-profile" as const,
  name: "work",
  providers: [{ id: "codex", models: ["luna", "terra"] }],
  // No declared facts: this source models a `models.yaml` whose rows state no
  // prices at all, which is the case every existing expectation was written
  // against -- economics then come from the profile's own records alone.
  facts: [],
};

const profile = {
  version: 1 as const,
  inventories: [],
  calibratedRouting: [
    {
      modelsProfile: "work",
      profile: {
        entries: [{ role: "coder" as const, complexity: "trivial" as const, model: "luna" }],
      },
      observedOn: "2026-09-13",
      source: "benchmark",
      confidence: "measured" as const,
    },
  ],
  economicRecords: [
    {
      id: "old",
      observedAt: "2026-09-12T00:00:00.000Z",
      provider: "codex",
      model: "luna",
      kind: "price" as const,
      value: 2,
      unit: "credits",
      source: "provider-measurement",
      confidence: "measured" as const,
    },
    {
      id: "new",
      observedAt: "2026-09-13T00:00:00.000Z",
      provider: "codex",
      model: "luna",
      kind: "price" as const,
      value: 1,
      unit: "credits",
      source: "provider-measurement",
      confidence: "measured" as const,
      previousId: "old",
    },
  ],
  subscriptionCapacityRanges: [],
};
test("project snapshot keeps only current anonymous calibration and round-trips", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-calibration-"));
  try {
    const snapshot = createProjectCalibrationSnapshot(profile, workSource);
    expect(snapshot.economics).toEqual([
      expect.objectContaining({ value: 1, observedOn: "2026-09-13" }),
    ]);
    expect(snapshot.economics[0]).not.toHaveProperty("id");
    expect(snapshot.economics[0]).not.toHaveProperty("observedAt");
    expect(writeProjectCalibrationSnapshot(root, snapshot)).toBe(
      path.join(root, ".ad-coder", "calibration.json"),
    );
    expect(readProjectCalibrationSnapshot(root)).toEqual(snapshot);
    const store = new ProjectStore(root);
    expect(fs.readFileSync(store.layout.gitignore, "utf8")).toContain("!calibration.json");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("project snapshot limits and a missing calibrated source fail loudly", () => {
  expect(() =>
    createProjectCalibrationSnapshot(profile, { ...workSource, name: "missing" }),
  ).toThrow(UserProfileError);
  expect(() =>
    createProjectCalibrationSnapshot(profile, workSource, { maxEconomics: 0 }),
  ).not.toThrow();
  expect(() =>
    createProjectCalibrationSnapshot(profile, workSource, { maxEconomics: 1 }),
  ).not.toThrow();
  expect(() => createProjectCalibrationSnapshot(profile, workSource, { maxEconomics: -1 })).toThrow(
    UserProfileError,
  );
});

test("a snapshot calibrated against a models.yaml profile names it, in its own namespace", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-calibration-models-"));
  try {
    const routing = {
      entries: [{ role: "coder" as const, complexity: "trivial" as const, model: "gpt-5.6-luna" }],
    };
    const modelsProfile = {
      version: 1 as const,
      inventories: [],
      calibratedRouting: [
        {
          modelsProfile: "codex-pro100",
          profile: routing,
          observedOn: "2026-09-20",
          source: "benchmark",
          confidence: "measured" as const,
        },
      ],
      economicRecords: [
        {
          id: "luna-price",
          observedAt: "2026-09-20T00:00:00.000Z",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          kind: "price" as const,
          value: 0.2,
          unit: "USD/1M tokens",
          source: "provider-measurement",
          confidence: "measured" as const,
        },
        {
          id: "outside-price",
          observedAt: "2026-09-20T00:00:00.000Z",
          provider: "openai-codex",
          model: "gpt-5.6-terra",
          kind: "price" as const,
          value: 2,
          unit: "USD/1M tokens",
          source: "provider-measurement",
          confidence: "measured" as const,
        },
      ],
      subscriptionCapacityRanges: [],
    };
    // The pairs come from the config layer's own walk over `models.yaml`; here
    // they name one of the two models, so the economics must be scoped to it.
    const source = {
      kind: "models-profile" as const,
      name: "codex-pro100",
      providers: [{ id: "openai-codex", models: ["gpt-5.6-luna"] }],
      facts: [],
    };
    const snapshot = createProjectCalibrationSnapshot(modelsProfile, source);
    // The source is named in ITS OWN namespace: a models.yaml profile is never
    // written down as an inventory block it is not.
    expect(snapshot).toMatchObject({ modelsProfile: "codex-pro100" });
    expect(snapshot).not.toHaveProperty("inventory");
    expect(snapshotSource(snapshot)).toEqual({ kind: "models-profile", name: "codex-pro100" });
    expect(snapshot.economics.map((entry) => entry.model)).toEqual(["gpt-5.6-luna"]);
    expect(writeProjectCalibrationSnapshot(root, snapshot)).toBe(
      path.join(root, ".ad-coder", "calibration.json"),
    );
    // Round-trip: the committed file reads back as the same models-profile arm.
    expect(readProjectCalibrationSnapshot(root)).toEqual(snapshot);

    // A cell the profile cannot serve is refused BY NAME, not shipped.
    expect(() =>
      createProjectCalibrationSnapshot(
        {
          ...modelsProfile,
          calibratedRouting: [
            {
              ...modelsProfile.calibratedRouting[0]!,
              profile: {
                entries: [{ role: "coder", complexity: "trivial", model: "gpt-5.6-sol" }],
              },
            },
          ],
        },
        source,
      ),
    ).toThrow(/gpt-5.6-sol/);
    // A profile the document does not calibrate is not found: the name is part
    // of the lookup, and a name the document never calibrated has no routing to
    // build a snapshot from.
    expect(() =>
      createProjectCalibrationSnapshot(modelsProfile, {
        kind: "models-profile",
        name: "other",
        providers: [],
        facts: [],
      }),
    ).toThrow(UserProfileError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project snapshot refuses symlinked directories and destinations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-calibration-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-calibration-outside-"));
  try {
    fs.symlinkSync(outside, path.join(root, ".ad-coder"));
    expect(() =>
      writeProjectCalibrationSnapshot(root, createProjectCalibrationSnapshot(profile, workSource)),
    ).toThrow(UserProfileError);
    expect(fs.existsSync(path.join(outside, "calibration.json"))).toBe(false);
    fs.unlinkSync(path.join(root, ".ad-coder"));
    fs.mkdirSync(path.join(root, ".ad-coder"));
    fs.symlinkSync(
      path.join(outside, "target.json"),
      path.join(root, ".ad-coder", "calibration.json"),
    );
    expect(() =>
      writeProjectCalibrationSnapshot(root, createProjectCalibrationSnapshot(profile, workSource)),
    ).toThrow(UserProfileError);
    expect(fs.existsSync(path.join(outside, "target.json"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("project snapshot refuses a symlinked target directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-calibration-target-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-calibration-target-outside-"));
  const linkedTarget = path.join(root, "target");
  try {
    fs.symlinkSync(outside, linkedTarget);
    expect(() =>
      writeProjectCalibrationSnapshot(
        linkedTarget,
        createProjectCalibrationSnapshot(profile, workSource),
      ),
    ).toThrow(UserProfileError);
    expect(fs.existsSync(path.join(outside, ".ad-coder", "calibration.json"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a committed models-profile snapshot parses from the fixture this test writes", () => {
  // The repository's own `.ad-coder/calibration.json` is gone (issue #513 took
  // the routed JSON inventory with it, and the committed snapshot named that
  // arm). What it existed to catch survives: a snapshot is data a repository
  // carries, and a shape the parser rejects breaks every command that loads a
  // user profile. So the fixture below is written out the way a committed one
  // would be -- the exact field set, as JSON -- and parsed from there.
  const fixture = JSON.stringify({
    version: 1,
    modelsProfile: "work",
    routing: {
      entries: [{ role: "coder", complexity: "trivial", model: "luna" }],
    },
    observedOn: "2026-09-13",
    economics: [
      {
        provider: "codex",
        model: "luna",
        kind: "price",
        value: 1,
        unit: "credits",
        observedOn: "2026-09-13",
        source: "provider-measurement",
        confidence: "measured",
      },
    ],
    subscriptionCapacityRanges: [],
  });
  const parsed = parseProjectCalibrationSnapshot(JSON.parse(fixture));
  expect(parsed.modelsProfile).toBe("work");
  expect(snapshotSource(parsed)).toEqual({ kind: "models-profile", name: "work" });
});

test("a snapshot naming a JSON inventory is refused by name, with the command that re-takes it", () => {
  // This repository's own committed snapshot carried this arm (issue #513), so
  // it is the exact file a checkout upgrading across the retirement still has
  // on disk. The refusal has to name the source it FOUND and the command that
  // replaces it: the anonymous shape error it would otherwise fall into
  // ("must be one of ...", naming fields) tells the operator which keys are
  // legal and nothing about how to get back to a working snapshot.
  const legacy = {
    version: 1,
    inventory: { name: "work", providers: [{ id: "codex", models: ["luna"] }] },
    routing: { entries: [{ role: "coder", complexity: "trivial", model: "luna" }] },
    observedOn: "2026-09-13",
  };
  let thrown: unknown;
  try {
    parseProjectCalibrationSnapshot(legacy);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UserProfileError);
  const refusal = thrown as UserProfileError;
  expect(refusal.code).toBe("invalid_profile");
  expect(refusal.detail).toBe("inventory");
  // The source it found, by name...
  expect(refusal.message).toContain('"work"');
  // ...the namespace that replaces it...
  expect(refusal.message).toContain("models.yaml");
  // ...and the command that re-takes the snapshot, which is the whole point:
  // an operator who is told only that the arm is gone has no way back.
  expect(refusal.message).toContain("--models-profile");
  // The shape error this arm exists to preempt, asserted as its absence: the
  // legacy file is missing `modelsProfile`, so without the check above it would
  // fail the exact-field-set comparison instead and never mention any of this.
  expect(refusal.message).not.toContain("fields are invalid");
  expect(refusal.detail).not.toBe("snapshot");
});

test("a snapshot fills economics from the declared facts its source carries (#540)", () => {
  const source = {
    kind: "models-profile" as const,
    name: "codex-pro100",
    providers: [{ id: "openai-codex", models: ["gpt-5.6-luna", "gpt-5.6-terra"] }],
    facts: [
      {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        input: 0.2,
        output: 1.2,
        cacheRead: 0.02,
        contextWindow: 200000,
      },
      // No cacheRead/cacheWrite/contextWindow: this row declares none, and a
      // snapshot states what the file says rather than settling them to zero.
      { provider: "openai-codex", model: "gpt-5.6-terra", input: 2, output: 12 },
      // Out of scope: the walk does not reach it, so it is not written.
      { provider: "openai-codex", model: "ghost", input: 9, output: 9 },
    ],
  };
  const document = {
    version: 1 as const,
    inventories: [],
    calibratedRouting: [
      {
        modelsProfile: "codex-pro100",
        profile: {
          entries: [
            { role: "coder" as const, complexity: "trivial" as const, model: "gpt-5.6-luna" },
            { role: "coder" as const, complexity: "medium" as const, model: "gpt-5.6-terra" },
          ],
        },
        observedOn: "2026-09-21",
        source: "benchmark",
        confidence: "measured" as const,
      },
    ],
    // The operator answered exactly ONE scope by hand.
    economicRecords: [
      {
        id: "luna-input-observed",
        observedAt: "2026-09-20T00:00:00.000Z",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        kind: "price" as const,
        value: 0.25,
        unit: "usd_per_million_input",
        source: "provider-measurement",
        confidence: "measured" as const,
      },
    ],
    subscriptionCapacityRanges: [],
  };
  const snapshot = createProjectCalibrationSnapshot(document, source);
  const at = (model: string, unit: string) =>
    snapshot.economics.find((entry) => entry.model === model && entry.unit === unit);

  // The answered scope keeps THEIR number, provenance and all...
  expect(at("gpt-5.6-luna", "usd_per_million_input")).toMatchObject({
    value: 0.25,
    source: "provider-measurement",
    confidence: "measured",
    observedOn: "2026-09-20",
  });
  // ...and the rest of that model is filled from the file, dated by the
  // calibration's own observation day and labelled as what it is.
  expect(at("gpt-5.6-luna", "usd_per_million_output")).toMatchObject({
    kind: "price",
    value: 1.2,
    source: "project-calibration",
    confidence: "estimated",
    observedOn: "2026-09-21",
  });
  expect(at("gpt-5.6-luna", "usd_per_million_cached_input")).toMatchObject({ value: 0.02 });
  expect(at("gpt-5.6-luna", "tokens")).toMatchObject({
    kind: "context_limit",
    value: 200000,
  });
  // The second model is filled too, and its undeclared facts stay absent.
  expect(at("gpt-5.6-terra", "usd_per_million_input")).toMatchObject({ value: 2 });
  expect(at("gpt-5.6-terra", "usd_per_million_output")).toMatchObject({ value: 12 });
  expect(at("gpt-5.6-luna", "usd_per_million_cache_write")).toBeUndefined();
  expect(at("gpt-5.6-terra", "usd_per_million_cache_write")).toBeUndefined();
  expect(at("gpt-5.6-terra", "tokens")).toBeUndefined();
  // A fact for a model outside the walk's scope is not written, whatever it says.
  expect(snapshot.economics.some((entry) => entry.model === "ghost")).toBe(false);

  // The filled records survive the parser a committed snapshot goes through:
  // building the snapshot already re-parsed them, and the round-trip is equal.
  expect(parseProjectCalibrationSnapshot(snapshot)).toEqual(snapshot);
});

test("a profile with no records at all still yields a snapshot with declared economics (#540)", () => {
  const source = {
    kind: "models-profile" as const,
    name: "work",
    providers: [{ id: "codex", models: ["luna"] }],
    facts: [{ provider: "codex", model: "luna", input: 1, output: 4, contextWindow: 100000 }],
  };
  const empty = {
    version: 1 as const,
    inventories: [],
    calibratedRouting: [
      {
        modelsProfile: "work",
        profile: {
          entries: [{ role: "coder" as const, complexity: "trivial" as const, model: "luna" }],
        },
        observedOn: "2026-09-21",
        source: "benchmark",
        confidence: "measured" as const,
      },
    ],
    economicRecords: [],
    subscriptionCapacityRanges: [],
  };
  const snapshot = createProjectCalibrationSnapshot(empty, source);
  expect(snapshot.economics.map((entry) => entry.unit).sort()).toEqual([
    "tokens",
    "usd_per_million_input",
    "usd_per_million_output",
  ]);
});
