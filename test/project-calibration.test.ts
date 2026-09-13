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

const profile = {
  version: 1 as const,
  inventories: [{ name: "work", providers: [{ id: "codex", models: ["luna", "terra"] }] }],
  calibratedRouting: [
    {
      inventory: "work",
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
    const snapshot = createProjectCalibrationSnapshot(profile, "work");
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
test("project snapshot limits and missing calibrated inventories fail loudly", () => {
  expect(() => createProjectCalibrationSnapshot(profile, "missing")).toThrow(UserProfileError);
  expect(() =>
    createProjectCalibrationSnapshot(profile, "work", { maxEconomics: 0 }),
  ).not.toThrow();
  expect(() =>
    createProjectCalibrationSnapshot(profile, "work", { maxEconomics: 1 }),
  ).not.toThrow();
  expect(() => createProjectCalibrationSnapshot(profile, "work", { maxEconomics: -1 })).toThrow(
    UserProfileError,
  );
});

test("project snapshot refuses symlinked directories and destinations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-calibration-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-calibration-outside-"));
  try {
    fs.symlinkSync(outside, path.join(root, ".ad-coder"));
    expect(() =>
      writeProjectCalibrationSnapshot(root, createProjectCalibrationSnapshot(profile, "work")),
    ).toThrow(UserProfileError);
    expect(fs.existsSync(path.join(outside, "calibration.json"))).toBe(false);
    fs.unlinkSync(path.join(root, ".ad-coder"));
    fs.mkdirSync(path.join(root, ".ad-coder"));
    fs.symlinkSync(
      path.join(outside, "target.json"),
      path.join(root, ".ad-coder", "calibration.json"),
    );
    expect(() =>
      writeProjectCalibrationSnapshot(root, createProjectCalibrationSnapshot(profile, "work")),
    ).toThrow(UserProfileError);
    expect(fs.existsSync(path.join(outside, "target.json"))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
