/**
 * The stamp gates' CLI failure path (issue #425).
 *
 * A gate failure is a FACT -- the newest verdict or a digest mismatch -- not a
 * usage mistake, so NEITHER front may render the derived help, and the machine
 * front's error code must be `gate_failed`, never `usage`. Argument errors
 * (unknown flag, unknown action, extra path) keep the usage path: the derived
 * help on stderr and the `usage` code, exactly as every other command.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeTreeDigest } from "../src/stamp/review-stamp";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(REPO_ROOT, "src/cli.ts");
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-stamp-gate-cli-"));

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real CLI `stamp <args...>`, with a private config home. */
function runStamp(args: string[]): RunResult {
  const proc = Bun.spawnSync(["bun", "run", CLI, "stamp", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, XDG_CONFIG_HOME: CONFIG_HOME },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function stampCheck(targetDir: string, ...extra: string[]): RunResult {
  return runStamp(["check", "--target-dir", targetDir, ...extra]);
}

function stampBodyCheck(
  targetDir: string,
  bodyPath: string,
  ledgerPath: string,
  extra: string[] = [],
): RunResult {
  return runStamp(["body-check", bodyPath, ledgerPath, "--target-dir", targetDir, ...extra]);
}

/** A git repo carrying the stamp marker, with one stamp naming a stale digest. */
function stamptedRepoWith(stampLine: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-stamp-gate-")));
  fs.writeFileSync(path.join(dir, "ad-coder.stamps.json"), "{}\n");
  const child = Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  fs.mkdirSync(path.join(dir, "docs/reviews"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs/reviews/stamps.log"), stampLine);
  return dir;
}

function staleStampRepo(): string {
  return stamptedRepoWith(
    `review-stamp-v1 digest:${"a".repeat(64)} base:main verdict:approved reviewer:vendor/tiny reviewedAt:2026-01-01T00:00:00+04:00 findings:-\n`,
  );
}

const RECOVERY = "ask an independent reviewer";

test("stamp check with a stale stamp: human stderr names the action, never the help", () => {
  const dir = staleStampRepo();
  try {
    const result = stampCheck(dir);
    expect(result.code).toBe(2);
    expect(result.stderr.startsWith("ad-coder: stamp is stale: ")).toBe(true);
    // The reason names what is stale; the action names how to clear it.
    expect(result.stderr).toContain(RECOVERY);
    expect(result.stderr).toContain("the tree moved after the review");
    expect(result.stderr).toContain("package.json");
    // No help dump: neither the root usage nor the Arguments block.
    expect(result.stderr).not.toContain("usage: ad-coder");
    expect(result.stderr).not.toContain("Arguments:");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stamp check with a stale stamp: machine front gets gate_failed with the action", () => {
  const dir = staleStampRepo();
  try {
    const result = stampCheck(dir, "--json");
    expect(result.code).toBe(2);
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; text: string; nextAction: string; retryable: boolean };
    };
    expect(parsed.error.code).not.toBe("usage");
    expect(parsed.error.code).toBe("gate_failed");
    expect(parsed.error.text).toContain("stamp is stale");
    expect(parsed.error.nextAction).toContain(RECOVERY);
    expect(parsed.error.retryable).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stamp check with a changes_requested verdict: reason and action on both fronts", () => {
  const dir = staleStampRepo();
  try {
    // Same digest, disapproving verdict: the verdict alone must block.
    const digest = computeTreeDigest(dir, ["docs/reviews/stamps.log"]);
    fs.writeFileSync(
      path.join(dir, "docs/reviews/stamps.log"),
      `review-stamp-v1 digest:${digest} base:main verdict:changes_requested reviewer:vendor/tiny reviewedAt:2026-01-01T00:00:00+04:00 findings:-\n`,
    );
    const result = stampCheck(dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("the newest review verdict is changes_requested");
    expect(result.stderr).toContain(RECOVERY);
    expect(result.stderr).not.toContain("usage: ad-coder");
    const machine = stampCheck(dir, "--json");
    const parsed = JSON.parse(machine.stderr) as {
      error: { code: string; text: string; nextAction: string };
    };
    expect(parsed.error.code).toBe("gate_failed");
    expect(parsed.error.text).toContain("changes_requested");
    expect(parsed.error.nextAction).toContain(RECOVERY);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stamp body-check on a blockless body: reason and action on both fronts", () => {
  const dir = staleStampRepo();
  try {
    const body = path.join(dir, "body.md");
    fs.writeFileSync(body, "## Delivery\n\nNo block here.\n");
    const ledger = path.join(dir, "ledger.jsonl");
    fs.writeFileSync(ledger, "");
    const human = stampBodyCheck(dir, body, ledger);
    expect(human.code).toBe(2);
    expect(human.stderr).toContain("the generated delivery form is absent");
    expect(human.stderr).toContain("runs=");
    expect(human.stderr).toContain("ad-coder stamp delivery");
    expect(human.stderr).not.toContain("usage: ad-coder");
    const machine = stampBodyCheck(dir, body, ledger, ["--json"]);
    const parsed = JSON.parse(machine.stderr) as { error: { code: string; nextAction: string } };
    expect(parsed.error.code).toBe("gate_failed");
    expect(parsed.error.nextAction).toContain("ad-coder stamp delivery");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stamp delivery and body-check report an omitted target ledger as usage on both fronts", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-stamp-no-ledger-")));
  try {
    const expected = `no ledger files exist under ${path.join(dir, ".ad-coder", "ledger")}/`;
    const delivery = runStamp(["delivery", "--target-dir", dir]);
    expect(delivery.code).toBe(2);
    expect(delivery.stdout).toBe("");
    expect(delivery.stderr).toContain(expected);
    expect(delivery.stderr).toContain("usage: ad-coder");

    const deliveryJson = runStamp(["delivery", "--target-dir", dir, "--json"]);
    expect(deliveryJson.code).toBe(2);
    expect(deliveryJson.stderr).not.toContain("usage: ad-coder");
    expect(JSON.parse(deliveryJson.stderr).error).toEqual({ code: "usage", detail: expected });

    const body = path.join(dir, "body.md");
    fs.writeFileSync(body, "## Delivery\n");
    const bodyCheck = runStamp(["body-check", body, "--target-dir", dir]);
    expect(bodyCheck.code).toBe(2);
    expect(bodyCheck.stderr).toContain(expected);
    expect(bodyCheck.stderr).toContain("usage: ad-coder");

    const bodyCheckJson = runStamp(["body-check", body, "--target-dir", dir, "--json"]);
    expect(bodyCheckJson.code).toBe(2);
    expect(bodyCheckJson.stderr).not.toContain("usage: ad-coder");
    expect(JSON.parse(bodyCheckJson.stderr).error).toEqual({ code: "usage", detail: expected });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("argument errors keep the usage path: help on stderr and the usage code", () => {
  const dir = staleStampRepo();
  try {
    // An unknown flag is still a usage error: the human front gets the help,
    // the --json front gets the machine shape -- but the code is `usage` and
    // never `gate_failed`, so a caller cannot confuse the two.
    const bogusFlagHuman = runStamp(["check", "--no-such-flag"]);
    expect(bogusFlagHuman.code).toBe(2);
    expect(bogusFlagHuman.stderr).toContain("usage: ad-coder");
    const bogusFlagJson = runStamp(["check", "--no-such-flag", "--json"]);
    expect(bogusFlagJson.code).toBe(2);
    expect(JSON.parse(bogusFlagJson.stderr).error.code).toBe("usage");
    const bogusAction = runStamp(["no-such-action", "--target-dir", dir]);
    expect(bogusAction.code).toBe(2);
    expect(bogusAction.stderr).toContain("usage: ad-coder");
    expect(bogusAction.stderr).not.toContain("gate_failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
