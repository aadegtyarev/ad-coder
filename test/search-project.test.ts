import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSearchProjectTool } from "../src/project-tools/search";

const execute = (tool: ReturnType<typeof buildSearchProjectTool>, terms: string[]) =>
  (
    tool.execute as unknown as (
      id: string,
      params: { terms: string[] },
    ) => ReturnType<typeof tool.execute>
  )("call", { terms });

test("search_project returns a ranked bounded task projection", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-search-"));
  try {
    await mkdir(path.join(dir, "src"));
    await writeFile(
      path.join(dir, "src", "main.ts"),
      "export function stageLimit() {}\nstageLimit();\n",
    );
    await writeFile(path.join(dir, "src", "other.ts"), "stageLimit();\n");
    await writeFile(path.join(dir, "src", "new.ts"), "stageLimit();\n");
    Bun.spawnSync(["git", "init", "--quiet"], { cwd: dir });
    Bun.spawnSync(["git", "add", "src/main.ts", "src/other.ts"], { cwd: dir });
    const result = await execute(buildSearchProjectTool(dir, { maxMatches: 2 }), ["stageLimit"]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("matches: 4 (showing 2)");
    expect(text).toContain("src/main.ts:1:");
    expect(text).not.toContain("src/other.ts");
    expect(result.details).toEqual({ matches: 4, returned: 2, truncated: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search_project treats task terms as literals", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-search-"));
  try {
    await writeFile(path.join(dir, "source.ts"), "axb\na.b\n");
    Bun.spawnSync(["git", "init", "--quiet"], { cwd: dir });
    const result = await execute(buildSearchProjectTool(dir), ["a.b"]);
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("matches: 1");
    expect(text).toContain("source.ts:2:a.b");
    expect(text).not.toContain("axb");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("search_project validates configurable request bounds", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ad-coder-search-"));
  try {
    Bun.spawnSync(["git", "init", "--quiet"], { cwd: dir });
    const result = await execute(buildSearchProjectTool(dir, { maxTerms: 1 }), ["one", "two"]);
    expect(result.content[0]).toEqual({ type: "text", text: "project search failed: terms_limit" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
