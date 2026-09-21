import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { compareVersionFixup } from "../src/stamp/record-review-stamp";
import { parseReviewStamp } from "../src/stamp/review-stamp";

const root = path.resolve(import.meta.dir, "..");
const run = (args: string[]): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  return result.stdout.toString();
};
const marker = JSON.parse(fs.readFileSync(path.join(root, "ad-coder.stamps.json"), "utf8")) as {
  file?: string;
};
const stampsFile = marker.file ?? "docs/reviews/stamps.log";
const lines = fs.readFileSync(path.join(root, stampsFile), "utf8").trimEnd().split("\n");
const parsed = parseReviewStamp(lines.at(-1) ?? "");
if (typeof parsed === "string" || parsed.verdict !== "approved")
  throw new Error("latest stamp is not approved");
const stampCommit = run(["log", "-1", "--format=%H", "--", stampsFile]).trim();
const parent = run(["rev-parse", `${stampCommit}^`]).trim();
const changedByStamp = run(["diff-tree", "--no-commit-id", "--name-only", "-r", stampCommit])
  .trim()
  .split("\n")
  .filter(Boolean);
if (changedByStamp.some((file) => file !== stampsFile))
  throw new Error("latest stamp commit changes more than the stamps log");
const branchBase = run(["merge-base", "origin/main", "HEAD"]).trim();
const branchPaths = run(["diff", "--name-only", `${branchBase}..HEAD`])
  .trim()
  .split("\n")
  .filter(Boolean);
const read = (rev: string, file: string): string =>
  rev === "WORKTREE"
    ? fs.readFileSync(path.join(root, file), "utf8")
    : run(["show", `${rev}:${file}`]);
const files = [...new Set([...branchPaths, "package.json", "CHANGELOG.md"])];
const reviewed: Record<string, string> = {};
const current: Record<string, string> = {};
for (const file of files) {
  try {
    reviewed[file] = read(parent, file);
  } catch {
    reviewed[file] = "";
  }
  try {
    current[file] = read("WORKTREE", file);
  } catch {
    current[file] = "";
  }
}
const digest = (): string => {
  const paths = run(["ls-tree", "-r", "--name-only", parent])
    .trim()
    .split("\n")
    .filter((file) => file && file !== stampsFile)
    .sort();
  const hash = createHash("sha256");
  for (const file of paths) {
    hash.update(`${file}\0`);
    hash.update(
      createHash("sha256")
        .update(run(["show", `${parent}:${file}`]))
        .digest("hex"),
    );
    hash.update("\0");
  }
  return hash.digest("hex");
};
const result = compareVersionFixup({
  reviewed,
  current,
  mainChangelog: run(["show", "origin/main:CHANGELOG.md"]),
  branchPaths,
  stampApproved: true,
  stampMatchesReviewed: parsed.treeDigest === digest(),
});
if (!result.ok) throw new Error(result.reason ?? "version fixup is not allowed");
console.log(
  "stamp fixup: approved stamp remains valid for the narrowly scoped version/changelog fixup",
);
