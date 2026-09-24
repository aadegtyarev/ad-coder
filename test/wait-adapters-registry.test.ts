import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createProductionWaitSourceRegistry,
  ProjectStore,
  WaitSourceAdapterRegistry,
  WaitSourceAdapterRegistryError,
} from "../src";

const adapter = (id: string) => ({
  id,
  version: 1,
  validate() {},
  reconcile() {
    return { lifecycle: "pending" as const };
  },
});

test("production registry resolves versioned run and timer adapters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-registry-"));
  try {
    const registry = createProductionWaitSourceRegistry(new ProjectStore(root));
    expect(registry.values().map((value) => `${value.id}@${value.version}`)).toEqual([
      "run@1",
      "timer@1",
    ]);
    expect(() => registry.get("run", 2)).toThrowError(
      new WaitSourceAdapterRegistryError("unavailable_adapter", "run"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registry rejects malformed and duplicate adapters with typed errors", () => {
  expect(() => new WaitSourceAdapterRegistry([adapter("same"), adapter("same")])).toThrowError(
    new WaitSourceAdapterRegistryError("duplicate_adapter", "same"),
  );
  expect(() => new WaitSourceAdapterRegistry([adapter("bad id")])).toThrowError(
    WaitSourceAdapterRegistryError,
  );
});
