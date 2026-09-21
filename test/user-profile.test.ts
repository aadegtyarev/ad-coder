import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CalibratedRouting, UserProfile } from "ad-coder";
import {
  exportUserProfile,
  FileUserProfileStore,
  parseUserProfileJson,
  previewUserProfileImport,
  UserProfileError,
} from "ad-coder";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const base = (): UserProfile => ({
  version: 1,
  calibratedRouting: [],
  economicRecords: [],
  subscriptionCapacityRanges: [],
});
const record = {
  id: "price-1",
  observedAt: "2026-09-13T00:00:00.000Z",
  provider: "openai",
  model: "gpt",
  kind: "price" as const,
  value: 2.5,
  unit: "USD/1M tokens",
  source: "https://example.test/pricing",
  confidence: "official" as const,
};
const cell = (modelsProfile = "daily"): CalibratedRouting => ({
  modelsProfile,
  profile: { entries: [{ role: "coder", complexity: "medium", model: "gpt" }] },
  observedOn: "2026-09-20",
  source: "benchmark",
  confidence: "measured" as const,
});
function store(Store: typeof FileUserProfileStore = FileUserProfileStore) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-profile-"));
  roots.push(root);
  const file = path.join(root, "private", "profile.json");
  return { file, store: new Store({ userHome: root, configPath: file }) };
}

test("validates the complete inventory-free version-one schema", () => {
  const expected = { ...base(), economicRecords: [record] };
  expect(parseUserProfileJson(exportUserProfile(expected))).toEqual(expected);
  for (const invalid of [
    "{",
    JSON.stringify({ economicRecords: [] }),
    JSON.stringify({ ...base(), version: 2 }),
    JSON.stringify({ ...base(), economicRecords: [{ ...record, value: "2.5" }] }),
    JSON.stringify({ ...base(), economicRecords: [{ ...record, value: -1 }] }),
    JSON.stringify({ ...base(), economicRecords: [{ ...record, observedAt: "2026-09-13" }] }),
    JSON.stringify({ ...base(), calibratedRouting: [{ ...cell(), modelsProfile: "" }] }),
    JSON.stringify({ ...base(), calibratedRouting: [{ ...cell(), profile: { entries: "bad" } }] }),
    JSON.stringify({ ...base(), subscriptionCapacityRanges: [{ provider: "p" }] }),
    JSON.stringify({ ...base(), extra: true }),
  ])
    expect(() => parseUserProfileJson(invalid)).toThrow(UserProfileError);
});

test("accepts and drops legacy empty inventories, and writers never emit it", () => {
  const parsed = parseUserProfileJson(JSON.stringify({ ...base(), inventories: [] }));
  expect(parsed).not.toHaveProperty("inventories");
  expect(exportUserProfile(parsed)).not.toContain("inventories");
  expect(parseUserProfileJson(JSON.stringify(base()))).toEqual(base());
});

test("reports unrelated malformed fields without the inventory remedy", () => {
  for (const [field, value] of [
    ["subscriptionCapacityRanges", "bad"],
    ["economicRecords", "bad"],
  ] as const) {
    expect(() => parseUserProfileJson(JSON.stringify({ ...base(), [field]: value }))).toThrow(
      new UserProfileError(
        "invalid_profile",
        `profile.${field} must be an array`,
        `invalid user profile: profile.${field} must be an array`,
      ),
    );
    try {
      parseUserProfileJson(JSON.stringify({ ...base(), [field]: value }));
    } catch (error) {
      expect((error as Error).message).not.toContain("inventories");
      expect((error as Error).message).not.toContain("models.yaml");
    }
  }
});

test("rejects obsolete inventories and calibratedRouting.inventory with typed remedies", () => {
  for (const value of [{ name: "x" }, "bad"]) {
    try {
      parseUserProfileJson(JSON.stringify({ ...base(), inventories: value }));
    } catch (error) {
      expect((error as UserProfileError).code).toBe("invalid_profile");
      expect((error as Error).message).toContain("models.yaml");
    }
  }
  expect(() =>
    parseUserProfileJson(JSON.stringify({ ...base(), inventories: [{ name: "x" }] })),
  ).toThrow(UserProfileError);
  try {
    parseUserProfileJson(
      JSON.stringify({ ...base(), calibratedRouting: [{ ...cell(), inventory: "old" }] }),
    );
  } catch (error) {
    expect((error as UserProfileError).detail).toContain("calibratedRouting.inventory");
    expect((error as Error).message).toContain("models.yaml");
  }
});

test("appends economic history and rejects every history rewrite", async () => {
  const { store: profileStore } = store();
  await profileStore.write({ ...base(), economicRecords: [record] });
  const second = { ...record, id: "price-2", value: 3, previousId: record.id };
  await profileStore.appendEconomicRecord(second);
  expect((await profileStore.read()).economicRecords).toEqual([record, second]);
  await expect(
    profileStore.appendEconomicRecord({ ...second, id: "bad", value: Number.NaN }),
  ).rejects.toMatchObject({ code: "invalid_profile" });
  await expect(
    profileStore.write({ ...base(), economicRecords: [{ ...record, id: "price-2", value: 3 }] }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await profileStore.read()).economicRecords).toEqual([record, second]);
});

test("accepts append-only credit balance observations", () => {
  const first = {
    ...record,
    id: "credit-1",
    kind: "credit_balance" as const,
    value: 500,
    unit: "credits",
    source: "provider-measurement",
    confidence: "provider_reported" as const,
  };
  const second = {
    ...first,
    id: "credit-2",
    observedAt: "2026-09-14T00:00:00.000Z",
    value: 375,
    previousId: first.id,
  };
  expect(
    parseUserProfileJson(exportUserProfile({ ...base(), economicRecords: [first, second] }))
      .economicRecords,
  ).toEqual([first, second]);
});

test("rejects every credential-bearing and unsafe source before export", () => {
  for (const source of [
    "https://user:password@example.test/source",
    "https://example.test/source?api_key=secret",
    "https://example.test/source?access_token=secret",
    "https://example.test/source?key=secret",
    "https://example.test/source?auth=secret",
    "https://example.test/source#access_token=secret",
    "private-token-value",
    "run:alice-account-123",
    "response:private-data",
  ]) {
    expect(() =>
      exportUserProfile({ ...base(), economicRecords: [{ ...record, source }] }),
    ).toThrow(UserProfileError);
  }
});

test("round-trips calibrated routing and safe capacity ranges", () => {
  const range = {
    provider: "openai",
    unit: "requests/hour",
    lowerBound: 10,
    upperBound: 20,
    observedOn: "2026-09-13",
    source: "https://example.test/limits",
    confidence: "provider_reported" as const,
  };
  const profile = {
    ...base(),
    calibratedRouting: [cell()],
    subscriptionCapacityRanges: [range],
  };
  expect(parseUserProfileJson(exportUserProfile(profile))).toEqual(profile);
  for (const invalid of [
    { ...profile, calibratedRouting: [{ ...cell(), profile: { entries: "bad" } }] },
    { ...profile, subscriptionCapacityRanges: [{ ...range, lowerBound: 21 }] },
    {
      ...profile,
      subscriptionCapacityRanges: [{ ...range, observedOn: "2026-09-13T00:00:00.000Z" }],
    },
  ])
    expect(() => exportUserProfile(invalid)).toThrow(UserProfileError);
});

test("exports deterministic portable data", () => {
  const profile = { ...base(), economicRecords: [record], calibratedRouting: [cell()] };
  const exported = exportUserProfile(profile);
  expect(exported).toBe(exportUserProfile(profile));
  expect(parseUserProfileJson(exported)).toEqual(profile);
});

test("imports merge and replace with conflicts without publication", async () => {
  const { file, store: profileStore } = store();
  await profileStore.write({ ...base(), economicRecords: [record] });
  const before = fs.readFileSync(file);
  await expect(
    profileStore.import({ ...base(), economicRecords: [{ ...record, value: 99 }] }, "merge"),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(fs.readFileSync(file)).toEqual(before);
  const incoming = { ...base(), calibratedRouting: [cell("weekly")] };
  await profileStore.import(incoming, "replace");
  expect((await profileStore.read()).calibratedRouting).toEqual(incoming.calibratedRouting);
  expect((await profileStore.read()).economicRecords).toEqual([record]);
});

test("failed beforeCommit preserves the complete prior document", async () => {
  class FailingStore extends FileUserProfileStore {
    fail = false;
    protected override async beforeCommit() {
      if (this.fail) throw new Error("injected commit failure");
    }
  }
  const { file, store: rawFailingStore } = store(FailingStore);
  const failingStore = rawFailingStore as FailingStore;
  await failingStore.write({ ...base(), economicRecords: [record] });
  const before = fs.readFileSync(file);
  failingStore.fail = true;
  await expect(
    failingStore.appendEconomicRecord({ ...record, id: "price-2" }),
  ).rejects.toMatchObject({ code: "io_error" });
  expect(fs.readFileSync(file)).toEqual(before);
});

test("serializes concurrent appends across stores", async () => {
  const { file, store: first } = store();
  const second = new FileUserProfileStore({ userHome: path.dirname(file), path: file });
  await first.write(base());
  await Promise.all([
    first.appendEconomicRecord(record),
    second.appendEconomicRecord({ ...record, id: "price-2", value: 3 }),
  ]);
  expect((await first.read()).economicRecords.map(({ id }) => id).sort()).toEqual([
    "price-1",
    "price-2",
  ]);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

test("preserves private store safety controls", async () => {
  const { file, store: profileStore } = store();
  expect(await profileStore.read()).toEqual(base());
  await profileStore.write({ ...base(), economicRecords: [record] });
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  fs.writeFileSync(file, "{not-json", { mode: 0o600 });
  await expect(profileStore.read()).rejects.toMatchObject({ code: "invalid_profile" });
});

test("rejects malicious imports at the persistence boundary in both modes", async () => {
  for (const mode of ["merge", "replace"] as const)
    for (const payload of [
      { ...base(), inventories: [{ name: "attack" }] },
      { ...base(), calibratedRouting: [{ ...cell(), inventory: "attack" }] },
    ]) {
      const { file, store: profileStore } = store();
      const local = { ...base(), economicRecords: [record] };
      await profileStore.write(local);
      const before = fs.readFileSync(file);
      await expect(profileStore.import(payload, mode)).rejects.toMatchObject({
        code: "invalid_profile",
      });
      expect(await profileStore.read()).toEqual(local);
      expect(fs.readFileSync(file)).toEqual(before);
    }
});

test("rejects secret-bearing imports before publication in both modes", async () => {
  for (const mode of ["merge", "replace"] as const) {
    const { file, store: profileStore } = store();
    const local = { ...base(), economicRecords: [record] };
    await profileStore.write(local);
    const before = fs.readFileSync(file, "utf8");
    await expect(
      profileStore.import(
        {
          ...base(),
          economicRecords: [{ ...record, source: "https://example.test/source?key=secret" }],
        },
        mode,
      ),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(await profileStore.read()).toEqual(local);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  }
});

test("serializes rejected malicious imports with a successful append", async () => {
  for (const payload of [
    { ...base(), inventories: [{ name: "attack" }] },
    { ...base(), calibratedRouting: [{ ...cell(), inventory: "attack" }] },
  ]) {
    const { file, store: profileStore } = store();
    await profileStore.write({ ...base(), economicRecords: [record] });
    const rejected = profileStore.import(payload, "replace");
    const appended = profileStore.appendEconomicRecord({
      ...record,
      id: "price-race",
      value: 3,
      previousId: record.id,
    });
    const results = await Promise.allSettled([rejected, appended]);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { code: "invalid_profile" },
    });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    const expected = {
      ...base(),
      economicRecords: [record, { ...record, id: "price-race", value: 3, previousId: record.id }],
    };
    expect(await profileStore.read()).toEqual(expected);
    expect(fs.readFileSync(file, "utf8")).toBe(exportUserProfile(expected));
  }
});

test("rejects secret-bearing imports in both modes without changing bytes", async () => {
  for (const mode of ["merge", "replace"] as const) {
    const { file, store: profileStore } = store();
    const local = { ...base(), economicRecords: [record] };
    await profileStore.write(local);
    const before = fs.readFileSync(file);
    const incoming = {
      ...base(),
      economicRecords: [{ ...record, id: "secret", source: "https://user:password@example.test" }],
    };
    await expect(profileStore.import(incoming, mode)).rejects.toMatchObject({
      code: "invalid_profile",
    });
    expect(await profileStore.read()).toEqual(local);
    expect(fs.readFileSync(file)).toEqual(before);
  }
});

test("preview import is non-mutating and preserves typed obsolete-field rejection", () => {
  const local = base();
  expect(previewUserProfileImport(local, { ...base(), inventories: [] }, "merge").result).toEqual(
    local,
  );
  for (const mode of ["merge", "replace"] as const)
    expect(() =>
      previewUserProfileImport(local, { ...base(), inventories: [{ name: "attack" }] }, mode),
    ).toThrow(UserProfileError);
});
