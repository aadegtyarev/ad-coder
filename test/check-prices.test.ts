import { describe, expect, test } from "bun:test";
import * as path from "node:path";

/**
 * COMMAND-level tests over the REAL script as a subprocess, against the
 * committed fixtures. The task's boundary: NO network in any of them, so every
 * run passes `--offline` and the public-list hint direction stays covered at
 * the comparator level (test/price-audit.test.ts). No assertion ever touches a
 * live fetch.
 *
 * Exit codes pinned here are the contract (docs/contracts/cost-anomaly.md):
 * 1 a finding (under-declared), 0 notes and hints included (over-declared must
 * NEVER block), 2 an explicitly requested `--charges` anchor could not be read.
 */

const SCRIPT = path.resolve(import.meta.dir, "../scripts/check-prices.ts");
const MODELS_CONFIG = "test/fixtures/check-prices.yaml";

function runCheckPrices(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
    cwd: path.resolve(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("check-prices: the provider's own charge answer is the verdict", () => {
  test("under-declared (billed x3.3530 and x1.6500): a FINDING naming the route and the ratio, exit 1", () => {
    const run = runCheckPrices([
      "--models-config",
      MODELS_CONFIG,
      "--charges",
      "test/fixtures/cost-anomaly-under-declared.json",
      "--offline",
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("");
    const findingLines = run.stdout.split("\n").filter((line) => line.startsWith("FINDING"));
    // One finding per under-declared route; never folded into a single vague line.
    expect(findingLines).toHaveLength(2);
    const deepseek = findingLines.find((line) => line.includes("deepseek/deepseek-v4-pro"));
    const glm = findingLines.find((line) => line.includes("z-ai/glm-5.3-flash"));
    expect(deepseek).toBeDefined();
    expect(glm).toBeDefined();
    // The ratio is named to 4 decimals, the row's declared values alongside it.
    expect(deepseek).toContain("UNDER-DECLARED");
    expect(deepseek).toContain("×3.3530");
    expect(deepseek).toContain("0.422298");
    expect(glm).toContain("UNDER-DECLARED");
    expect(glm).toContain("×1.6500");
  });

  test("over-declared (billed x0.8100): a NOTE, NO finding, exit 0 -- a discount never blocks", () => {
    const run = runCheckPrices([
      "--models-config",
      MODELS_CONFIG,
      "--charges",
      "test/fixtures/cost-anomaly-over-declared.json",
      "--offline",
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const lines = run.stdout.split("\n");
    expect(lines.some((line) => line.startsWith("FINDING"))).toBe(false);
    const note = lines.find((line) => line.startsWith("NOTE") && line.includes("OVER-DECLARED"));
    expect(note).toBeDefined();
    expect(note).toContain("openrouter:minimax/minimax-m3");
    expect(note).toContain("×0.8100");
    // The clean rows in the same record are still reported, not suppressed.
    expect(run.stdout).toContain("openrouter:deepseek/deepseek-v4-pro");
  });

  test("clean (every scope billed x1.0): exit 0, no findings, no notes", () => {
    const run = runCheckPrices([
      "--models-config",
      MODELS_CONFIG,
      "--charges",
      "test/fixtures/cost-anomaly-clean.json",
      "--offline",
    ]);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const lines = run.stdout.split("\n");
    expect(lines.some((line) => line.startsWith("FINDING"))).toBe(false);
    expect(lines.some((line) => line.startsWith("NOTE"))).toBe(false);
    // Each scope is reported as compared with its ratio and observation count.
    const okLines = lines.filter((line) => line.startsWith("ok"));
    expect(okLines).toHaveLength(3);
    expect(okLines.find((line) => line.includes("deepseek/deepseek-v4-pro"))).toContain("×1.0000");
  });

  test("unreadable/absent EXPLICIT charge record: the absence stated explicitly, exit 2", () => {
    // A version-1 file: not a readable version-2 charge record.
    const unreadable = runCheckPrices([
      "--models-config",
      MODELS_CONFIG,
      "--charges",
      "test/fixtures/cost-anomaly-unreadable.json",
      "--offline",
    ]);
    expect(unreadable.code).toBe(2);
    expect(unreadable.stdout).toContain("an anchor was requested and could not be read");
    expect(unreadable.stdout).toContain("cost-anomaly-unreadable.json");

    // A path that does not exist at all is the same contract: named, exit 2.
    const absent = runCheckPrices([
      "--models-config",
      MODELS_CONFIG,
      "--charges",
      "test/fixtures/cost-anomaly-missing.json",
      "--offline",
    ]);
    expect(absent.code).toBe(2);
    expect(absent.stdout).toContain("an anchor was requested and could not be read");
    expect(absent.stdout).toContain("does not exist");
  });

  test("--inventory is retired: refused BY NAME, with the replacement (issue #513)", () => {
    // The rename to `--models-config` is only half a contract; the other half
    // is that the old flag does not quietly keep working. Measured against a
    // parser that accepts BOTH names -- the compatibility mutation a later
    // "helpful" change would make -- this test goes red: the run then audits
    // the fixture and exits 0, which a pin on the new flag alone never sees.
    const retired = runCheckPrices(["--inventory", MODELS_CONFIG, "--offline"]);
    expect(retired.code).toBe(1);
    // It names the flag it refuses and the way forward, rather than leaving the
    // operator to diff two usage lines.
    expect(retired.stdout).toContain("no longer takes --inventory");
    expect(retired.stdout).toContain("--models-config");
  });

  test("--offline states that the public-list hint half was skipped by request", () => {
    const run = runCheckPrices([
      "--models-config",
      MODELS_CONFIG,
      "--charges",
      "test/fixtures/cost-anomaly-clean.json",
      "--offline",
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("offline: the public-list hint half was skipped by request");
    expect(run.stdout).toContain("the charge and self-consistency judgements still ran");
    // No hint lines exist at all: the hint half did not run, and nothing fetched.
    expect(run.stdout.split("\n").some((line) => line.startsWith("hint"))).toBe(false);
  });
});
