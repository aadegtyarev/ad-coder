import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { changedPaths, outOfScope, snapshot } from "../evals/runner/scope";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** A fixture materialized the way the corpus runner materializes one. */
function materialize(fixture: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `scope-${fixture}-`));
  fs.rmSync(target, { recursive: true });
  const run = Bun.spawnSync(
    [
      "bun",
      path.join(REPO_ROOT, "scripts", "calibration-materialize.ts"),
      path.join(REPO_ROOT, "evals", "fixtures", fixture),
      target,
    ],
    { cwd: REPO_ROOT },
  );
  if (run.exitCode !== 0) throw new Error(run.stderr.toString() || "materialize failed");
  return target;
}

test("an untouched target is in scope, and every edit outside the allow-list is not", () => {
  const target = materialize("trivial-normalize");
  try {
    const before = snapshot(target);
    expect(before.size).toBeGreaterThan(0);
    // The baseline against itself. Without this the check could be reporting
    // violations that materialization itself caused, and every task would fail
    // scope for a reason no model is responsible for.
    expect(outOfScope(before, snapshot(target), [])).toEqual([]);

    // The work the task actually asks for.
    fs.writeFileSync(path.join(target, "src", "tags.ts"), "export const changed = true;\n");
    fs.mkdirSync(path.join(target, "test"), { recursive: true });
    fs.writeFileSync(path.join(target, "test", "tags.test.ts"), "// regression\n");
    const allow = ["src/**", "test/**", "package.json"];
    expect(outOfScope(before, snapshot(target), allow)).toEqual([]);

    // Scope creep, in the three shapes that matter: a new module nobody asked
    // for, an edit to a file outside the brief, and a scratch file left behind.
    fs.writeFileSync(path.join(target, "logger.ts"), "export const log = console.log;\n");
    fs.writeFileSync(path.join(target, "README.md"), "# rewritten\n");
    fs.writeFileSync(path.join(target, "notes.txt"), "scratch\n");
    expect(outOfScope(before, snapshot(target), allow)).toEqual([
      "README.md",
      "logger.ts",
      "notes.txt",
    ]);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("a deleted file is a change, and the harness's own directory is not", () => {
  const target = materialize("trivial-normalize");
  try {
    const before = snapshot(target);
    // A tree walk cannot see this at all, which is why the snapshot is a map of
    // digests compared in both directions rather than a list of what is there.
    fs.rmSync(path.join(target, "package.json"));
    expect(changedPaths(before, snapshot(target))).toEqual(["package.json"]);

    // ad-coder writes its ledger, run checkpoints and session transcript into
    // every target. Charging those to the model would fail every task at once.
    fs.mkdirSync(path.join(target, ".ad-coder", "ledger"), { recursive: true });
    fs.writeFileSync(path.join(target, ".ad-coder", "ledger", "run.jsonl"), "{}\n");
    expect(outOfScope(before, snapshot(target), ["package.json"])).toEqual([]);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("a fixture's seeded defect is not reported as the model's edit", () => {
  // `reviewer-hidden-regression` ships its defect as an uncommitted working-tree
  // change, so the role under test can read it as a `git diff`. Compared against
  // the baseline COMMIT, that seeded diff is indistinguishable from a model
  // editing a file it was not asked to touch -- on every run of that task.
  const target = materialize("reviewer-hidden-regression");
  try {
    const status = Bun.spawnSync(["git", "-C", target, "diff", "--name-only"], { cwd: REPO_ROOT });
    expect(status.stdout.toString().trim()).not.toBe("");
    expect(outOfScope(snapshot(target), snapshot(target), [])).toEqual([]);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("build output a fixture ignores is not charged to the model", () => {
  // Cargo writes `target/`, Python writes `__pycache__/`, and both tasks ask for
  // tests the model is expected to RUN. Each fixture's own `.gitignore` says so,
  // and honouring it is why the snapshot asks git rather than walking the tree.
  const target = materialize("rust-unicode-prefix");
  try {
    const before = snapshot(target);
    fs.mkdirSync(path.join(target, "target", "debug"), { recursive: true });
    fs.writeFileSync(path.join(target, "target", "debug", "libprefix.rlib"), "binary\n");
    expect(outOfScope(before, snapshot(target), [])).toEqual([]);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("a cited line one past the end of the fixture is rejected", () => {
  // The off-by-one is the fabrication worth catching: a model citing line 214
  // of a 21-line file is rare, one citing line 22 is not. Counting lines as
  // `split("\n").length` admitted exactly that, because every file here ends in
  // a newline and the split yields a phantom final element.
  const scorer = path.join(REPO_ROOT, "evals", "scorers", "reviewer-hidden-regression.ts");
  const fixture = path.join(REPO_ROOT, "evals", "fixtures", "reviewer-hidden-regression");
  // The length the reviewer actually sees: the checked-in file plus the seeded
  // patch, which materialization applies before the role runs.
  const target = materialize("reviewer-hidden-regression");
  let lastLine: number;
  try {
    lastLine = fs
      .readFileSync(path.join(target, "src/result-store.ts"), "utf8")
      .replace(/\n$/, "")
      .split("\n").length;
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
  expect(fs.existsSync(fixture)).toBe(true);

  const score = (line: number): boolean => {
    const answer = path.join(os.tmpdir(), `cited-${line}.json`);
    fs.writeFileSync(
      answer,
      JSON.stringify([
        { code: "PATH_TRAVERSAL_DECODED_ID", blocking: true, evidence: "src/result-store.ts:5" },
        {
          code: "METADATA_WRITE_ORDER_REVERSED",
          blocking: true,
          evidence: `src/result-store.ts:${line}`,
        },
      ]),
    );
    try {
      const run = Bun.spawnSync(["bun", scorer, answer], { cwd: REPO_ROOT });
      const checks = JSON.parse(run.stdout.toString()) as { id: string; passed: boolean }[];
      return checks.find((check) => check.id === "cited-lines-exist")?.passed === true;
    } finally {
      fs.rmSync(answer, { force: true });
    }
  };

  expect(score(lastLine)).toBe(true);
  expect(score(lastLine + 1)).toBe(false);
});

test("making a file executable is a change; changing it back is not", () => {
  const target = materialize("trivial-normalize");
  try {
    const before = snapshot(target);
    // `chmod +x` alters nothing a scorer reads and is still the model editing
    // the tree outside its brief. It is also the only mode git tracks, which
    // keeps this snapshot's notion of "changed" aligned with the repository's.
    fs.chmodSync(path.join(target, "package.json"), 0o755);
    expect(changedPaths(before, snapshot(target))).toEqual(["package.json"]);

    // Content changed and restored is deliberately NOT a change: `reviewer.md`
    // tells the Reviewer to revert a diff, run the test, and put the tree back
    // exactly as it found it. Scoring that as scope creep would punish a role
    // for obeying its own prompt.
    const file = path.join(target, "src", "tags.ts");
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, "wrecked");
    fs.writeFileSync(file, original);
    expect(changedPaths(before, snapshot(target))).toEqual(["package.json"]);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("a symlink planted in the target is out of scope, whatever it points at", () => {
  const target = materialize("trivial-normalize");
  const payload = fs.mkdtempSync(path.join(os.tmpdir(), "payload-"));
  try {
    const before = snapshot(target);
    fs.symlinkSync("/etc/passwd", path.join(target, "leaked.txt"));
    // A symlink to a DIRECTORY is the case that got away: reading it throws
    // `EISDIR`, and skipping unreadable paths dropped it from both snapshots, so
    // no allow-list could catch it. An unreadable path is now recorded by its
    // error code rather than omitted -- present, and unequal to any readable
    // version of itself.
    fs.symlinkSync(payload, path.join(target, "vendor"));
    fs.symlinkSync("/nonexistent-xyz", path.join(target, "dangling"));
    expect(outOfScope(before, snapshot(target), ["src/**", "package.json"])).toEqual([
      "dangling",
      "leaked.txt",
      "vendor",
    ]);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(payload, { recursive: true, force: true });
  }
});
