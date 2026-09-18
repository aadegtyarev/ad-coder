import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LedgerRecord } from "../src/ledger/types";
import { stampBodyCheckErrors, stampDeliveryText } from "../src/stamp/cli";
import { buildDeliverySignature, renderDeliverySignature } from "../src/stamp/delivery-signature";
import {
  checkReviewStamps,
  localIsoNow,
  readStampsMarker,
  recordReviewStampFromResult,
  STAMPS_MARKER_FILE,
} from "../src/stamp/record-review-stamp";
import {
  appendReviewStamp,
  computeTreeDigest,
  parseReviewStamp,
  REVIEW_STAMP_VERSION,
  renderReviewStamp,
} from "../src/stamp/review-stamp";

const USAGE = {
  input: 500,
  output: 40,
  cacheRead: 1200,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 1740,
  cost: { input: 0.01, output: 0.001, cacheRead: 0.002, cacheWrite: 0, total: 0.013 },
} as const;

function record(overrides: Partial<LedgerRecord> & { ts: number }): LedgerRecord {
  return {
    runId: "run-1",
    lane: "main",
    role: "coder",
    step: "turn:1",
    provider: "faux",
    model: "faux-1",
    stopReason: "toolUse",
    usage: { ...USAGE },
    ...overrides,
  };
}

test("the delivery signature carries tokens, cost, and per-role rows from ledger records", () => {
  const signature = buildDeliverySignature([
    record({ ts: 1, role: "coder", provider: "vendor", model: "big" }),
    record({ ts: 2, role: "coder", provider: "vendor", model: "big" }),
    record({ ts: 3, role: "reviewer", provider: "vendor", model: "small" }),
  ]);
  expect(signature.totalCalls).toBe(3);
  expect(signature.runIds).toEqual(["run-1"]);
  expect(signature.roles.find((row) => row.role === "reviewer")).toMatchObject({
    ran: true,
    calls: 1,
    provider: "vendor",
    model: "small",
  });
});

test("a role that never ran is named; a missing review never renders as a blank", () => {
  const text = renderDeliverySignature(buildDeliverySignature([record({ ts: 1 })]));
  expect(text).toContain("planner");
  expect(text).toContain("reviewer");
  expect((text.match(/did not run/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test("the rendered signature is compact: one header line plus one line per declared role", () => {
  const signature = buildDeliverySignature([record({ ts: 1 })]);
  const lines = renderDeliverySignature(signature).trimEnd().split("\n");
  expect(lines.length).toBe(1 + signature.roles.length);
});

test("the orchestrator lane is its own row: per-role calls and costs sum to the header", () => {
  const signature = buildDeliverySignature([
    record({ ts: 1, role: "orchestrator", provider: "vendor", model: "medium" }),
    record({ ts: 2, role: "orchestrator", provider: "vendor", model: "medium" }),
    record({ ts: 3, role: "planner", provider: "vendor", model: "big" }),
    record({ ts: 4, role: "coder", provider: "vendor", model: "small" }),
    record({ ts: 5, role: "reviewer", provider: "vendor", model: "small" }),
  ]);
  expect(signature.roles.find((row) => row.role === "orchestrator")).toMatchObject({
    ran: true,
    calls: 2,
    provider: "vendor",
    model: "medium",
  });
  const callsSum = signature.roles.reduce((sum, row) => sum + (row.calls ?? 0), 0);
  expect(callsSum).toBe(signature.totalCalls);
  const costSum = signature.roles.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  expect(costSum).toBeCloseTo(signature.totalCostUsd, 10);
});

test("a run without orchestrator records still renders the orchestrator row as did not run", () => {
  const text = renderDeliverySignature(buildDeliverySignature([record({ ts: 1 })]));
  const orchestratorLine = text.split("\n").find((line) => line.startsWith("orchestrator"));
  expect(orchestratorLine).toBeDefined();
  expect(orchestratorLine).toContain("did not run");
});

/** A minimal real git repo, so tree digests are computed the way the gate does. */
function gitRepo(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-stamps-")));
  const git = (argv: string[]): void => {
    const child = Bun.spawnSync(["git", ...argv], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  return root;
}

function stampFixture() {
  return {
    treeDigest: "replace-me-digest",
    base: "main",
    verdict: "approved" as const,
    reviewer: "vendor/small",
    reviewedAt: "2026-09-20T10:00:00+02:00",
    runIds: ["run-1"],
    findingsRef: "docs/reviews/stamps.log",
  };
}

test("a review stamp round-trips through render and parse", () => {
  const stamp = { ...stampFixture(), treeDigest: "a".repeat(64) };
  const rendered = renderReviewStamp(stamp);
  expect(rendered.startsWith(`${REVIEW_STAMP_VERSION} `)).toBe(true);
  expect(rendered.endsWith("\n")).toBe(true);
  expect(parseReviewStamp(rendered)).toEqual(stamp);
});

test("a stamp naming a digest no longer matching the tree is stale and must not pass", () => {
  const root = gitRepo();
  fs.writeFileSync(path.join(root, "f.txt"), "one\n");
  writeMarker(root, "stamps.log");
  addAll(root);
  const before = computeTreeDigest(root);
  expect(appendAndCheck(root, before).ok).toBe(true);

  // The cost of a stalled merge: the tree moved after the review -> stale.
  fs.writeFileSync(path.join(root, "f.txt"), "two\n");
  addAll(root);
  const after = computeTreeDigest(root);
  expect(after).not.toBe(before);
  // No new review, no new stamp: the old stamp must no longer pass.
  expect(checkReviewStamps(root).ok).toBe(false);
  expect(checkReviewStamps(root).errors[0]).toContain("stale");
});

function writeMarker(root: string, file: string): void {
  fs.writeFileSync(path.join(root, STAMPS_MARKER_FILE), JSON.stringify({ file }));
}

function addAll(root: string): void {
  const child = Bun.spawnSync(["git", "add", "-A"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
}

test("appending one more stamp line does not count as the tree moving", () => {
  const root = gitRepo();
  fs.writeFileSync(path.join(root, "f.txt"), "one\n");
  writeMarker(root, "stamps.log");
  addAll(root);
  const first = appendAndCheck(root, computeTreeDigest(root, ["stamps.log"]));
  expect(first.ok).toBe(true);
  appendAndCheck(root, computeTreeDigest(root, ["stamps.log"]));
  expect(checkReviewStamps(root).ok).toBe(true);
});

function appendAndCheck(root: string, digest: string): ReturnType<typeof checkReviewStamps> {
  appendReviewStamp(root, "stamps.log", { ...stampFixture(), treeDigest: digest });
  return checkReviewStamps(root);
}

test("a changes_requested verdict blocks the gate, and a fresh digest cannot excuse it", () => {
  const root = gitRepo();
  fs.writeFileSync(path.join(root, "f.txt"), "one\n");
  writeMarker(root, "stamps.log");
  const digest = computeTreeDigest(root);
  appendReviewStamp(root, "stamps.log", { ...stampFixture(), treeDigest: digest });
  fs.writeFileSync(path.join(root, "stamps.log"), ""); // isolate the second stamp
  appendReviewStamp(root, "stamps.log", {
    ...stampFixture(),
    treeDigest: digest,
    verdict: "changes_requested",
  });
  const verification = checkReviewStamps(root);
  expect(verification.ok).toBe(false);
  expect(verification.errors.join("\n")).toContain("changes_requested");
});

test("a malformed newest stamp fails the gate with the reason", () => {
  const root = gitRepo();
  fs.writeFileSync(path.join(root, "f.txt"), "one\n");
  fs.mkdirSync(path.join(root, "docs/reviews"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/reviews/stamps.log"), "garbage\n");
  expect(checkReviewStamps(root).ok).toBe(false);
});

test("the marker file opt-in: absent means off everywhere, malformed means blocked", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-stamps-off-")));
  expect(readStampsMarker(root)).toBeUndefined();
  const result = recordReviewStampFromResult(root, settledResult());
  expect(result.recorded).toBe(false);
  expect(result.skippedBecause).toContain("not a stamp-writing repository");

  fs.writeFileSync(path.join(root, STAMPS_MARKER_FILE), "not json");
  expect(() => readStampsMarker(root)).toThrow(STAMPS_MARKER_FILE);
});

test("the settle hook stamps an approved run and refuses to certify a review-less run", () => {
  const withMarker = gitRepo();
  fs.writeFileSync(
    path.join(withMarker, STAMPS_MARKER_FILE),
    JSON.stringify({ file: "docs/reviews/stamps.log" }),
  );
  const recorded = recordReviewStampFromResult(withMarker, settledResult());
  expect(recorded.recorded).toBe(true);
  const text = fs.readFileSync(path.join(withMarker, "docs/reviews/stamps.log"), "utf8");
  const parsed = parseReviewStamp(text.trimEnd().split("\n").at(-1) ?? "");
  if (typeof parsed === "string") throw new Error(parsed);
  expect(parsed.verdict).toBe("approved");
  expect(parsed.treeDigest).toBe(computeTreeDigest(withMarker));
  expect(parsed.reviewer).toMatch(/faux\/model/);

  const reviewless = gitRepo();
  fs.writeFileSync(path.join(reviewless, STAMPS_MARKER_FILE), JSON.stringify({}));
  const skipped = recordReviewStampFromResult(reviewless, {
    ...settledResult(),
    reviewRan: false,
  });
  expect(skipped.recorded).toBe(false);
  expect(skipped.skippedBecause).toContain("without a review round");
});

test("body-check passes when the body carries the freshly rendered delivery block", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-body-check-")));
  try {
    const ledger = path.join(dir, "ledger.jsonl");
    fs.writeFileSync(
      ledger,
      `${JSON.stringify(record({ ts: 1, role: "coder", provider: "vendor", model: "big" }))}\n` +
        `${JSON.stringify(record({ ts: 2, role: "reviewer", provider: "vendor", model: "small" }))}\n`,
    );
    const body = path.join(dir, "body.md");
    const block = stampDeliveryText(dir, [ledger]);
    fs.writeFileSync(body, `## Delivery\n\nSome prose around it.\n\n${block}End.\n`);
    expect(stampBodyCheckErrors(body, dir, [ledger])).toEqual([]);
    // One trailing-newline difference around the block is tolerated.
    fs.writeFileSync(body, `pre\n${block.trimEnd()}\npost\n`);
    expect(stampBodyCheckErrors(body, dir, [ledger])).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("body-check fails with the absent error when the body carries no block", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-body-absent-")));
  try {
    const ledger = path.join(dir, "ledger.jsonl");
    fs.writeFileSync(ledger, `${JSON.stringify(record({ ts: 1 }))}\n`);
    const body = path.join(dir, "body.md");
    fs.writeFileSync(body, "## Delivery\n\nNo cost block here at all.\n");
    const errors = stampBodyCheckErrors(body, dir, [ledger]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("the generated delivery block is absent");
    expect(errors[0]).toContain(body);
    expect(errors[0]).toContain("ad-coder stamp delivery");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("body-check fails with the stale error when the body block differs from the ledger", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-body-stale-")));
  try {
    const ledger = path.join(dir, "ledger.jsonl");
    fs.writeFileSync(ledger, `${JSON.stringify(record({ ts: 1 }))}\n`);
    const body = path.join(dir, "body.md");
    // A block-shaped `runs ` header whose totals no longer match the ledger:
    // the classic stale paste after more ledger lines landed.
    fs.writeFileSync(
      body,
      "runs run-1 | calls=99 | cost=$999.000000 | tokens fresh=0 cached=0 out=0\n" +
        "coder     vendor/small                     calls=1   cost=$0.010000\n",
    );
    const errors = stampBodyCheckErrors(body, dir, [ledger]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("the delivery block is stale");
    expect(errors[0]).toContain("ad-coder stamp delivery");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function settledResult() {
  return {
    outcome: "approved",
    approved: true,
    rounds: 1,
    verdicts: [{ status: "approved", issues: [], summary: "ok" }],
    runIds: ["run-a", "run-b"],
    stageMetrics: [
      {
        stage: "review:1",
        provider: "faux",
        model: "model",
        input: 0,
        cachedInput: 0,
        freshInput: 0,
        output: 0,
        requestBytes: { systemPrompt: 0, prompt: 0, toolDefinitions: 0, total: 0 },
        readFiles: [],
        readFilesTotal: 0,
        readFilesTruncated: 0,
        diffBytes: 0,
      },
    ],
    reviewRan: true,
  } as unknown as import("../src/orchestration/types").PipelineResult;
}

test("reviewedAt is ISO-8601 with the machine's own local offset", () => {
  const iso = localIsoNow(new Date(2026, 8, 20, 10, 0));
  expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test("a malformed stamp line is a parse error, never a throw", () => {
  expect(typeof parseReviewStamp("")).toBe("string");
  expect(typeof parseReviewStamp("random text")).toBe("string");
  expect(typeof parseReviewStamp(`${REVIEW_STAMP_VERSION} digest:${"a".repeat(64)}`)).toBe(
    "string",
  );
});

test("a standalone reviewer run stamps through the same writer as the pipeline", () => {
  // The stamp never needed a pipeline -- only a review that produced a
  // structured verdict (issue #283). Before this, `role reviewer` could return a
  // real verdict and had no way to record it: the gate demanded paperwork the
  // cheap path could not produce, which teaches stepping around the gate.
  const root = gitRepo();
  fs.writeFileSync(path.join(root, STAMPS_MARKER_FILE), JSON.stringify({}));
  const recorded = recordReviewStampFromResult(root, {
    approved: false,
    runIds: ["standalone-run"],
    stageMetrics: [{ stage: "review:1", provider: "opencode-go", model: "glm-5.3-flash" }],
    reviewRan: true,
  });
  expect(recorded.recorded).toBe(true);
  const line = fs
    .readFileSync(path.join(root, "docs/reviews/stamps.log"), "utf8")
    .trimEnd()
    .split("\n")
    .at(-1);
  const parsed = parseReviewStamp(line ?? "");
  if (typeof parsed === "string") throw new Error(parsed);
  // `changes_requested` stamps too: "the reviewer said no" is a fact the gate
  // should read, not re-derive from prose.
  expect(parsed.verdict).toBe("changes_requested");
  expect(parsed.reviewer).toBe("opencode-go/glm-5.3-flash");
  expect(parsed.runIds).toEqual(["standalone-run"]);
});
