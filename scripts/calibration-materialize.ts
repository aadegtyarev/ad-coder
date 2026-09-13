#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const [fixtureDir, targetDir, mode] = process.argv.slice(2);
if (!fixtureDir || !targetDir)
  throw new Error("usage: calibration-materialize <fixture-dir> <target-dir> [--commit-defect]");
if (mode !== undefined && mode !== "--commit-defect") throw new Error(`unknown mode: ${mode}`);
if (fs.existsSync(targetDir)) throw new Error(`target already exists: ${targetDir}`);
fs.mkdirSync(targetDir, { recursive: true });
for (const entry of fs.readdirSync(fixtureDir)) {
  if (entry === "change.patch" || entry === "README.md" || entry === ".ad-coder") continue;
  fs.cpSync(path.join(fixtureDir, entry), path.join(targetDir, entry), { recursive: true });
}
function git(args: string[]) {
  const result = spawnSync("git", args, { cwd: targetDir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
}
git(["init", "-q"]);
git(["config", "user.name", "ad-coder calibration"]);
git(["config", "user.email", "calibration@invalid"]);
git(["add", "."]);
git(["commit", "-qm", "fixture baseline"]);
git(["apply", path.resolve(fixtureDir, "change.patch")]);
if (mode === "--commit-defect") {
  git(["add", "."]);
  git(["commit", "-qm", "seed benchmark defect"]);
}
process.stdout.write(`${path.resolve(targetDir)}\n`);
