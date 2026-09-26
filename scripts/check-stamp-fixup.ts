import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { compareVersionFixup } from "../src/stamp/record-review-stamp";
import { isCoveredPath } from "../src/stamp/review-coverage";
import { foldTreeDigest, parseReviewStamp } from "../src/stamp/review-stamp";

const defaultRoot = path.resolve(import.meta.dir, "..");

type GitRun = (args: string[], historySpec?: string) => string;

function gitRunner(root: string): GitRun {
  return (args, historySpec) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      const detail = result.stderr.toString().trim() || `git ${args.join(" ")} failed`;
      if (historySpec !== undefined) {
        throw new Error(`history unavailable in this checkout: ${historySpec}; ${detail}`);
      }
      throw new Error(detail);
    }
    return result.stdout.toString();
  };
}

/** Check the ancestry that the fixup calculation cannot perform without. */
export function checkRequiredHistory(root: string): void {
  const run = gitRunner(root);
  const marker = JSON.parse(fs.readFileSync(path.join(root, "ad-coder.stamps.json"), "utf8")) as {
    file?: string;
  };
  const stampsFile = marker.file ?? "docs/reviews/stamps.log";
  const stampCommit = run(
    ["log", "-1", "--format=%H", "--", stampsFile],
    `the commit containing the latest ${stampsFile}`,
  ).trim();
  run(["rev-parse", `${stampCommit}^`], `parent revision ${stampCommit}^`).trim();
  run(["merge-base", "origin/main", "HEAD"], "merge-base of origin/main and HEAD").trim();
}

export function runStampFixup(root: string): void {
  const run = gitRunner(root);
  checkRequiredHistory(root);
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
  const changedByStamp = run(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", stampCommit],
    "stamp commit",
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (changedByStamp.some((file) => file !== stampsFile))
    throw new Error("latest stamp commit changes more than the stamps log");
  const branchBase = run(["merge-base", "origin/main", "HEAD"]).trim();
  const branchPaths = run(
    ["diff", "--name-only", `${branchBase}..HEAD`],
    "branch diff from origin/main to HEAD",
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const read = (rev: string, file: string): string =>
    rev === "WORKTREE"
      ? fs.readFileSync(path.join(root, file), "utf8")
      : run(["show", `${rev}:${file}`], `${rev}:${file}`);
  const files = [...new Set([...branchPaths, "package.json", "CHANGELOG.md"])] as string[];
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
    // Coverage-relative (issue #566): the digest recomputes under the STAMP's
    // OWN declared patterns -- shared fold and coverage helpers from
    // src/stamp, never a second implementation of "covered" -- and keeps the
    // pre-scope full tracked-tree meaning for stamps written before the
    // scope existed.
    const coverage = parsed.coverage;
    const paths = run(
      ["ls-tree", "-r", "--name-only", parent],
      `tree for parent revision ${parent}`,
    )
      .trim()
      .split("\n")
      .filter(
        (file) =>
          file && file !== stampsFile && (coverage === undefined || isCoveredPath(file, coverage)),
      )
      .sort();
    const entries = paths.map((file) => ({
      path: file,
      sha: createHash("sha256")
        .update(run(["show", `${parent}:${file}`], `${parent}:${file}`))
        .digest("hex"),
    }));
    return foldTreeDigest(entries);
  };
  const result = compareVersionFixup({
    reviewed,
    current,
    mainChangelog: run(["show", "origin/main:CHANGELOG.md"], "origin/main:CHANGELOG.md"),
    branchPaths,
    stampApproved: true,
    stampMatchesReviewed: parsed.treeDigest === digest(),
  });
  if (!result.ok) throw new Error(result.reason ?? "version fixup is not allowed");
  console.log(
    "stamp fixup: approved stamp remains valid for the narrowly scoped version/changelog fixup",
  );
}

if (import.meta.main) runStampFixup(process.env.STAMP_FIXUP_ROOT ?? defaultRoot);
