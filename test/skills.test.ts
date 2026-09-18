import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SkillLoadRecord } from "ad-coder";
import {
  buildLoadSkillTool,
  dependenciesMet,
  formatSkillCatalogue,
  pluginNamesFromToolNames,
  resolveSkills,
  roleSkillKit,
  SkillResolutionError,
  skillCatalogue,
  skillInventory,
  unconditionalSkills,
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

/*
 * Project skill resolution with the shipped catalogue out of the way: these
 * cases are about the new manifest fields, not about what happens to ship.
 */
function isolated(root: string): { projectDir: string; builtinDir: string } {
  return { projectDir: root, builtinDir: path.join(root, "no-builtin-skills") };
}

/** A project skill: manifest fields plus instruction text, in the target layout. */
function writeSkill(
  root: string,
  id: string,
  manifest: Record<string, unknown>,
  instructions = `${id} instructions`,
): void {
  const dir = path.join(root, ".ad-coder", "skills", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "skill.json"), JSON.stringify({ id, version: "1", ...manifest }));
  fs.writeFileSync(path.join(dir, "instructions.md"), instructions);
}

test("loads shipped skills with a content digest", () => {
  const skill = resolveSkills(["task-slicing"])[0];
  expect(skill).toBeDefined();
  if (skill === undefined) throw new Error("missing built-in skill");
  expect(skill).toMatchObject({ id: "task-slicing", version: "1", source: "builtin" });
  const roleSelection = resolveSkills(["role-selection"])[0];
  expect(roleSelection).toBeDefined();
  if (roleSelection === undefined) throw new Error("missing built-in skill");
  expect(roleSelection).toMatchObject({ id: "role-selection", version: "3", source: "builtin" });
  // The static half of issue #232: what each worker role does, returns, and
  // when delegating to it is wrong -- never a restatement of the role names.
  expect(roleSelection.instructions).toContain("Roles only");
  expect(roleSelection.instructions).toContain("do not call it");
  expect(roleSelection.instructions.length).toBeGreaterThan(600);
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
    roles: ["orchestrator"],
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
  // Cheap by construction: names and one-liners, not methods. The bound is per
  // entry, not on the whole rendering -- a total ceiling would mean shipping a
  // new skill could only be paid for by shortening an unrelated one, and the
  // property being protected is that a catalogue row stays a row.
  expect(rendered.length / catalogue.length).toBeLessThan(200);
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

test("refuses malformed always and requires declarations", () => {
  const root = project();
  const bad = (id: string, manifest: Record<string, unknown>): void => {
    writeSkill(root, id, manifest);
    expectSkillError(() => resolveSkills([id], { projectDir: root }), "malformed");
  };
  // `always` is a boolean, not a truthy string: a manifest that says "yes" was
  // written by someone guessing at the schema, and guessing is what we refuse.
  bad("always-string", { description: "x", roles: ["planner"], always: "yes" });
  // `requires` is an object with exactly two known list-valued keys; an array,
  // a bare string, and an unknown key are each refused rather than ignored.
  bad("requires-array", { description: "x", roles: ["planner"], requires: [] });
  bad("requires-string", {
    description: "x",
    roles: ["planner"],
    requires: { plugins: "explore" },
  });
  bad("requires-unknown", {
    description: "x",
    roles: ["planner"],
    requires: { unknown: ["x"] },
  });
  bad("requires-element", {
    description: "x",
    roles: ["planner"],
    requires: { plugins: [true] },
  });
  bad("requires-empty-name", {
    description: "x",
    roles: ["planner"],
    requires: { workflows: [""] },
  });
});

test("a valid always and requires manifest resolves and carries both fields", () => {
  const root = project();
  writeSkill(root, "composition-aware", {
    description: "needs the pipeline and the web tools",
    roles: ["planner"],
    always: true,
    requires: { workflows: ["pipeline"], plugins: ["web"] },
  });
  const skill = resolveSkills(["composition-aware"], { projectDir: root })[0];
  expect(skill?.always).toBe(true);
  expect(skill?.requires).toEqual({ workflows: ["pipeline"], plugins: ["web"] });
  // A shipped skill declares neither, and is unaffected in every mode.
  const shipped = resolveSkills(["task-slicing"])[0];
  expect(shipped?.always).toBeUndefined();
  expect(shipped?.requires).toBeUndefined();
  expect(dependenciesMet(undefined)).toBe(true);
});

test("an unmet dependency hides a skill from the catalogue and the paste", () => {
  const root = project();
  writeSkill(root, "needs-pipeline", {
    description: "needs the pipeline workflow",
    roles: ["planner"],
    requires: { workflows: ["pipeline"] },
  });
  writeSkill(root, "needs-web", {
    description: "needs the web plugin",
    roles: ["planner"],
    requires: { plugins: ["web"] },
  });
  writeSkill(root, "needs-nothing", { description: "plain skill", roles: ["planner"] });
  const ids = (options: Parameters<typeof skillCatalogue>[1]): string[] =>
    skillCatalogue("planner", { ...isolated(root), ...options }).map((entry) => entry.id);

  // Undefined composition fails closed: nothing is available, so a skill that
  // requires anything is invisible -- not offered and then refused.
  expect(ids({})).toEqual(["needs-nothing"]);
  expect(dependenciesMet({ workflows: ["pipeline"] }, {})).toBe(false);
  expect(dependenciesMet({ plugins: ["web"] }, { availablePlugins: [] })).toBe(false);
  expect(
    dependenciesMet(
      { workflows: ["pipeline"], plugins: ["web"] },
      { availableWorkflows: ["pipeline"], availablePlugins: ["web"] },
    ),
  ).toBe(true);

  expect(ids({ availableWorkflows: ["pipeline"] })).toEqual(["needs-nothing", "needs-pipeline"]);
  expect(ids({ availablePlugins: ["explore", "web"] })).toEqual(["needs-nothing", "needs-web"]);
  // Partial composition still fails closed per entry.
  expect(ids({ availableWorkflows: ["other"] })).toEqual(["needs-nothing"]);
  // `config show` reports what a run can reach: an unsatisfiable dependency is
  // not a row there either, so the count an operator sees is the count a role
  // can load.
  expect(skillInventory(isolated(root)).map((skill) => skill.id)).toEqual(["needs-nothing"]);
  expect(
    skillInventory({ ...isolated(root), availablePlugins: ["web"] }).map((skill) => skill.id),
  ).toEqual(["needs-nothing", "needs-web"]);
});

test("an always skill is pasted, never catalogued, and never loadable", async () => {
  const root = project();
  writeSkill(
    root,
    "always-for-planner",
    { description: "unconditional method", roles: ["planner"], always: true },
    "always-for-planner body",
  );
  writeSkill(root, "always-other-role", {
    description: "unconditional elsewhere",
    roles: ["reviewer"],
    always: true,
  });
  const kit = roleSkillKit({ role: "planner", ...isolated(root) });
  expect(kit.appendix).toContain("## always-for-planner@1\nalways-for-planner body");
  // Role scope still governs the paste: a reviewer's skill is not this role's.
  expect(kit.appendix).not.toContain("always-other-role");
  // Its text is already in the prompt, so it is not a row and cannot be loaded.
  expect(skillCatalogue("planner", isolated(root))).toEqual([]);
  expect(unconditionalSkills("planner", isolated(root)).map((skill) => skill.id)).toEqual([
    "always-for-planner",
  ]);
  expect(unconditionalSkills("coder", isolated(root))).toEqual([]);
  // The shipped catalogue is untouched: nothing declares always or requires, so
  // the orchestrator still sees rows (and a loader) exactly as before.
  expect(skillCatalogue("orchestrator").length).toBeGreaterThan(0);
  expect(unconditionalSkills("orchestrator")).toEqual([]);

  const tool = buildLoadSkillTool({ role: "planner", ...isolated(root) });
  const call = tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: { text: string }[] }>;
  const denied = await call("c1", { id: "always-for-planner" });
  expect(denied.content[0]?.text).toContain("skill_not_available");

  // The explicit off still beats everything: an always skill is capability, and
  // `--no-skills` (or the profile switch) removes it with the rest.
  const off = roleSkillKit({ role: "planner", ...isolated(root), disabled: true });
  expect(off.appendix).toBe("");
  expect(off.includeLoadTool).toBe(false);
});

test("catalogue mode pastes always skills and hides unsatisfiable ones", async () => {
  const root = project();
  writeSkill(
    root,
    "always-scoped",
    { description: "unconditional method", roles: ["planner"], always: true },
    "always-scoped body",
  );
  writeSkill(root, "always-foreign", {
    description: "unconditional elsewhere",
    roles: ["reviewer"],
    always: true,
  });
  writeSkill(root, "needs-web", {
    description: "needs the web plugin",
    roles: ["planner"],
    requires: { plugins: ["web"] },
  });
  writeSkill(root, "planner-plain", { description: "plain method", roles: ["planner"] });

  const kit = roleSkillKit({
    role: "planner",
    ...isolated(root),
    availableWorkflows: ["pipeline"],
    availablePlugins: ["explore"],
  });
  expect(kit.appendix).toContain("## always-scoped@1\nalways-scoped body");
  expect(kit.appendix).toContain("planner-plain");
  // A dependency this session cannot satisfy appears nowhere: not in the paste,
  // not as a row, and therefore not loadable either.
  expect(kit.appendix).not.toContain("needs-web");
  expect(kit.includeLoadTool).toBe(true);

  const loader = buildLoadSkillTool({
    role: "planner",
    ...isolated(root),
    availablePlugins: ["explore"],
  });
  const call = loader.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: { text: string }[] }>;
  const denied = await call("c1", { id: "needs-web" });
  expect(denied.content[0]?.text).toContain("skill_not_available");
  const ok = await call("c2", { id: "planner-plain" });
  expect(ok.content[0]?.text).toContain("planner-plain instructions");

  // With the plugin really registered the same role gets the row and the text.
  const withWeb = roleSkillKit({
    role: "planner",
    ...isolated(root),
    availablePlugins: ["web"],
  });
  expect(withWeb.appendix).toContain("needs-web");
});

test("pin mode drops an unsatisfiable pin and keeps an always skill", () => {
  const root = project();
  writeSkill(
    root,
    "always-scoped",
    { description: "unconditional method", roles: ["planner"], always: true },
    "always-scoped body",
  );
  writeSkill(root, "pinned-met", {
    description: "pinned and satisfiable",
    roles: ["planner"],
    requires: { workflows: ["pipeline"] },
  });
  writeSkill(root, "pinned-unmet", {
    description: "pinned and unsatisfiable",
    roles: ["planner"],
    requires: { workflows: ["pipeline"], plugins: ["vision"] },
  });

  const kit = roleSkillKit({
    role: "planner",
    projectDir: root,
    selectedSkills: ["pinned-unmet", "pinned-met"],
    availableWorkflows: ["pipeline"],
    availablePlugins: ["web"],
  });
  // A pin still fails loudly on an unknown id (resolveSkills), but a dependency
  // this session lacks is a fact about the session, not a bad request: the
  // pinned skill is dropped from the paste instead of aborting the run.
  expect(kit.appendix).toContain("## pinned-met@1");
  expect(kit.appendix).toContain("## always-scoped@1\nalways-scoped body");
  expect(kit.appendix).not.toContain("pinned-unmet");
  expect(kit.includeLoadTool).toBe(false);
});

test("plugin names come from registered tool names, not from configuration", () => {
  expect(pluginNamesFromToolNames([])).toEqual([]);
  expect(pluginNamesFromToolNames(["explore_project", "inspect_image"])).toEqual([
    "explore",
    "vision",
  ]);
  expect(pluginNamesFromToolNames(["web_read", "search_project", "read_project"])).toEqual([
    "explore",
    "web",
  ]);
  // An unrelated tool proves nothing, and a configured-but-unregistered group
  // cannot be smuggled in by name alone.
  expect(pluginNamesFromToolNames(["run_gates", "web"])).toEqual([]);
});
