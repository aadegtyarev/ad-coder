/**
 * Round-tree integrity (issue #570 follow-up): a review stamp must never
 * certify a tree the review round itself modified. The round's tree is
 * captured (covered-path digest manifest) at the START of the round; the
 * settle that writes the stamp refuses, naming the moved paths, when the tree
 * moved since -- whether the mover was an unreported perturbation (the defect
 * that started this) or a restore that missed a byte. An unchanged round, a
 * byte-identical restore, and the stamp write itself all still stamp.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  captureReviewedTreeForRound,
  localIsoNow,
  REVIEW_TREE_CAPTURE_SCHEMA_VERSION,
  REVIEW_TREE_MOVED_ACTION,
  type ReviewedTreeCaptureValue,
  ReviewedTreeMovedError,
  readReviewedTreeCapture,
  recordReviewStampFromResult,
  reviewedTreeMovedMessage,
  reviewTreeCaptureRef,
  STAMPS_MARKER_FILE,
} from "../src/stamp/record-review-stamp";
import { computeTreeDigest, movedTreePaths } from "../src/stamp/review-stamp";
import { VERDICT_FINDINGS_ID_PATTERN } from "../src/stamp/verdict-findings";

/** A git repo with the stamp marker, a TRACKED code file, and a clean index. */
function gitRepoWithTrackedCode(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-round-tree-")));
  const git = (argv: string[]): void => {
    const child = Bun.spawnSync(["git", ...argv], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(root, STAMPS_MARKER_FILE), "{}\n");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "code.ts"), "export const x = 1;\n");
  git(["add", "src/code.ts", STAMPS_MARKER_FILE]);
  git(["commit", "-q", "-m", "base"]);
  return root;
}

/** The standard settled reviewer outcome for `runId` over the fixture. */
function settledReview(runId: string): Parameters<typeof recordReviewStampFromResult>[1] {
  return {
    approved: true,
    runIds: [runId],
    stageMetrics: [{ stage: "review:1", provider: "faux", model: "m1" }],
    reviewRan: true,
    verdicts: [{ status: "approved", issues: [], summary: "ok" }],
  };
}

test("captureReviewedTreeForRound recovers the capture at a ref under the runs store", () => {
  const root = gitRepoWithTrackedCode();
  try {
    const ref = captureReviewedTreeForRound(root, "round-run-1", "auto");
    expect(ref).toBe(".ad-coder/runs/review-tree-round-run-1.json");
    expect(fs.existsSync(path.join(root, ref ?? ""))).toBe(true);
    const read = readReviewedTreeCapture(root, ["round-run-1"]);
    if (read === undefined) throw new Error("capture not found");
    expect(read.value.runId).toBe("round-run-1");
    expect(read.value.schemaVersion).toBe(REVIEW_TREE_CAPTURE_SCHEMA_VERSION);
    expect(read.value.capturedAt).toMatch(localIsoNow(new Date()).slice(0, 10));
    expect(read.value.digest).toBe(computeTreeDigest(root));
    const entry = Object.keys(read.value.coveredPaths);
    expect(entry).toContain("src/code.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a round whose tree stayed unchanged stamps exactly as before", () => {
  const root = gitRepoWithTrackedCode();
  try {
    captureReviewedTreeForRound(root, "run", "auto");
    const recorded = recordReviewStampFromResult(root, settledReview("run"));
    expect(recorded.recorded).toBe(true);
    const line = fs
      .readFileSync(path.join(root, "docs/reviews/stamps.log"), "utf8")
      .trimEnd()
      .split("\n")
      .at(-1);
    expect(line).toContain("verdict:approved");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a perturbation restored BYTE-IDENTICALLY still stamps, and the restore is proven real", () => {
  const root = gitRepoWithTrackedCode();
  const codePath = path.join(root, "src", "code.ts");
  const original = fs.readFileSync(codePath);
  const originalCopy = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-orig-")),
    "code.ts",
  );
  fs.writeFileSync(originalCopy, original);
  try {
    captureReviewedTreeForRound(root, "run", "auto");
    // Perturb, observe, restore byte-identically.
    fs.writeFileSync(codePath, "export const x = 2;\n");
    expect(computeTreeDigest(root)).not.toBe(readTreeDigest(root, "run"));
    fs.writeFileSync(codePath, original);
    expect(spawnSync("cmp", ["-s", codePath, originalCopy]).status).toBe(0);
    // Nothing of the round's own sits in the tracked tree: the capture and the
    // store live outside the covered set, never inside a tracked status line.
    expect(
      Bun.spawnSync(["git", "status", "--porcelain", "src"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      }).stdout.toString(),
    ).toBe("");
    const recorded = recordReviewStampFromResult(root, settledReview("run"));
    expect(recorded.recorded).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The captured digest for `runId` (throwing helper for the assertions above). */
function readTreeDigest(root: string, runId: string): string {
  const read = readReviewedTreeCapture(root, [runId]);
  if (read === undefined) throw new Error("missing capture");
  return read.value.digest;
}

test("a round that left its perturbation is REFUSED, names the moved paths, and writes nothing", () => {
  const root = gitRepoWithTrackedCode();
  const stampLog = path.join(root, "docs/reviews/stamps.log");
  try {
    captureReviewedTreeForRound(root, "run", "auto");
    fs.writeFileSync(path.join(root, "src", "code.ts"), "export const x = 1.23456;\n");
    let error: ReviewedTreeMovedError | undefined;
    try {
      recordReviewStampFromResult(root, settledReview("run"));
    } catch (caught) {
      if (caught instanceof ReviewedTreeMovedError) error = caught;
      else throw caught;
    }
    if (error === undefined) throw new Error("expected a ReviewedTreeMovedError");
    expect(error.message).toContain("src/code.ts");
    expect(error.message).toContain(REVIEW_TREE_MOVED_ACTION);
    expect(error.code).toBe("reviewed_tree_moved");
    expect(error.nextAction).toBe(REVIEW_TREE_MOVED_ACTION);
    expect(error.captureRef).toBe(reviewTreeCaptureRef("run"));
    // Nothing was appended: the refusal happens BEFORE the append.
    expect(fs.existsSync(stampLog)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted covered path is a move; an untracked NEW file is not", () => {
  const root = gitRepoWithTrackedCode();
  try {
    const before = { "a.ts": "h1", "b.ts": "h2" };
    const after = { "a.ts": "h1", "new.ts": "h3" };
    expect(movedTreePaths(before, after)).toEqual(["b.ts", "new.ts"]);
    // Untracked files never enter the covered set, so a settle writes its
    // findings artifact and stamp records without invalidating the gate.
    captureReviewedTreeForRound(root, "run", "auto");
    fs.writeFileSync(path.join(root, "untracked.txt"), "only stored state\n");
    const recorded = recordReviewStampFromResult(root, settledReview("run"));
    expect(recorded.recorded).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the stamp log itself stays excluded: appending the stamp cannot refuse its own write", () => {
  const root = gitRepoWithTrackedCode();
  const stampLog = path.join(root, "docs/reviews/stamps.log");
  try {
    // A capture taken WITH the log already on record (so the manifest existed
    // while the log was tracked-but-excluded) must not see the append as a move.
    fs.mkdirSync(path.dirname(stampLog), { recursive: true });
    fs.writeFileSync(stampLog, "review-stamp-v1 old\n");
    Bun.spawnSync(["git", "add", "docs/reviews/stamps.log"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    captureReviewedTreeForRound(root, "run", "auto");
    fs.appendFileSync(stampLog, "review-stamp-v1 appended by the settle\n");
    const recorded = recordReviewStampFromResult(root, settledReview("run"));
    expect(recorded.recorded).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the capture is never re-anchored: a second call for the SAME round keeps the original", () => {
  const root = gitRepoWithTrackedCode();
  try {
    const first = captureReviewedTreeForRound(root, "run", "auto");
    fs.writeFileSync(path.join(root, "src", "code.ts"), "export const x = 2;\n");
    const second = captureReviewedTreeForRound(root, "run", "auto");
    expect(second).toBe(first);
    const read = readReviewedTreeCapture(root, ["run"]);
    if (read === undefined) throw new Error("missing capture");
    expect(read.value.digest).toBe(readTreeDigest(root, "run"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a later round's capture supersedes an earlier round's (run order decides)", () => {
  const root = gitRepoWithTrackedCode();
  try {
    captureReviewedTreeForRound(root, "round-1", "auto");
    fs.writeFileSync(path.join(root, "src", "code.ts"), "export const x = 2;\n");
    captureReviewedTreeForRound(root, "round-2", "auto");
    expect(readReviewedTreeCapture(root, ["round-1", "round-2"])?.value.runId).toBe("round-2");
    // A run id that never captured reads through to its newest capturing ancestor.
    expect(readReviewedTreeCapture(root, ["round-2", "later-run"])?.value.runId).toBe("round-2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt capture fails LOUD, never silently ungates the stamp", () => {
  const root = gitRepoWithTrackedCode();
  try {
    fs.mkdirSync(path.join(root, ".ad-coder", "runs"), { recursive: true });
    fs.writeFileSync(path.join(root, reviewTreeCaptureRef("run")), "{ broken");
    expect(() => readReviewedTreeCapture(root, ["run"])).toThrow("unreadable review-tree capture");
    fs.writeFileSync(
      path.join(root, reviewTreeCaptureRef("run")),
      JSON.stringify({ version: 1, value: { schemaVersion: 999, digest: "d", coveredPaths: {} } }),
    );
    expect(() => recordReviewStampFromResult(root, settledReview("run"))).toThrow(
      /malformed review-tree capture at .ad-coder\/runs\/review-tree-run.json -- restore it/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-upgrade round with no capture still stamps as before", () => {
  const root = gitRepoWithTrackedCode();
  try {
    const recorded = recordReviewStampFromResult(root, settledReview("legacy-run"));
    expect(recorded.recorded).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a run id that cannot be a store ref is refused at the capture seam", () => {
  expect(() => reviewTreeCaptureRef("../escape")).toThrow("must match");
  // Stamps OFF skips the gate before the ref is even validated.
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bad-id-")));
  try {
    Bun.spawnSync(["git", "init", "-q", bare], { stdout: "pipe", stderr: "pipe" });
    expect(captureReviewedTreeForRound(bare, "../escape", "off")).toBeUndefined();
    // Stamps ON must never accept an unembeddable run id.
    expect(() => captureReviewedTreeForRound(bare, "../escape", "on")).toThrow("must match");
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test("with stamps off the capture pays nothing and no refusal can fire", () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-stamps-off2-")));
  try {
    Bun.spawnSync(["git", "init", "-q", bare], { stdout: "pipe", stderr: "pipe" });
    const ref = captureReviewedTreeForRound(bare, "run", "auto");
    expect(ref).toBeUndefined();
    const recorded = recordReviewStampFromResult(bare, settledReview("run"));
    expect(recorded.recorded).toBe(false);
    expect(recorded.skippedBecause).toContain("not a stamp-writing repository");
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test("the refusal message bounds the list and spells the recovery once", () => {
  const many = Array.from({ length: 25 }, (_, index) => `src/file${index}.ts`);
  const message = reviewedTreeMovedMessage(many);
  expect(
    message.startsWith("the review round modified the tree under review: src/file0.ts, "),
  ).toBe(true);
  expect(message).toContain("(+5 more)");
  expect(message).toContain("-- a stamp would certify a tree that is not the reviewed change; ");
  expect(message).toContain(REVIEW_TREE_MOVED_ACTION);
  // One line: the front prints it verbatim.
  expect(message.split("\n")).toHaveLength(1);
});

test("the id seam is the runs-store's own validated pattern", () => {
  expect(reviewTreeCaptureRef("x")).toBe(".ad-coder/runs/review-tree-x.json");
  expect(VERDICT_FINDINGS_ID_PATTERN.test("review-tree-1@2")).toBe(false);
  const value: ReviewedTreeCaptureValue = {
    schemaVersion: REVIEW_TREE_CAPTURE_SCHEMA_VERSION,
    runId: "run",
    digest: "d",
    coveredPaths: { "a.ts": "h" },
    capturedAt: localIsoNow(new Date(2026, 8, 25, 10, 0)),
  };
  expect(value.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});
