import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatSkillCatalogue, PromptError, resolvePrompt, skillCatalogue } from "ad-coder";

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

test("the Reviewer prompt bounds the read to the change (issue #352)", () => {
  // A round that surveyed the repository spent 792569 input tokens and closed
  // out at the stage ceiling with no verdict; the same tree, read as a diff,
  // took 44287 and settled. The method belongs in the role's own prompt, so no
  // caller has to brief it.
  const prompt = flat(resolvePrompt("reviewer"));
  expect(prompt).toContain("Read the change as a diff, not as a repository");
  expect(prompt).toContain("Surveying the rest of the repository is not diligence");
  expect(prompt).toContain("the base the task names, `main` when it names none");
  // The bound does not replace the contracts bullet: the changed surface still
  // decides which contracts are read.
  expect(prompt).toContain("every enforceable contract governing the changed surface");
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

test("every shipped role prompt states that a matching skill is binding", () => {
  // A rule that lives only in a skill a model may skip is advice, not a rule:
  // a catalogue is a menu, and a menu is optional. The obligation is therefore
  // stated in general words in the role's own prompt -- never by naming a
  // skill, which is the catalogue's job because only it knows what this
  // session's composition actually offers (2026-09-18, docs/contracts/skills.md).
  for (const role of [
    "orchestrator",
    "coder",
    "reviewer",
    "security",
    "researcher",
    "planner",
    "auditor",
  ]) {
    expect(flat(resolvePrompt(role))).toContain(
      "loading it and following it is mandatory rather than optional",
    );
  }
});

test("no shipped role prompt names a skill", () => {
  // The enumeration this replaced was advice ("Load `x` when y") and, with
  // --no-skills or an unmet `requires`, it named a capability the session did
  // not have. Names live in the catalogue, which is composition-aware; the
  // prompt carries the rule that makes them binding.
  const promptDir = path.join(REPO_ROOT, "prompts");
  const ids = fs
    .readdirSync(path.join(promptDir, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect(ids.length).toBeGreaterThan(10);
  for (const file of fs.readdirSync(promptDir).filter((name) => name.endsWith(".md"))) {
    const text = fs.readFileSync(path.join(promptDir, file), "utf8");
    for (const id of ids) expect(text).not.toContain(`\`${id}\``);
  }
  // The rule is not vacuous: it is stated where the names are.
  const catalogue = formatSkillCatalogue(skillCatalogue("orchestrator"));
  expect(catalogue).toContain("mandatory rather than optional");
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

test("the orchestrator prompt carries the expectation block and its three mandatory fields", () => {
  // An expectation nobody wrote down cannot be checked after the run, and
  // advice to write one down does not fire: src/skills/load-tool.ts records the
  // orchestrator holding `delivery-calibration`, never loading it, and
  // dispatching ten seconds later. The block is therefore a mandatory form in
  // the prompt itself, and each field is pinned by its label -- deleting the
  // block or any one field turns this red.
  const prompt = flat(resolvePrompt("orchestrator"));
  expect(prompt).toContain("Name the expectation before you dispatch it.");
  // Field 1: the form of the work, priced from the record, with the budgets.
  expect(prompt).toContain("the form of the work");
  expect(prompt).toContain("comparable accepted work in the record");
  expect(prompt).toContain("numbers and not a recollection");
  expect(prompt).toContain("the budgets you are setting for it");
  // Field 2: the sign is something the record can settle, not a retelling.
  expect(prompt).toContain("the observable sign that the expectation did not hold");
  expect(prompt).toContain("seen in the record rather than in anyone's retelling");
  // Field 3: the stop condition, tied to that sign.
  expect(prompt).toContain("the stop condition — what you do when that sign appears");
  // It is a dispatching obligation: it sits after the sizing paragraph and
  // before the issue-claiming one.
  const sizing = prompt.indexOf("budget the implementation needed.");
  const expectation = prompt.indexOf("Name the expectation before you dispatch it.");
  const claiming = prompt.indexOf("**Claim an issue before you work it");
  expect(sizing).toBeGreaterThan(-1);
  expect(expectation).toBeGreaterThan(sizing);
  expect(claiming).toBeGreaterThan(expectation);
});

test("the skills obligation is pinned to the run's record, not to a promise", () => {
  // "Mandatory" in the catalogue header did not fire either (same evidence),
  // so the obligation needs a sign the run itself carries: one tool_activity
  // record in the run's recorded tool activity carries the skill id each load
  // targeted (src/observability/tool-activity.ts), and that record is what
  // evals/scorers/skill-trigger.ts scores -- "not from the model's answer".
  // Pin the phrases that make absence visible; a pin of bare willingness would
  // test the promise, not the record.
  const prompt = flat(resolvePrompt("orchestrator"));
  // For a dispatch, the matching catalogue id is named...
  expect(prompt).toContain("name the catalogue id whose description matches the work by place");
  // ...and the record, not the orchestrator's word, carries the verdict.
  expect(prompt).toContain("the run's record must show that id among its loads");
  expect(prompt).toContain("the run's recorded tool activity");
  // The sign is the absence itself, while the work matches the description.
  expect(prompt).toContain(
    "absent from the run's record while the work is of the kind its description names",
  );
  // A failed check stops the dispatch rather than passing it.
  expect(prompt).toContain("hand the method in the brief for a delegate or re-dispatch");
  expect(prompt).toContain("rather than treating the dispatch as compliant");
});
