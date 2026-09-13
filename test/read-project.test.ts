import { expect, test } from "bun:test";
import {
  rename as fsRename,
  symlink as fsSymlink,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildReadProjectTool } from "../src/project-tools/read";

const execute = (tool: ReturnType<typeof buildReadProjectTool>, items: object[]) =>
  (
    tool.execute as unknown as (
      id: string,
      value: { items: object[] },
    ) => ReturnType<typeof tool.execute>
  )("call", { items });

test("read_project batches exact line slices under one aggregate ceiling", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-read-"));
  try {
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "a.ts"), "one\ntwo\nthree\n");
    await writeFile(path.join(dir, "src", "b.ts"), "alpha\nbeta\n");
    const result = await execute(buildReadProjectTool(dir), [
      { path: "src/a.ts", offset: 2, limit: 2 },
      { path: "src/b.ts", limit: 1 },
    ]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("src/a.ts:2-3\n2: two\n3: three");
    expect(text).toContain("src/b.ts:1-1\n1: alpha");
    expect(text).not.toContain("beta");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_project makes aggregate truncation visible and cages paths", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-read-"));
  try {
    await writeFile(path.join(dir, "large.txt"), "x".repeat(200));
    const tool = buildReadProjectTool(dir, { maxOutputBytes: 100 });
    const bounded = await execute(tool, [{ path: "large.txt" }]);
    const text = bounded.content[0]?.type === "text" ? bounded.content[0].text : "";
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100);
    expect(text).toContain("output truncated");
    const escaped = await execute(tool, [{ path: "../outside" }]);
    expect(escaped.content[0]).toEqual({
      type: "text",
      text: "project read failed: path_outside_target",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_project caps growth after descriptor stat", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-read-"));
  try {
    const file = path.join(dir, "growing.txt");
    await writeFile(file, "small");
    const tool = buildReadProjectTool(
      dir,
      { maxFileBytes: 16 },
      {
        afterStat: async () => writeFile(file, "x".repeat(100)),
      },
    );
    const result = await execute(tool, [{ path: "growing.txt" }]);
    expect(result.content[0]).toEqual({
      type: "text",
      text: "project read failed: file_too_large",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_project keeps an opened parent when its pathname is swapped", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-read-"));
  const outside = await mkdtemp(path.join(tmpdir(), "ad-coder-outside-"));
  try {
    await mkdir(path.join(dir, "safe"));
    await writeFile(path.join(dir, "safe", "value.txt"), "inside\n");
    await writeFile(path.join(outside, "value.txt"), "outside\n");
    const tool = buildReadProjectTool(
      dir,
      {},
      {
        afterOpenDirectory: async () => {
          await fsRename(path.join(dir, "safe"), path.join(dir, "old"));
          await fsSymlink(outside, path.join(dir, "safe"));
        },
      },
    );
    const result = await execute(tool, [{ path: "safe/value.txt" }]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("inside");
    expect(text).not.toContain("outside");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
