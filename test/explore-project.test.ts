import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExploreProjectTool } from "../src/project-tools/explore";

const execute = (
  tool: ReturnType<typeof buildExploreProjectTool>,
  params: Record<string, unknown>,
) =>
  (
    tool.execute as unknown as (
      id: string,
      value: Record<string, unknown>,
    ) => ReturnType<typeof tool.execute>
  )("call", params);

test("explore_project returns bounded metadata and decomposition signals without contents", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-explore-"));
  try {
    await mkdir(path.join(dir, "src"));
    await mkdir(path.join(dir, "node_modules"));
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
    await writeFile(
      path.join(dir, "src", "large.ts"),
      "const secret = 'never report me';\n".repeat(6),
    );
    await writeFile(path.join(dir, "README.md"), "hello\n");
    await writeFile(path.join(dir, "node_modules", "ignored.js"), "x\n".repeat(100));
    const initialized = Bun.spawnSync(["git", "init", "--quiet"], { cwd: dir });
    if (initialized.exitCode !== 0) throw new Error("git init failed");
    const tool = buildExploreProjectTool(dir, { codeLineWarning: 5 });
    const result = await execute(tool, {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("discovery: git-excludes");
    expect(text).toContain("files scanned: 3");
    expect(text).toContain("src/large.ts");
    expect(text).toContain("decomposition signals");
    expect(text).not.toContain("never report me");
    expect(text).not.toContain("ignored.js");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explore_project refuses a focus outside target", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-explore-"));
  try {
    const tool = buildExploreProjectTool(dir);
    const result = await execute(tool, { focus: ".." });
    expect(result.content[0]).toEqual({
      type: "text",
      text: "project exploration failed: focus_outside_target",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Git discovery enforces maxDepth relative to focus", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-explore-"));
  try {
    await mkdir(path.join(dir, "a", "b"), { recursive: true });
    await writeFile(path.join(dir, "a", "shallow.ts"), "x\n");
    await writeFile(path.join(dir, "a", "b", "deep.ts"), "x\n");
    Bun.spawnSync(["git", "init", "--quiet"], { cwd: dir });
    const tool = buildExploreProjectTool(dir, { maxDepth: 1 });
    const result = await (
      tool.execute as unknown as (
        id: string,
        params: Record<string, unknown>,
      ) => ReturnType<typeof tool.execute>
    )("call", {});
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("a/shallow.ts");
    expect(text).not.toContain("a/b/deep.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
