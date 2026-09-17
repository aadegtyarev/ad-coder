import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import {
  createBuiltinTools,
  DEFAULT_EDIT_DIAGNOSTIC_MAX_BYTES,
  locateEditOccurrences,
  locateNearestEditRegion,
} from "../src/runner/builtin-tools";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-builtin-"));
}

const invocationStub = {
  invocationId: "call-1",
  operationId: "op",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

const runEdit = (
  dir: string,
  edits: { oldText: string; newText: string }[],
  pathArg = "a.txt",
): Promise<unknown> => {
  const env = new NodeExecutionEnv({ cwd: dir });
  const tool = createBuiltinTools(env).at(-1);
  if (tool === undefined || tool.name !== "edit") throw new Error("edit tool missing");
  return tool.execute(
    "call-1",
    { path: pathArg, edits },
    () => {},
    { env },
    invocationStub,
    TODO_CONTEXT,
  );
};

const fail = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
    throw new Error("expected the edit call to reject");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

test("the built-in tool names stay usable for the collision guard", () => {
  const tools = createBuiltinTools(new NodeExecutionEnv({ cwd: "/" }));
  expect(tools.map((tool) => tool.name)).toEqual(["bash", "read", "write", "edit"]);
});

test("bash carries its boundary description, attached to the built-in name", () => {
  const [bash, read, write, edit] = createBuiltinTools(new NodeExecutionEnv({ cwd: "/" }));
  if (bash === undefined || read === undefined || write === undefined || edit === undefined)
    throw new Error("built-in tool set is not exactly four tools");
  expect(bash.description).toContain("NOT a general-purpose interface");
  expect(bash.description).toContain("read files with read");
  expect(bash.description).toContain("EDIT FILES ONLY WITH EDIT");
  // The specialised tools keep their upstream descriptions: only bash's
  // boundary is attached here (issue #231), so a change upstream stays real.
  expect(read.description).toContain("Read the contents of a file");
  expect(write.description).toContain("Write content to a file");
  expect(edit.description).toContain("exact text replacement");
});

test("locateNearestEditRegion names a nearby region and flags stale text", () => {
  const content = "alpha line\nbeta line\nrelease: 1\nend marker\n";
  const near = locateNearestEditRegion(content, "release: 2\nend marker");
  expect(near.verdict).toBe("close");
  expect(near.line).toBe(3);

  const stale = locateNearestEditRegion(content, "aspect ratio: 4\nquality: high");
  expect(stale.verdict).toBe("far");
});

test("locateEditOccurrences maps occurrences to bounded line numbers", () => {
  const content = "a\nUNIQUE\ntail\nUNIQUE2\nUNIQUE second\n";
  expect(locateEditOccurrences(content, "UNIQUE")).toEqual([2, 4, 5]);
  expect(locateEditOccurrences(content, "UNIQUE", 2)).toEqual([2, 4]);
  expect(locateEditOccurrences(content, "")).toEqual([]);
});

test("a failed edit reports the region to re-read and hides the file's content", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha line\nbeta line\nrelease = 1\nend marker\n");
  const error = await fail(
    runEdit(dir, [{ oldText: "release = 2\nend marker", newText: "release = 9\nend marker" }]),
  );
  expect(error.message).toContain("Could not find");
  expect(error.message).toContain("line 3");
  expect(error.message).toContain("retry the edit");
  expect(error.message).not.toContain("release = 1");
});

test("a non-unique edit failure reports bounded occurrence line numbers", async () => {
  const dir = tempDir();
  const marker = "REPEAT_ME";
  fs.writeFileSync(path.join(dir, "a.txt"), `${marker}\ntail\n${marker}\n`);
  const error = await fail(runEdit(dir, [{ oldText: marker, newText: "maybe" }]));
  expect(error.message).toContain("occurrence");
  expect(error.message).toContain("line(s) 1, 3");
});

test("a successful edit result is unchanged by the diagnostics wrapper", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  const result = (await runEdit(dir, [{ oldText: "one", newText: "ONE" }])) as {
    content?: { text?: string }[];
  };
  expect(result.content?.[0]?.text).toContain("Successfully replaced 1 block(s)");
  expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8").startsWith("ONE")).toBe(true);
});

test("diagnostics stay within the positive read ceiling (quality contract)", () => {
  expect(DEFAULT_EDIT_DIAGNOSTIC_MAX_BYTES).toBeGreaterThan(0);
});
