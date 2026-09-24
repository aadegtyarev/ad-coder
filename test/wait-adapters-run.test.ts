import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunWaitAdapter, ProjectStore, WaitAdapterValidationError } from "../src";

function fixture(value: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-run-"));
  const store = new ProjectStore(root);
  return { root, store, value };
}

test("run adapter maps actual standalone and coordinator record statuses", async () => {
  const { root, store } = fixture(null);
  try {
    for (const [kind, status, lifecycle] of [
      ["standalone", "complete", "satisfied"],
      ["standalone", "failed", "failed"],
      ["coordinator", "complete", "satisfied"],
      ["coordinator", "paused", "stalled"],
    ] as const) {
      const id = `${kind}-${status}`;
      store.writeVersionedJson(
        path.join(store.layout.runs, `${kind}-${id}.json`),
        kind === "standalone"
          ? { runId: id, status }
          : {
              runId: id,
              phase: status === "paused" ? "workflow" : status,
              ...(status === "paused"
                ? { pause: { phase: "workflow", code: "operator_attention", action: "inspect" } }
                : {}),
            },
      );
      const result = await createRunWaitAdapter(store).reconcile({
        waitId: "w",
        operationId: "o",
        source: { adapter: "run", version: 1, target: { kind, id } },
        condition: { kind: "terminal" },
      });
      expect(result.lifecycle).toBe(lifecycle);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run validation is typed and unsafe target IDs are unavailable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wait-run-"));
  try {
    const adapter = createRunWaitAdapter(new ProjectStore(root));
    expect(() =>
      adapter.validate({ kind: "standalone", id: "../escape" }, { kind: "terminal" }),
    ).toThrowError(new WaitAdapterValidationError("invalid_target", "run"));
    expect(
      await adapter.reconcile({
        waitId: "w",
        operationId: "o",
        source: { adapter: "run", version: 1, target: { kind: "standalone", id: "../escape" } },
        condition: { kind: "terminal" },
      }),
    ).toEqual({ lifecycle: "unavailable", evidence: "source_unavailable" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt and non-object run records stay untouched and become unavailable", async () => {
  const { root, store } = fixture(null);
  try {
    const adapter = createRunWaitAdapter(store);
    for (const [id, bytes] of [
      ["corrupt", '{"version":1,'],
      ["scalar", "42"],
    ] as const) {
      const recordPath = path.join(store.layout.runs, `standalone-${id}.json`);
      fs.writeFileSync(recordPath, bytes, "utf8");
      expect(
        await adapter.reconcile({
          waitId: "w",
          operationId: "o",
          source: { adapter: "run", version: 1, target: { kind: "standalone", id } },
          condition: { kind: "terminal" },
        }),
      ).toEqual({ lifecycle: "unavailable", evidence: "source_unavailable" });
      expect(fs.readFileSync(recordPath, "utf8")).toBe(bytes);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing and malformed run records are unavailable and leak no source fields", async () => {
  const { root, store } = fixture(null);
  try {
    const adapter = createRunWaitAdapter(store);
    const result = await adapter.reconcile({
      waitId: "w",
      operationId: "o",
      source: { adapter: "run", version: 1, target: { kind: "standalone", id: "missing" } },
      condition: { kind: "terminal" },
    });
    expect(result).toEqual({ lifecycle: "unavailable", evidence: "source_unavailable" });
    store.writeVersionedJson(path.join(store.layout.runs, "standalone-bad.json"), {
      task: "secret",
      path: "/private",
      pid: 4,
      output: "raw",
    });
    expect(
      await adapter.reconcile({
        waitId: "w",
        operationId: "o",
        source: { adapter: "run", version: 1, target: { kind: "standalone", id: "bad" } },
        condition: { kind: "terminal" },
      }),
    ).toEqual({ lifecycle: "unavailable", evidence: "source_unavailable" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
