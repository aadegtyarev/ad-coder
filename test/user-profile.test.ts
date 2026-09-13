import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UserProfile } from "ad-coder";
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

function profile(records: UserProfile["economicRecords"] = []): UserProfile {
  return {
    version: 1,
    inventories: [
      {
        name: "primary",
        providers: [{ id: "openai", models: ["gpt"] }],
        default: "gpt",
      },
    ],
    calibratedRouting: [],
    economicRecords: records,
    subscriptionCapacityRanges: [],
  };
}

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

function createStore(Store: typeof FileUserProfileStore = FileUserProfileStore): {
  file: string;
  store: FileUserProfileStore;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-profile-"));
  roots.push(root);
  const file = path.join(root, "private", "profile.json");
  return { file, store: new Store({ userHome: root, configPath: file }) };
}

test("parses and round-trips only complete version-one portable profiles", () => {
  const expected = profile([record]);
  expect(parseUserProfileJson(exportUserProfile(expected))).toEqual(expected);

  for (const invalid of [
    "{",
    JSON.stringify({ inventories: [], economicRecords: [] }),
    JSON.stringify({ ...profile(), version: 2 }),
    JSON.stringify({ ...profile(), inventories: [{}] }),
    JSON.stringify({
      ...profile(),
      inventories: [{ name: "bad", providers: [{ id: "p", models: [] }] }],
    }),
    JSON.stringify({
      ...profile(),
      inventories: [{ name: "bad", providers: [{ id: "p", models: ["m"] }], default: "other" }],
    }),
    JSON.stringify({ ...profile(), economicRecords: [{ ...record, value: "2.5" }] }),
    JSON.stringify({ ...profile(), economicRecords: [{ ...record, value: -1 }] }),
    JSON.stringify({ ...profile(), economicRecords: [{ ...record, observedAt: "2026-09-13" }] }),
    JSON.stringify({ ...profile(), extra: true }),
  ]) {
    expect(() => parseUserProfileJson(invalid)).toThrow(UserProfileError);
  }
});

test("returns empty missing state and persists validated profiles privately", async () => {
  const { file, store: profileStore } = createStore();
  expect(await profileStore.read()).toEqual({
    version: 1,
    inventories: [],
    calibratedRouting: [],
    economicRecords: [],
    subscriptionCapacityRanges: [],
  });
  expect(fs.existsSync(path.dirname(file))).toBe(false);

  await profileStore.write(profile());
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);

  fs.writeFileSync(file, "{not-json", { mode: 0o600 });
  await expect(profileStore.read()).rejects.toMatchObject({ code: "invalid_profile" });
});

test("appends economics records and rejects every history rewrite", async () => {
  const { store: profileStore } = createStore();
  await profileStore.write(profile([record]));
  const second = { ...record, id: "price-2", value: 3, previousId: record.id };
  await profileStore.appendEconomicRecord(second);
  expect((await profileStore.read()).economicRecords).toEqual([record, second]);

  await expect(
    profileStore.appendEconomicRecord({ ...second, id: "bad", value: Number.NaN }),
  ).rejects.toMatchObject({ code: "invalid_profile" });
  await expect(
    profileStore.write(profile([{ ...record, id: "price-2", value: 3 }])),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await profileStore.read()).economicRecords).toEqual([record, second]);
});

test("independent stores serialize concurrent economic appends", async () => {
  const { file, store: first } = createStore();
  const second = new FileUserProfileStore({ userHome: path.dirname(file), path: file });
  await first.write(profile());
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

test("round-trips valid source URLs and imports them", () => {
  const expected = profile([record]);
  expected.economicRecords[0]!.source = "https://example.test/pricing";
  expected.calibratedRouting = [
    {
      inventory: "primary",
      profile: { entries: [{ role: "coder", complexity: "medium", model: "gpt" }] },
      observedOn: "2026-09-13",
      source: "https://example.test/calibration",
      confidence: "measured",
    },
  ];
  expected.subscriptionCapacityRanges = [
    {
      provider: "openai",
      unit: "requests/hour",
      lowerBound: 10,
      upperBound: 20,
      observedOn: "2026-09-13",
      source: "https://example.test/limits",
      confidence: "provider_reported",
    },
  ];

  const exported = exportUserProfile(expected);
  expect(parseUserProfileJson(exported)).toEqual(expected);
  expect(previewUserProfileImport(profile(), expected, "merge").result).toEqual(expected);
});

test("validates calibrated routing and safe subscription-capacity ranges", () => {
  const expected = profile();
  expected.calibratedRouting = [
    {
      inventory: "primary",
      profile: { entries: [{ role: "coder", complexity: "medium", model: "gpt" }] },
      observedOn: "2026-09-13",
      source: "https://example.test/calibration",
      confidence: "measured",
    },
  ];
  expected.subscriptionCapacityRanges = [
    {
      provider: "openai",
      unit: "requests/hour",
      lowerBound: 10,
      upperBound: 20,
      observedOn: "2026-09-13",
      source: "https://example.test/limits",
      confidence: "provider_reported",
    },
  ];
  const exported = exportUserProfile(expected);
  expect(exported).toBe(exportUserProfile(expected));
  expect(parseUserProfileJson(exported)).toEqual(expected);

  for (const invalid of [
    {
      ...expected,
      calibratedRouting: [{ ...expected.calibratedRouting[0]!, inventory: "missing" }],
    },
    {
      ...expected,
      calibratedRouting: [
        {
          ...expected.calibratedRouting[0]!,
          profile: { entries: [{ role: "coder", complexity: "medium", model: "outside" }] },
        },
      ],
    },
    {
      ...expected,
      subscriptionCapacityRanges: [{ ...expected.subscriptionCapacityRanges[0]!, lowerBound: 21 }],
    },
    {
      ...expected,
      subscriptionCapacityRanges: [
        { ...expected.subscriptionCapacityRanges[0]!, observedOn: "2026-09-13T00:00:00.000Z" },
      ],
    },
    {
      ...expected,
      subscriptionCapacityRanges: [
        { ...expected.subscriptionCapacityRanges[0]!, provider: "orphan-provider" },
      ],
    },
  ]) {
    expect(() => exportUserProfile(invalid)).toThrow(UserProfileError);
  }
});

test("rejects credential-bearing source URLs before export", () => {
  const sources = [
    "https://user:password@example.test/source",
    "https://example.test/source?api_key=secret",
    "https://example.test/source?access_token=secret",
    "https://example.test/source?key=secret",
    "https://example.test/source?auth=secret",
    "https://example.test/source#access_token=secret",
    "private-token-value",
    "run:alice-account-123",
    "response:private-data",
  ];
  for (const source of sources) {
    expect(() => exportUserProfile(profile([{ ...record, source }]))).toThrow(UserProfileError);
  }
});

test("exports deterministic portable data without leaking rejected private fields", () => {
  const exported = exportUserProfile(profile([record]));
  expect(exported).toBe(exportUserProfile(profile([record])));
  expect(parseUserProfileJson(exported)).toEqual(profile([record]));

  const secret = "private-token-value";
  try {
    exportUserProfile({ ...profile(), credentials: secret });
    throw new Error("expected private field rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(UserProfileError);
    expect((error as Error).message).not.toContain(secret);
  }
});

test("previews repeatedly without writes and applies merge or replace", async () => {
  const { file, store: profileStore } = createStore();
  await profileStore.write(profile([record]));
  const before = fs.readFileSync(file);
  const beforeMode = fs.statSync(file).mode;
  const incoming = profile([{ ...record, id: "price-2", value: 3 }]);
  incoming.inventories = [
    { name: "secondary", providers: [{ id: "anthropic", models: ["claude"] }] },
  ];
  incoming.calibratedRouting = [
    {
      inventory: "secondary",
      profile: { entries: [{ role: "coder", complexity: "medium", model: "claude" }] },
      observedOn: "2026-09-13",
      source: "https://example.test/calibration",
      confidence: "measured",
    },
  ];
  incoming.subscriptionCapacityRanges = [
    {
      provider: "anthropic",
      unit: "requests/hour",
      lowerBound: 10,
      upperBound: 20,
      observedOn: "2026-09-13",
      source: "https://example.test/limits",
      confidence: "provider_reported",
    },
  ];

  const first = await profileStore.previewImport(incoming, "merge");
  const second = previewUserProfileImport(await profileStore.read(), incoming, "merge");
  expect(first).toEqual(second);
  expect(first.conflicts).toEqual([]);
  expect(first.creates).toEqual([
    "inventory:secondary",
    "calibratedRouting:secondary",
    "subscriptionCapacityRange:anthropic:requests/hour",
    "economicRecord:price-2",
  ]);
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.statSync(file).mode).toBe(beforeMode);

  await profileStore.import(incoming, "merge");
  const mergedBytes = fs.readFileSync(file);
  expect((await profileStore.read()).economicRecords).toEqual([
    record,
    incoming.economicRecords[0]!,
  ]);
  expect((await profileStore.read()).calibratedRouting).toEqual(incoming.calibratedRouting);
  expect((await profileStore.read()).subscriptionCapacityRanges).toEqual(
    incoming.subscriptionCapacityRanges,
  );
  await profileStore.import(incoming, "merge");
  expect(fs.readFileSync(file)).toEqual(mergedBytes);

  await profileStore.import({ ...profile(), inventories: [] }, "replace");
  expect((await profileStore.read()).inventories).toEqual([]);
  expect((await profileStore.read()).economicRecords).toEqual([
    record,
    incoming.economicRecords[0]!,
  ]);
});

test("rejects conflicts and invalid modes without changing the private document", async () => {
  const { file, store: profileStore } = createStore();
  await profileStore.write(profile([record]));
  const before = fs.readFileSync(file);

  await expect(
    profileStore.import(profile([{ ...record, value: 99 }]), "merge"),
  ).rejects.toMatchObject({
    code: "conflict",
  });
  expect(() => previewUserProfileImport(profile(), profile(), "invalid" as "merge")).toThrow(
    UserProfileError,
  );
  expect(fs.readFileSync(file)).toEqual(before);
});

test("a failed atomic commit preserves the prior complete document", async () => {
  class FailingStore extends FileUserProfileStore {
    fail = false;

    protected override async beforeCommit(): Promise<void> {
      if (this.fail) throw new Error("injected commit failure");
    }
  }

  const { file, store } = createStore(FailingStore);
  const failingStore = store as FailingStore;
  await failingStore.write(profile([record]));
  const before = fs.readFileSync(file);
  failingStore.fail = true;

  await expect(
    failingStore.appendEconomicRecord({ ...record, id: "price-2", value: 3 }),
  ).rejects.toMatchObject({ code: "io_error" });
  expect(fs.readFileSync(file)).toEqual(before);
  failingStore.fail = false;
  expect((await failingStore.read()).economicRecords).toEqual([record]);
});
