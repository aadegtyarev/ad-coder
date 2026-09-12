import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PromptError, resolvePrompt } from "ad-coder";

const REPO_ROOT = path.join(import.meta.dir, "..");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-prompts-"));
}

test("resolves a built-in prompt by name byte-for-byte", () => {
  const direct = fs.readFileSync(path.join(REPO_ROOT, "prompts", "coder.md"), "utf8");
  expect(resolvePrompt("coder")).toBe(direct);
});

test("a project prompt shadows the built-in of the same name", () => {
  const projectDir = tmpDir();
  const dir = path.join(projectDir, ".ad-coder", "prompts");
  fs.mkdirSync(dir, { recursive: true });
  const override = "PROJECT OVERRIDE coder prompt\n";
  fs.writeFileSync(path.join(dir, "coder.md"), override, "utf8");

  const builtin = fs.readFileSync(path.join(REPO_ROOT, "prompts", "coder.md"), "utf8");
  const resolved = resolvePrompt("coder", { projectDir });
  expect(resolved).toBe(override);
  expect(resolved).not.toBe(builtin);
});

test("resolution is read-only and imposes no size or symlink cage on trusted overrides", () => {
  const projectDir = tmpDir();
  const promptDir = path.join(projectDir, ".ad-coder", "prompts");
  const sourceDir = tmpDir();
  fs.mkdirSync(promptDir, { recursive: true });
  const largeTrustedPrompt = `${"trusted configuration\n".repeat(20_000)}tail \t\n`;
  const source = path.join(sourceDir, "trusted.md");
  fs.writeFileSync(source, largeTrustedPrompt, "utf8");
  fs.symlinkSync(source, path.join(promptDir, "coder.md"));
  const before = fs.readdirSync(projectDir, { recursive: true }).sort();

  expect(resolvePrompt("coder", { projectDir })).toBe(largeTrustedPrompt);
  expect(fs.readdirSync(projectDir, { recursive: true }).sort()).toEqual(before);
});

test("an unresolvable name throws not_found carrying no file contents", () => {
  const projectDir = tmpDir();
  let thrown: unknown;
  try {
    resolvePrompt("nope-does-not-exist", { projectDir });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(PromptError);
  const e = thrown as PromptError;
  expect(e.code).toBe("not_found");
  expect(e.promptName).toBe("nope-does-not-exist");
  // Both tiers searched (project first, then built-in), absolute paths only.
  expect(e.pathsTried.length).toBe(2);
  expect(e.pathsTried[0]).toBe(
    path.join(projectDir, ".ad-coder", "prompts", "nope-does-not-exist.md"),
  );
  // A real built-in exists so its content is on disk; prove it never leaked.
  const realBuiltin = fs.readFileSync(path.join(REPO_ROOT, "prompts", "coder.md"), "utf8");
  const firstLine = realBuiltin.split("\n")[0];
  const haystack = `${e.message} ${JSON.stringify(e.pathsTried)} ${e.promptName}`;
  expect(haystack).not.toContain(firstLine);
});

test("an invalid name throws invalid_name before any fs access", () => {
  for (const bad of ["../x", "a/b", "a.b", ""]) {
    let thrown: unknown;
    try {
      resolvePrompt(bad);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PromptError);
    const e = thrown as PromptError;
    expect(e.code).toBe("invalid_name");
    expect(e.promptName).toBe(bad);
    // No path was built or searched -- the throw precedes any fs access.
    expect(e.pathsTried).toEqual([]);
  }
});

test("a prompt with trailing whitespace and non-ASCII round-trips verbatim", () => {
  const builtinDir = tmpDir();
  const body = "héllo \t\n";
  fs.writeFileSync(path.join(builtinDir, "verbatim.md"), body, "utf8");
  expect(resolvePrompt("verbatim", { builtinDir })).toBe(body);
});
