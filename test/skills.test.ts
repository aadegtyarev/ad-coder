import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SkillLoadRecord } from "ad-coder";
import {
  buildLoadSkillTool,
  formatSkillCatalogue,
  resolveSkills,
  SkillResolutionError,
  skillCatalogue,
} from "ad-coder";

function expectSkillError(action: () => unknown, code: SkillResolutionError["code"]): void {
  try {
    action();
    throw new Error("expected SkillResolutionError");
  } catch (error) {
    expect(error).toBeInstanceOf(SkillResolutionError);
    expect((error as SkillResolutionError).code).toBe(code);
  }
}

function project(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-skills-"));
}

test("loads shipped skills with a content digest", () => {
  const skill = resolveSkills(["task-slicing"])[0];
  expect(skill).toBeDefined();
  if (skill === undefined) throw new Error("missing built-in skill");
  expect(skill).toMatchObject({ id: "task-slicing", version: "1", source: "builtin" });
  // Substance, not a phrase: a skill that only restates the role prompt is the
  // defect these were expanded to fix. Each must carry a stop rule and the
  // failure it exists to prevent, which is what a role prompt does not have
  // room for.
  expect(skill.instructions).toContain("Acceptance");
  expect(skill.instructions).toContain("Stop condition");
  expect(skill.instructions.length).toBeGreaterThan(600);
  expect(skill.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(resolveSkills(["delivery-calibration"])[0]).toMatchObject({
    id: "delivery-calibration",
    source: "builtin",
    roles: ["orchestrator", "planner"],
  });
});

test("project skill shadows a built-in skill", () => {
  const root = project();
  const dir = path.join(root, ".ad-coder", "skills", "task-slicing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    JSON.stringify({ id: "task-slicing", version: "2", description: "local", roles: ["planner"] }),
  );
  fs.writeFileSync(path.join(dir, "instructions.md"), "local bounded instruction");
  expect(resolveSkills(["task-slicing"], { projectDir: root })[0]).toMatchObject({
    source: "project",
    version: "2",
    instructions: "local bounded instruction",
  });
});

test("digest binds selected source and manifest as well as instructions", () => {
  const builtin = resolveSkills(["task-slicing"])[0];
  const root = project();
  const dir = path.join(root, ".ad-coder", "skills", "task-slicing");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    JSON.stringify({
      id: "task-slicing",
      version: "999",
      description: "changed",
      roles: ["planner"],
    }),
  );
  fs.writeFileSync(path.join(dir, "instructions.md"), builtin?.instructions ?? "");
  const projectSkill = resolveSkills(["task-slicing"], { projectDir: root })[0];
  expect(projectSkill?.instructions).toBe(builtin?.instructions);
  expect(projectSkill?.sha256).not.toBe(builtin?.sha256);
  const firstDigest = projectSkill?.sha256;
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    `${JSON.stringify(
      {
        id: "task-slicing",
        version: "999",
        description: "changed",
        roles: ["planner"],
      },
      null,
      2,
    )}\n`,
  );
  expect(resolveSkills(["task-slicing"], { projectDir: root })[0]?.sha256).not.toBe(firstDigest);
});

test("digest binds original instruction bytes before UTF-8 decoding", () => {
  const root = project();
  const dir = path.join(root, ".ad-coder", "skills", "raw-bytes");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    JSON.stringify({ id: "raw-bytes", version: "1", description: "x", roles: ["planner"] }),
  );
  fs.writeFileSync(path.join(dir, "instructions.md"), Buffer.from([0x80]));
  const first = resolveSkills(["raw-bytes"], { projectDir: root })[0];
  fs.writeFileSync(path.join(dir, "instructions.md"), Buffer.from([0x81]));
  const second = resolveSkills(["raw-bytes"], { projectDir: root })[0];
  expect(first?.instructions).toBe(second?.instructions);
  expect(first?.sha256).not.toBe(second?.sha256);
});

test("refuses duplicate, malformed, and oversized skills before dispatch", () => {
  expectSkillError(() => resolveSkills(["task-slicing", "task-slicing"]), "malformed");
  const root = project();
  const dir = path.join(root, ".ad-coder", "skills", "bad");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "skill.json"), "{");
  expectSkillError(() => resolveSkills(["bad"], { projectDir: root }), "malformed");
  const long = project();
  const longDir = path.join(long, ".ad-coder", "skills", "long");
  fs.mkdirSync(longDir, { recursive: true });
  fs.writeFileSync(
    path.join(longDir, "skill.json"),
    JSON.stringify({ id: "long", version: "1", description: "x", roles: ["planner"] }),
  );
  fs.writeFileSync(path.join(longDir, "instructions.md"), "x".repeat(20));
  expectSkillError(
    () => resolveSkills(["long"], { projectDir: long, maxInstructionBytes: 10 }),
    "oversized",
  );
});

test("rejects skill manifest and instructions symlink escapes", () => {
  const root = project();
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(
    path.join(outside, "skill.json"),
    JSON.stringify({
      id: "manifest-escape",
      version: "1",
      description: "outside",
      roles: ["planner"],
    }),
  );
  const manifestDir = path.join(root, ".ad-coder", "skills", "manifest-escape");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.symlinkSync(path.join(outside, "skill.json"), path.join(manifestDir, "skill.json"));
  expectSkillError(() => resolveSkills(["manifest-escape"], { projectDir: root }), "escaping");

  const instructionDir = path.join(root, ".ad-coder", "skills", "instruction-escape");
  fs.mkdirSync(instructionDir, { recursive: true });
  fs.writeFileSync(
    path.join(instructionDir, "skill.json"),
    JSON.stringify({
      id: "instruction-escape",
      version: "1",
      description: "local",
      roles: ["planner"],
    }),
  );
  fs.writeFileSync(path.join(outside, "instructions.md"), "outside instructions");
  fs.symlinkSync(
    path.join(outside, "instructions.md"),
    path.join(instructionDir, "instructions.md"),
  );
  expectSkillError(() => resolveSkills(["instruction-escape"], { projectDir: root }), "escaping");
});

test("rejects root, intermediate, and skill-directory symlink escapes", () => {
  const root = project();
  const outside = project();
  const rootEscape = path.join(root, "linked-project");
  fs.symlinkSync(outside, rootEscape);
  expectSkillError(() => resolveSkills(["any"], { projectDir: rootEscape }), "escaping");

  const intermediate = project();
  const skillRoot = path.join(intermediate, ".ad-coder");
  fs.symlinkSync(outside, skillRoot);
  expectSkillError(() => resolveSkills(["any"], { projectDir: intermediate }), "escaping");

  const idRoot = project();
  const idParent = path.join(idRoot, ".ad-coder", "skills");
  fs.mkdirSync(idParent, { recursive: true });
  fs.symlinkSync(outside, path.join(idParent, "escaped"));
  expectSkillError(() => resolveSkills(["escaped"], { projectDir: idRoot }), "escaping");
});

test("enforces requested skill and manifest byte limits before loading", () => {
  expectSkillError(
    () => resolveSkills(["task-slicing", "architecture-recon"], { maxRequestedSkills: 1 }),
    "oversized",
  );

  const root = project();
  const dir = path.join(root, ".ad-coder", "skills", "large-manifest");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skill.json"),
    `${JSON.stringify({ id: "large-manifest", version: "1", description: "local", roles: ["planner"] })}${" ".repeat(20)}`,
  );
  fs.writeFileSync(path.join(dir, "instructions.md"), "local instructions");
  expectSkillError(
    () => resolveSkills(["large-manifest"], { projectDir: root, maxManifestBytes: 10 }),
    "oversized",
  );
});

test("rejects invalid skill resolver limits", () => {
  expectSkillError(() => resolveSkills([], { maxRequestedSkills: 0 }), "malformed");
  expectSkillError(() => resolveSkills([], { maxManifestBytes: Infinity }), "malformed");
  expectSkillError(() => resolveSkills([], { maxInstructionBytes: 1.5 }), "malformed");
});

test("a role receives the catalogue, and loads instructions only when it asks", async () => {
  // Selecting every skill and pasting it cost the orchestrator 2106 words of
  // appendix regardless of the task. docs/contracts/skills.md forbids exactly
  // that: discovery "must never silently inject full instructions into every
  // role prompt". So the prompt carries names, and the tool carries text.
  const catalogue = skillCatalogue("orchestrator");
  expect(catalogue.length).toBeGreaterThan(0);
  const rendered = formatSkillCatalogue(catalogue);
  for (const entry of catalogue) expect(rendered).toContain(entry.id);
  // Cheap by construction: names and one-liners, not methods.
  expect(rendered.length).toBeLessThan(1200);
  expect(rendered).not.toContain("git status");

  const loaded: SkillLoadRecord[] = [];
  const tool = buildLoadSkillTool({ role: "orchestrator", loaded });
  const call = tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: { text: string }[] }>;

  const ok = await call("c1", { id: "repository-navigation" });
  expect(ok.content[0]?.text).toContain("git status");
  expect(loaded).toHaveLength(1);
  expect(loaded[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);

  // Role scope still gates: a skill not written for this role is refused with
  // the same answer the catalogue gave, not a different one that reveals it.
  const denied = await call("c2", { id: "no-such-skill" });
  expect(denied.content[0]?.text).toContain("skill_not_available");

  // Loading twice is answered, not repeated.
  const again = await call("c3", { id: "repository-navigation" });
  expect(again.content[0]?.text).toContain("already loaded");
  expect(loaded).toHaveLength(1);
});
