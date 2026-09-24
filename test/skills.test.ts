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

const REPO_ROOT = path.join(import.meta.dir, "..");

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

test("every shipped skill opens by stating that its instruction is mandatory", () => {
  // The catalogue header binds the set; this binds the one skill a role has
  // already loaded, been handed by a pin, or received as an `always` paste. A
  // skill that reads as a suggestion is the failure #330 named: the technique
  // was granted, never applied. The line is identical in every skill so the
  // statement is a rule about skills rather than a habit of one author.
  const opening =
    "**This instruction is mandatory.** Where this skill's description matches the work in front of you, the method below is required: an approach that contradicts it is a defect to fix, not a preference to keep.";
  const dir = path.join(REPO_ROOT, "prompts", "skills");
  const shipped = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  expect(shipped.length).toBeGreaterThan(10);
  for (const skill of shipped) {
    const text = fs.readFileSync(path.join(dir, skill.name, "instructions.md"), "utf8");
    const [first, second] = text.split("\n");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, skill.name, "skill.json"), "utf8"),
    ) as { always?: boolean };
    if (manifest.always === true) {
      // An always skill is pasted unprompted, not selected by a trigger, so it
      // opens by stating that instead -- while keeping the mandatory rule.
      expect(first).toContain("pasted unconditionally");
      expect(first).toContain("mandatory");
    } else {
      expect(first).toBe(opening);
    }
    // The statement is its own paragraph, so it cannot be read as the opening
    // sentence of the technique it introduces.
    expect(second).toBe("");
  }
});

test("every shipped description fits the catalogue budget", () => {
  // docs/contracts/skill-authoring.md (2026-09-18) pins the catalogue entry as
  // the trigger surface and its budget at 1,536 characters: the vendor skill
  // listing truncates a description at that length, so text past it is written
  // but never shown. The budget is the contract's number; the three-part
  // trigger shape is asserted by its own marker test below (release 0.85.0
  // carried every shipped description into that shape, ending the
  // 0.64.0 grandfathering).
  const budget = 1536;
  const dir = path.join(REPO_ROOT, "prompts", "skills");
  const shipped = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  expect(shipped.length).toBeGreaterThan(10);
  for (const skill of shipped) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, skill.name, "skill.json"), "utf8"),
    ) as { description: string };
    expect(manifest.description.length).toBeLessThanOrEqual(budget);
  }
});

test("every shipped description is written as a trigger, not a topic", () => {
  // docs/contracts/skill-authoring.md (2026-09-18): the description decides
  // whether the skill ever exists for a model, and is written in three parts --
  // the capability named, an explicit "Use when..." stated from the side of
  // the work, and example phrases in the operator's vocabulary. The parts a
  // test can see are the markers, asserted here and never by prose equality:
  // the wording is the author's, the shape is the contract's.
  const dir = path.join(REPO_ROOT, "prompts", "skills");
  const shipped = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  expect(shipped.length).toBeGreaterThan(10);
  for (const skill of shipped) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, skill.name, "skill.json"), "utf8"),
    ) as { description: string; always?: boolean };
    if (manifest.always === true) continue;
    expect(manifest.description).toContain("Use when");
    expect(manifest.description).toContain("Phrases:");
  }
});

test("loads shipped skills with a content digest", () => {
  const skill = resolveSkills(["task-slicing"])[0];
  expect(skill).toBeDefined();
  if (skill === undefined) throw new Error("missing built-in skill");
  expect(skill).toMatchObject({ id: "task-slicing", version: "3", source: "builtin" });
  const roleSelection = resolveSkills(["role-selection"])[0];
  expect(roleSelection).toBeDefined();
  if (roleSelection === undefined) throw new Error("missing built-in skill");
  expect(roleSelection).toMatchObject({ id: "role-selection", version: "5", source: "builtin" });
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

test("delivery discipline is shared by all delivery roles and carries the full recovery loop", () => {
  const skill = resolveSkills(["delivery-discipline"])[0];
  expect(skill).toMatchObject({
    id: "delivery-discipline",
    version: "1",
    source: "builtin",
    roles: ["orchestrator", "coder", "reviewer"],
  });
  if (skill === undefined) throw new Error("missing built-in skill");
  expect(skill.instructions).toContain("read `AGENTS.md`");
  expect(skill.instructions).toContain("rebase the branch onto it");
  expect(skill.instructions).toContain("fresh review round");
  expect(skill.instructions).toContain("bun run check:version");
  expect(skill.instructions).toContain("refs/heads/*");
  expect(skill.instructions).toContain("refs/remotes/origin/*");
  expect(skill.instructions).toContain("git push --force-with-lease");
  expect(skill.instructions).toContain("squash merge");
  expect(skill.instructions).toContain("stamp:check");
  expect(skill.instructions).toContain("red CI");
});

test("role-selection prices the middle rung instead of selling it as free (#527)", () => {
  const skill = resolveSkills(["role-selection"])[0];
  if (skill === undefined) throw new Error("missing built-in skill");
  const text = skill.instructions;
  // The rung's PRICE, not merely its existence. A delegated reviewer advises
  // and writes no stamp, so a delegation that MUTATES the tree still owes the
  // declared gates and an independent review round -- the standalone reviewer
  // run when no pipeline is arranging it. A skill that names the rung without
  // its price routes an operator's small ask into work that quietly leaves both
  // behind, which is the defect the paragraph exists to prevent; a paraphrase
  // that keeps only the rung is therefore not enough to pass here.
  expect(text).toContain("advisory");
  expect(text).toContain("writes no stamp");
  expect(text).toContain("its declared gates");
  expect(text).toContain("standalone `ad-coder role reviewer`");
  // And the alternative the skill owes the operator when the review is what the
  // ask actually needs -- said before the code is written, not after.
  expect(text).toContain("offer the pipeline");
});

test("role-selection states the order of preference, and its rungs hold that order (#527)", () => {
  const skill = resolveSkills(["role-selection"])[0];
  if (skill === undefined) throw new Error("missing built-in skill");
  const text = skill.instructions;
  // The CLAIM, not the presence of three phrases. The skill's answer to a
  // direct ask is an ORDER -- own hands, then one role, then the pipeline --
  // and naming the three rungs without stating which one wins is a catalogue,
  // not a routing rule. Measured in review round 4: deleting this sentence
  // left `bun test test/skills.test.ts test/prompts.test.ts` green at 43/43,
  // because the surrounding assertions only asked whether each rung exists.
  expect(text).toContain(
    "The order of preference is your own hands, then one role, then the pipeline",
  );
  // And the document's own body must hold that order. A rung list opening with
  // the pipeline while the sentence above it claims otherwise is the
  // two-answers defect the sentence exists to prevent -- the operator reads the
  // cheapest rung and the run takes the dearest.
  const own = text.indexOf("**Your own hands**");
  const oneRole = text.indexOf("**One role**");
  const pipeline = text.indexOf("**The pipeline**");
  expect(own).toBeGreaterThan(-1);
  expect(oneRole).toBeGreaterThan(own);
  expect(pipeline).toBeGreaterThan(oneRole);
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

test("the row the catalogue advertises loads: `id@version` is an address, not a refusal", async () => {
  // The failure this guards (issue #524): the catalogue renders every row as
  // `- <id>@<version> — <description>`, and the tool's own parameter says
  // "exactly as listed in available skills", while the executor compared the
  // request against the BARE id. So every copied row was refused as
  // `skill_not_available` -- an answer that accuses the caller's role scope,
  // which was false. The model reads that as "this skill does not exist in
  // this configuration" and works from memory instead, which is how the whole
  // machinery stays inert while every gate stays green.
  const catalogue = skillCatalogue("orchestrator");
  const first = catalogue[0];
  expect(first).toBeDefined();
  const advertised = `${first!.id}@${first!.version}`;
  // The rendering and this test must agree that the row IS the advertised
  // string, or the case below passes against a catalogue nobody gets shown.
  expect(formatSkillCatalogue(catalogue)).toContain(`- ${advertised} — `);

  const loaded: SkillLoadRecord[] = [];
  const tool = buildLoadSkillTool({ role: "orchestrator", loaded });
  const call = tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: { text: string }[] }>;

  const byRow = await call("c1", { id: advertised });
  expect(byRow.content[0]?.text).toContain(`## ${advertised}`);
  expect(loaded.map((entry) => entry.id)).toEqual([first!.id]);

  // Both spellings name the same skill, so the second one is answered rather
  // than loaded again -- otherwise a role could reach its per-turn ceiling by
  // re-requesting one skill in the other form.
  const byId = await call("c2", { id: first!.id });
  expect(byId.content[0]?.text).toContain("already loaded");
  expect(loaded).toHaveLength(1);
});

test("every row the catalogue renders loads through the string it renders", async () => {
  // The invariant rather than a sample: a catalogue row's contract with the
  // model is that what is shown is what the loader takes. A single-row case
  // would stay green while a row written by a different author regressed, and
  // the property being protected is about the rendering, not about one skill.
  const catalogue = skillCatalogue("orchestrator");
  expect(catalogue.length).toBeGreaterThan(3);
  const rows = formatSkillCatalogue(catalogue)
    .split("\n")
    .filter((line) => line.startsWith("- "));
  expect(rows).toHaveLength(catalogue.length);

  for (const row of rows) {
    const advertised = row.slice(2, row.indexOf(" — "));
    const loaded: SkillLoadRecord[] = [];
    const tool = buildLoadSkillTool({ role: "orchestrator", loaded });
    const call = tool.execute as unknown as (
      id: string,
      params: unknown,
    ) => Promise<{ content: { text: string }[] }>;
    const answer = await call("c1", { id: advertised });
    expect(answer.content[0]?.text).toContain(`## ${advertised}`);
  }
});

test("a version containing `@` is still an address: the row is compared, never re-split", async () => {
  // A version is any non-empty string (src/skills/resolver.ts), so `@` inside
  // one is legal -- and a loader that split the rendered row on `@` would
  // refuse a row this very catalogue renders (found in review of #524: version
  // `v@2` renders `row-address@v@2`, and splitting at the last `@` answers
  // `row-address@v is not in the available skills for this role`).
  const root = project();
  const { projectDir, builtinDir } = isolated(root);
  writeSkill(root, "row-address", {
    version: "v@2",
    description: "a row whose version carries the delimiter",
    roles: ["orchestrator"],
  });
  const catalogue = skillCatalogue("orchestrator", { projectDir, builtinDir });
  const row = catalogue.find((entry) => entry.id === "row-address");
  expect(row).toBeDefined();
  const advertised = `${row!.id}@${row!.version}`;
  expect(advertised).toBe("row-address@v@2");
  expect(formatSkillCatalogue(catalogue)).toContain(`- ${advertised} — `);

  const loaded: SkillLoadRecord[] = [];
  const tool = buildLoadSkillTool({ role: "orchestrator", loaded, projectDir, builtinDir });
  const call = tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: { text: string }[] }>;

  const answer = await call("c1", { id: advertised });
  expect(answer.content[0]?.text).toContain(`## ${advertised}`);
  expect(loaded.map((entry) => entry.id)).toEqual(["row-address"]);

  // The same row with whitespace around it is the same address.
  const padded = await call("c2", { id: `  ${advertised}  ` });
  expect(padded.content[0]?.text).toContain("already loaded");

  // An address that truncates the version is attributed to the live one: the
  // refusal names what the session lists rather than claiming the skill is
  // unavailable for this role.
  const partial = await call("c3", { id: "row-address@v" });
  expect(partial.content[0]?.text).toContain("skill_version_mismatch");
  expect(partial.content[0]?.text).toContain(`this session lists ${advertised}`);
  expect(loaded).toHaveLength(1);
});

test("a version this session does not list is refused by name, and nothing loads", async () => {
  // The other half of accepting `id@version`: the version has to mean
  // something. A caller that names a revision the session does not have is
  // told which one exists, in its own code -- not answered with a different
  // revision, and not told the skill is unavailable for its role, which would
  // be a false statement about the catalogue.
  const catalogue = skillCatalogue("orchestrator");
  const first = catalogue[0];
  expect(first).toBeDefined();
  const loaded: SkillLoadRecord[] = [];
  const tool = buildLoadSkillTool({ role: "orchestrator", loaded });
  const call = tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: { text: string }[] }>;

  const answer = await call("c1", { id: `${first!.id}@99` });
  expect(answer.content[0]?.text).toContain("skill_version_mismatch");
  expect(answer.content[0]?.text).toContain(`this session lists ${first!.id}@${first!.version}`);
  expect(answer.content[0]?.text).not.toContain("skill_not_available");
  expect(loaded).toHaveLength(0);

  // A bare `@` is not a version: it stays an id the catalogue does not have,
  // so a malformed address cannot load a skill by accident.
  const malformed = await call("c2", { id: `${first!.id}@` });
  expect(malformed.content[0]?.text).toContain("skill_not_available");
  expect(loaded).toHaveLength(0);
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
  // The shipped catalogue is untouched: nothing declares requires, so the
  // orchestrator still sees rows (and a loader) exactly as before. Since 0.181.61
  // exactly one shipped skill is always, and it is the orchestrator's own.
  expect(skillCatalogue("orchestrator").length).toBeGreaterThan(0);
  expect(unconditionalSkills("orchestrator").map((skill) => skill.id)).toEqual([
    "project-conventions",
  ]);

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

test("the orchestrator's kit pastes the project-conventions skill unprompted", () => {
  // The g9 guarantee: the orchestrator must carry the read-conventions rule on
  // every turn, not behind an opt-in delivery-event trigger.
  const kit = roleSkillKit({ role: "orchestrator" });
  expect(kit.appendix).toContain("## project-conventions@1");
  expect(kit.appendix).toContain("locate and read");
  expect(unconditionalSkills("orchestrator")).toContainEqual(
    expect.objectContaining({ id: "project-conventions", always: true }),
  );
});

test("the pasted project-conventions text names the concrete convention documents", () => {
  const kit = roleSkillKit({ role: "orchestrator" });
  const pasted = kit.appendix.split("## project-conventions@1")[1] ?? "";
  for (const document of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING", "docs/contracts/"]) {
    expect(pasted).toContain(document);
  }
});

test("project-conventions is not pasted into a role it was not declared for", () => {
  const kit = roleSkillKit({ role: "reviewer" });
  expect(kit.appendix).not.toContain("project-conventions");
  expect(unconditionalSkills("reviewer")).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ id: "project-conventions" })]),
  );
});

test("prompts/orchestrator.md itself carries the read-conventions rule", () => {
  const prompt = fs.readFileSync(path.join(REPO_ROOT, "prompts", "orchestrator.md"), "utf8");
  for (const phrase of [
    "read its working conventions",
    "AGENTS.md",
    "CLAUDE.md",
    "CONTRIBUTING",
    "docs/contracts/",
    "durable decisions in the project's own",
  ]) {
    expect(prompt).toContain(phrase);
  }
});
