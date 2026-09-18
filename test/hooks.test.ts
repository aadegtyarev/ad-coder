/**
 * The pre-commit branch boundary (issue #334): the rule that work lands on a
 * feature branch and a pull request is a hook, not advice, so both its paths are
 * tested rather than described (`docs/contracts/product-change.md`).
 *
 * Every case runs the shipped `scripts/hooks/pre-commit` itself in a scratch
 * repository, with `core.hooksPath` pointed at the real hooks directory: a copy
 * would prove nothing about the file that ships.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOOKS_DIR = path.resolve(import.meta.dir, "..", "scripts", "hooks");

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface GitResult {
  exitCode: number;
  stderr: string;
}

function git(cwd: string, ...args: string[]): GitResult {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode ?? 0,
    stderr: Buffer.from(proc.stderr).toString("utf8"),
  };
}

/** A scratch repository standing on `branch`, with the hooks not yet installed. */
function scratchRepo(branch: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-hook-"));
  scratchDirs.push(dir);
  for (const args of [
    ["init", "-q"],
    ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
    ["config", "user.email", "hook@example.invalid"],
    ["config", "user.name", "hook test"],
    ["config", "commit.gpgsign", "false"],
  ]) {
    const result = git(dir, ...args);
    expect(`${args.join(" ")}: ${result.stderr}`).toBe(`${args.join(" ")}: `);
  }
  return dir;
}

/** Point this repository at the shipped hooks, optionally overriding the default branch. */
function installHooks(dir: string, defaultBranch?: string): void {
  expect(git(dir, "config", "core.hooksPath", HOOKS_DIR).exitCode).toBe(0);
  if (defaultBranch !== undefined)
    expect(git(dir, "config", "hooks.defaultbranch", defaultBranch).exitCode).toBe(0);
}

/** Stage a fresh file, so a commit has something to carry. */
function stage(dir: string, name: string): void {
  fs.writeFileSync(path.join(dir, name), `${name}\n`);
  expect(git(dir, "add", "--", name).exitCode).toBe(0);
}

function commit(dir: string, message: string): GitResult {
  return git(dir, "commit", "--no-gpg-sign", "-m", message);
}

test("a work commit on the default branch is rejected, and names the next command", () => {
  const dir = scratchRepo("main");
  installHooks(dir);
  stage(dir, "work.txt");

  const result = commit(dir, "work");

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("no commit on 'main'");
  expect(result.stderr).toContain("Next command: git switch -c");
});

test("the same commit on a feature branch is allowed", () => {
  const dir = scratchRepo("feature/branch-rule");
  installHooks(dir);
  stage(dir, "work.txt");

  expect(commit(dir, "work").exitCode).toBe(0);
});

test("without origin/HEAD both git defaults fail closed", () => {
  for (const branch of ["main", "master"]) {
    const dir = scratchRepo(branch);
    installHooks(dir);
    stage(dir, "work.txt");

    const result = commit(dir, "work");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`no commit on '${branch}'`);
  }
});

test("hooks.defaultbranch replaces git's defaults rather than adding to them", () => {
  const configured = scratchRepo("trunk");
  installHooks(configured, "trunk");
  stage(configured, "work.txt");
  const rejected = commit(configured, "work");
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr).toContain("no commit on 'trunk'");

  const unguarded = scratchRepo("main");
  installHooks(unguarded, "trunk");
  stage(unguarded, "work.txt");
  expect(commit(unguarded, "work").exitCode).toBe(0);
});

test("a merge commit landing a reviewed branch is allowed on the default branch", () => {
  const dir = scratchRepo("main");
  stage(dir, "base.txt");
  expect(commit(dir, "base").exitCode).toBe(0);
  expect(git(dir, "checkout", "-q", "-b", "side").exitCode).toBe(0);
  stage(dir, "side.txt");
  expect(commit(dir, "side").exitCode).toBe(0);
  expect(git(dir, "checkout", "-q", "main").exitCode).toBe(0);
  stage(dir, "main.txt");
  expect(commit(dir, "main").exitCode).toBe(0);

  installHooks(dir);
  // `--no-commit` leaves MERGE_HEAD in place, which is the state a conflicted
  // merge is finished from -- the only way a merge commit reaches pre-commit.
  expect(git(dir, "merge", "--no-commit", "side").exitCode).toBe(0);
  expect(commit(dir, "merge side").exitCode).toBe(0);

  // The hook is installed in this very repository: a work commit is still refused.
  stage(dir, "after.txt");
  expect(commit(dir, "work").exitCode).not.toBe(0);
});

test("a detached HEAD is not guarded", () => {
  const dir = scratchRepo("main");
  stage(dir, "base.txt");
  expect(commit(dir, "base").exitCode).toBe(0);
  git(dir, "checkout", "-q", "--detach");
  installHooks(dir);
  stage(dir, "work.txt");

  expect(commit(dir, "work").exitCode).toBe(0);
});
