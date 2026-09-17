import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PromptError, resolvePrompt } from "ad-coder";

const REPO_ROOT = path.join(import.meta.dir, "..");

/**
 * Prompts are hard-wrapped, so a phrase that happens to straddle a newline is
 * absent from the raw string and present in the rendered prompt -- an assertion
 * that reads the raw text fails for a reason that has nothing to do with the
 * prompt's meaning. Collapse runs of whitespace before matching.
 */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-prompts-"));
}

test("resolves a built-in prompt by name byte-for-byte", () => {
  const direct = fs.readFileSync(path.join(REPO_ROOT, "prompts", "coder.md"), "utf8");
  expect(resolvePrompt("coder")).toBe(direct);
});

test("ships the Auditor contract-coverage prompt", () => {
  const prompt = flat(resolvePrompt("auditor"));
  expect(prompt).toContain("contract_missing");
  expect(prompt).toContain("explicitly approves");
  // The auditor has no write tools. A prompt that tells it to store a proposal
  // or write to the backlog itself describes work it cannot do -- the finding
  // leaves as its report and the orchestrator records it.
  expect(prompt).toContain("no write tools");
});

test("Planner prompt bounds reconnaissance without hiding evidence gaps", () => {
  const prompt = flat(resolvePrompt("planner"));
  expect(prompt).toContain("Read to answer the task, not to catalogue the repository");
  expect(prompt).toContain("research_required");
  // The planner has no bash tool (see resolve-config's per-role grants), so the
  // prompt must not teach shell batching it cannot perform.
  expect(prompt).not.toContain("`rg`");
});

test("the Planner prompt names the channel the coder actually reads", () => {
  // session.ts sets `planSummary` from the planner's ASSISTANT TEXT, and that
  // is what composeCoderPrompt hands the coder -- submit_plan's schema has no
  // steps field at all. A prompt forbidding plan text in the assistant message
  // told a compliant planner to hand the next stage an empty plan.
  const prompt = flat(resolvePrompt("planner"));
  expect(prompt).toContain("Your assistant text carries the plan itself");
  expect(prompt).not.toContain("Do not emit the plan or a JSON copy in assistant text");
});

test("every shipped role prompt points at the skills carrying its technique", () => {
  // The technique lives in skills so that it survives a disabled role: any role
  // may be switched off, and the knowledge must not leave with it.
  for (const role of ["coder", "reviewer", "security", "researcher", "planner", "auditor"]) {
    expect(flat(resolvePrompt(role))).toContain("Load `");
  }
});

test("the summarizer prompt is a file like every other role prompt", () => {
  // It was a string constant in src/context/compactor.ts, which made it the one
  // role contract a project could not override.
  const prompt = flat(resolvePrompt("summarizer"));
  expect(prompt).toContain("compacting a coding agent's conversation");
  expect(prompt).toContain("Identifiers exactly as written");
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

test("the orchestrator prompt makes classification a step before mutation (issues #263/#264)", () => {
  const prompt = flat(resolvePrompt("orchestrator"));
  // The classification step exists, names the rubric it runs on, and is named
  // as a step whose answer can only exist before the work.
  const classify = prompt.indexOf("Classify before you mutate");
  expect(classify).toBeGreaterThan(-1);
  expect(prompt).toContain("Read-only inspection may precede the classification");
  // Ordering is the fix: nothing that permits a mutation may be readable before
  // the classification step, so the permissive branch cannot match first.
  const prohibition = prompt.indexOf("Editing files is a delegate's work");
  const exception = prompt.indexOf("Direct editing is the classified exception");
  const pipeline = prompt.indexOf("goes through the pipeline");
  expect(prohibition).toBeGreaterThan(classify);
  expect(pipeline).toBeGreaterThan(classify);
  // The permission is stated only inside the prohibition that bounds it, never
  // before it.
  expect(exception).toBeGreaterThan(prohibition);
  expect(prompt).toContain("When unsure, classify up.");
});
