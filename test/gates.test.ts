import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GateRunner } from "../src/gates/runner";
import type { CommandExecutor, ExecResult, QualityGate } from "../src/gates/types";

const scratchFiles: string[] = [];

afterAll(() => {
  for (const file of scratchFiles) fs.rmSync(file, { force: true });
});

/** Write a temp file with `lineCount` lines and register it for cleanup. */
function tempFileWithLines(label: string, lineCount: number): string {
  const file = path.join(
    os.tmpdir(),
    `ad-coder-gates-${label}-${Math.random().toString(36).slice(2, 10)}.txt`,
  );
  // `lineCount` lines each newline-terminated, so countLines() sees exactly
  // `lineCount` logical lines.
  fs.writeFileSync(
    file,
    `${Array.from({ length: lineCount }, (_, i) => `line ${i}`).join("\n")}\n`,
  );
  scratchFiles.push(file);
  return file;
}

/**
 * A scripted executor: returns each queued ExecResult in turn and records every
 * argv it was handed, so tests can assert ordering and discrete-argv shape.
 */
function scriptedExecutor(results: ExecResult[]): {
  executor: CommandExecutor;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const executor: CommandExecutor = async (argv) => {
    calls.push(argv);
    const result = results[i];
    i += 1;
    if (result === undefined) {
      throw new Error(`scriptedExecutor: no queued result for call ${i}`);
    }
    return result;
  };
  return { executor, calls };
}

function ok(stdout = "", stderr = ""): ExecResult {
  return { exitCode: 0, stdout, stderr };
}

test("a passing external gate captures output and passes", async () => {
  const { executor } = scriptedExecutor([ok("all good")]);
  const runner = new GateRunner({ executor });
  const gate: QualityGate = { name: "lint", kind: "lint", command: ["eslint"] };
  const report = await runner.run([gate], ["src/a.ts"]);
  expect(report.passed).toBe(true);
  expect(report.results[0]?.passed).toBe(true);
  expect(report.results[0]?.output).toContain("all good");
});

test("a failing external gate fails and surfaces its stderr", async () => {
  const { executor } = scriptedExecutor([{ exitCode: 2, stdout: "", stderr: "boom: bad code" }]);
  const runner = new GateRunner({ executor });
  const gate: QualityGate = { name: "lint", kind: "lint", command: ["eslint"] };
  const report = await runner.run([gate], ["src/a.ts"]);
  expect(report.passed).toBe(false);
  expect(report.results[0]?.passed).toBe(false);
  expect(report.results[0]?.output).toContain("boom: bad code");
});

test("autofix argv runs before the check argv, and paths are discrete argv entries", async () => {
  const { executor, calls } = scriptedExecutor([
    ok("fixed"), // autofix
    ok("clean"), // check
  ]);
  const runner = new GateRunner({ executor });
  const gate: QualityGate = {
    name: "format",
    kind: "format",
    autofix: ["prettier", "--write"],
    command: ["prettier", "--check"],
  };
  const report = await runner.run([gate], ["src/a.ts", "src/b.ts"]);
  expect(report.passed).toBe(true);
  // Autofix first, then check.
  expect(calls[0]).toEqual(["prettier", "--write", "src/a.ts", "src/b.ts"]);
  expect(calls[1]).toEqual(["prettier", "--check", "src/a.ts", "src/b.ts"]);
  // Paths are discrete trailing elements, never a concatenated string.
  expect(calls[1]).toContain("src/a.ts");
  expect(calls[1]).toContain("src/b.ts");
  for (const argv of calls) {
    for (const el of argv) {
      expect(el).not.toContain(" src/");
    }
  }
});

test("the in-process size gate names an over-limit file and its exact line count", async () => {
  const bigFile = tempFileWithLines("big", 12);
  const { executor, calls } = scriptedExecutor([]);
  const runner = new GateRunner({ executor });
  const gate: QualityGate = { name: "size", kind: "size", maxLinesPerFile: 10 };
  const report = await runner.run([gate], [bigFile]);
  expect(report.passed).toBe(false);
  expect(report.results[0]?.output).toContain(`${bigFile}: 12 lines exceeds max 10`);
  // The size gate never touches the executor.
  expect(calls.length).toBe(0);
});

test("the size gate passes a file under the limit", async () => {
  const smallFile = tempFileWithLines("small", 3);
  const { executor } = scriptedExecutor([]);
  const runner = new GateRunner({ executor });
  const gate: QualityGate = { name: "size", kind: "size", maxLinesPerFile: 10 };
  const report = await runner.run([gate], [smallFile]);
  expect(report.passed).toBe(true);
  expect(report.results[0]?.output).toBe("");
});

test("output is bounded by maxOutputChars and carries a truncation marker", async () => {
  const flood = "x".repeat(50_000);
  const { executor } = scriptedExecutor([ok(flood)]);
  const runner = new GateRunner({ executor, maxOutputChars: 100 });
  const gate: QualityGate = { name: "lint", kind: "lint", command: ["eslint"] };
  const report = await runner.run([gate], ["src/a.ts"]);
  const output = report.results[0]?.output ?? "";
  expect(output.length).toBeLessThan(200);
  expect(output).toContain("truncated 100 of 50000 chars");
});

test("a rejecting executor fails only that gate, not the whole report", async () => {
  const executor: CommandExecutor = async () => {
    throw new Error("spawn eslint ENOENT");
  };
  const runner = new GateRunner({ executor });
  const gates: QualityGate[] = [
    { name: "lint", kind: "lint", command: ["eslint"] },
    { name: "size", kind: "size", maxLinesPerFile: 10 },
  ];
  const sizeOkFile = tempFileWithLines("resilient", 3);
  const report = await runner.run(gates, [sizeOkFile]);
  expect(report.passed).toBe(false);
  expect(report.results[0]?.passed).toBe(false);
  expect(report.results[0]?.output).toContain("lint");
  expect(report.results[0]?.output).toContain("ENOENT");
  // The unrelated size gate still runs and passes.
  expect(report.results[1]?.passed).toBe(true);
});

test("a size gate on a missing file fails that gate instead of throwing", async () => {
  const { executor } = scriptedExecutor([]);
  const runner = new GateRunner({ executor });
  const gate: QualityGate = { name: "size", kind: "size", maxLinesPerFile: 10 };
  const missing = path.join(os.tmpdir(), `ad-coder-gates-missing-${Math.random()}.txt`);
  const report = await runner.run([gate], [missing]);
  expect(report.passed).toBe(false);
  expect(report.results[0]?.passed).toBe(false);
  expect(report.results[0]?.output).toContain("size");
});

test("a multi-gate report names exactly the failing gate", async () => {
  const { executor } = scriptedExecutor([
    ok("clean"), // gate 1: pass
    { exitCode: 1, stdout: "", stderr: "type error" }, // gate 2: fail
    ok("clean"), // gate 3: pass
  ]);
  const runner = new GateRunner({ executor });
  const gates: QualityGate[] = [
    { name: "format", kind: "format", command: ["prettier", "--check"] },
    { name: "types", kind: "typecheck", command: ["tsc", "--noEmit"] },
    { name: "lint", kind: "lint", command: ["eslint"] },
  ];
  const report = await runner.run(gates, ["src/a.ts"]);
  expect(report.passed).toBe(false);
  const failed = report.results.filter((r) => !r.passed);
  expect(failed.map((r) => r.name)).toEqual(["types"]);
  expect(report.results.filter((r) => r.passed).map((r) => r.name)).toEqual(["format", "lint"]);
});
