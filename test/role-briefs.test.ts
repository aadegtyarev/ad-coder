import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  composeRoleBrief,
  RoleBriefError,
  resolveResearchRoleBrief,
} from "../src/prompts/role-briefs";

function briefFile(content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-role-brief-"));
  const file = path.join(directory, "brief.md");
  fs.writeFileSync(file, content);
  return file;
}

test("bootstrap and refresh resolve a digest-bearing brief", () => {
  const content = "Research only official sources.\n";
  const source = { id: "inventory", version: "v1", path: briefFile(content) };
  for (const purpose of ["model-inventory-bootstrap", "model-inventory-refresh"] as const) {
    const brief = resolveResearchRoleBrief(purpose, source);
    expect(brief).toMatchObject({
      id: source.id,
      version: source.version,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(composeRoleBrief("system", brief!)).toBe(`system\n\n${content}`);
  }
});

test("ordinary research has no brief and invalid required sources fail closed", () => {
  expect(resolveResearchRoleBrief(undefined)).toBeUndefined();
  expect(() => resolveResearchRoleBrief(undefined, { id: "x", version: "1", path: "x" })).toThrow(
    RoleBriefError,
  );
  expect(() =>
    resolveResearchRoleBrief("model-inventory-bootstrap", {
      id: "x",
      version: "1",
      path: "/missing",
    }),
  ).toThrow("unavailable");
  expect(() =>
    resolveResearchRoleBrief("model-inventory-refresh", {
      id: "x",
      version: "1",
      path: briefFile(""),
    }),
  ).toThrow("empty");
});
