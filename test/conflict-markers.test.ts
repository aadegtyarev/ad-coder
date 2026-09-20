// End-to-end tests for the conflict-marker gate (issue #474). The REAL script
// runs against real temporary git repositories: the gate's whole property
// lives at the boundary between the index and the working tree, so faking the
// git layer would test a parser, not the gate. Repos are created with
// `fs.mkdtemp` under the run root the test preload redirects TMPDIR at, so the
// run's own teardown removes them (the house self-cleaning, issue #419);
// nothing here deletes or commits outside its own temp dirs.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const GATE = path.join(REPO_ROOT, "scripts/check-conflict-markers.ts");

interface GateResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGate(cwd: string): GateResult {
  const proc = Bun.spawnSync(["bun", GATE], { cwd });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

// A temp repo with a first commit, mirroring the rebase aftermath the gate
// exists for: a committed base plus the index that is about to record more.
function initTempRepo(prefix: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Conflict Marker Test"],
    ["config", "user.email", "conflict-markers-test@example.invalid"],
  ]) {
    expect(Bun.spawnSync(["git", ...args], { cwd: target }).exitCode).toBe(0);
  }
  fs.writeFileSync(path.join(target, "base.txt"), "base\n");
  expect(Bun.spawnSync(["git", "add", "--", "base.txt"], { cwd: target }).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "commit", "-m", "base"], { cwd: target }).exitCode).toBe(0);
  return target;
}

// A real conflict region, exactly as a bad resolution leaves it: markers on
// lines 2, 4 and 6 of the file.
const RESOLVED_WITH_MARKERS = [
  "line before the conflict",
  "<<<<<<< HEAD",
  "ours",
  "=======",
  "theirs",
  ">>>>>>> feature",
  "line after the conflict",
  "",
].join("\n");

function stage(repo: string, name: string, contents: string): void {
  fs.writeFileSync(path.join(repo, name), contents);
  expect(Bun.spawnSync(["git", "add", "--", name], { cwd: repo }).exitCode).toBe(0);
}

test("a staged file carrying conflict markers fails the gate, named by path and line", () => {
  const repo = initTempRepo("ad-coder-conflict-red-");
  stage(repo, "notes.md", RESOLVED_WITH_MARKERS);
  const result = runGate(repo);
  expect(result.code).not.toBe(0);
  // The report names the file with the exact line of each marker.
  expect(result.stderr).toContain("notes.md:2:<<<<<<< HEAD");
  expect(result.stderr).toContain("notes.md:4:=======");
  expect(result.stderr).toContain("notes.md:6:>>>>>>> feature");
  // The one-line summary names both counts: one file, three hits.
  expect(result.stderr).toContain("1 file(s), 3 hit(s)");
});

test("a clean index passes with exit 0", () => {
  const repo = initTempRepo("ad-coder-conflict-green-");
  stage(repo, "notes.md", "plain text, no markers\n");
  const result = runGate(repo);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("0 hits");
});

test("the projection is the index: the same marker text in the working tree, unstaged, stays green", () => {
  const repo = initTempRepo("ad-coder-conflict-index-");
  stage(repo, "notes.md", "clean\n");
  // The working-tree file now carries a marker, but the INDEX still holds the
  // clean blob -- nothing carrying markers is about to be committed. This pins
  // the projection choice from issue #474 so a future edit cannot silently
  // flip the gate to scanning the working tree.
  fs.writeFileSync(path.join(repo, "notes.md"), "clean\n<<<<<<< HEAD\n");
  const result = runGate(repo);
  expect(result.code).toBe(0);
});

test("output is bounded: 60 hits print 50 lines and state the total", () => {
  const repo = initTempRepo("ad-coder-conflict-cap-");
  const lines = Array.from({ length: 60 }, (_, index) => `<<<<<<< marker ${index + 1}`);
  stage(repo, "notes.md", `${lines.join("\n")}\n`);
  const result = runGate(repo);
  expect(result.code).not.toBe(0);
  const printedHits = result.stderr.match(/notes\.md:\d+:/g) ?? [];
  expect(printedHits).toHaveLength(50);
  expect(result.stderr).toContain("60 hit(s)");
  expect(result.stderr).toContain("printing first 50 of 60");
});
