import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  aggregateLedgerRecords,
  parseLedgerLine,
  readLedgerFiles,
  readLedgerRecords,
  renderLedgerReport,
} from "../src/ledger/analytics";
import type { LedgerRecord } from "../src/ledger/types";

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

test("a real-shaped ledger line parses into the record type", () => {
  const line = record({ ts: 100, toolCalls: { bash: 2 } });
  expect(parseLedgerLine(JSON.stringify(line))).toEqual(line);
});

test("a truncated or malformed line is skipped, never thrown", () => {
  // The shape of a file a live run is still appending, read mid-write.
  const good = JSON.stringify(record({ ts: 1 }));
  const file = path.join(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-ledger-"))),
    "run.jsonl",
  );
  fs.writeFileSync(
    file,
    `${good}\n\n{"ts":100,"runId":"trunca${good.slice(20)}`, // truncated tail, no newline
  );
  const report = readLedgerFiles([file]);
  expect(report.recordsRead).toBe(1);
  expect(report.skippedLines).toBe(1);
  expect(report.files[0]?.skippedLines).toBe(1);
  expect(report.total.modelCalls).toBe(1);
});

test("readLedgerRecords returns the rows themselves with the same skip accounting", () => {
  // The resume path needs the records (to seed a readable sink), not a report.
  const file = path.join(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-ledger-"))),
    "run.jsonl",
  );
  const good = JSON.stringify(record({ ts: 1 }));
  fs.writeFileSync(file, `${good}\n\n{"ts":100,"runId":"trunca${good.slice(20)}`);
  const read = readLedgerRecords(file);
  expect(read.records).toHaveLength(1);
  expect(read.records[0]).toEqual(record({ ts: 1 }));
  expect(read.skippedLines).toBe(1);
  // The same file read through the report path agrees row for row.
  const report = readLedgerFiles([file]);
  expect(report.recordsRead).toBe(read.records.length);
  expect(report.skippedLines).toBe(read.skippedLines);
});

test("a record line over the byte bound is skipped, not parsed and not fatal", () => {
  const file = path.join(
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-ledger-"))),
    "run.jsonl",
  );
  const small = JSON.stringify(record({ ts: 1 }));
  const large = JSON.stringify(record({ ts: 2, role: "orchestrator", step: "turn:2" }));
  fs.writeFileSync(file, `${small}\n${large}\n`);
  const read = readLedgerRecords(file, Buffer.byteLength(small));
  expect(read.records).toHaveLength(1);
  expect(read.records[0]?.ts).toBe(1);
  expect(read.skippedLines).toBe(1);
  // Zero (the default) bounds nothing, matching the report path.
  expect(readLedgerRecords(file).records).toHaveLength(2);
});

test("a line whose usage or identifiers are not numbers/strings is skipped", () => {
  expect(parseLedgerLine("null")).toBeUndefined();
  expect(parseLedgerLine("[]")).toBeUndefined();
  expect(parseLedgerLine("{}")).toBeUndefined();
  expect(parseLedgerLine(JSON.stringify({ ...record({ ts: 1 }), ts: "nope" }))).toBeUndefined();
  expect(
    parseLedgerLine(JSON.stringify({ ...record({ ts: 1 }), usage: { ...USAGE, input: NaN } })),
  ).toBeUndefined();
  expect(
    // Money must arrive provider-reported, so an unusable cost line is skipped.
    parseLedgerLine(JSON.stringify({ ...record({ ts: 1 }), usage: { ...USAGE, cost: undefined } })),
  ).toBeUndefined();
});

test("tool mix, bash-per-edit, cache fraction, and first-edit offsets derive", () => {
  const leadingCall = record({ ts: 100, role: "orchestrator" });
  const rightFirstEdit = record({
    ts: 500,
    role: "coder",
    toolCalls: { edit: 1, bash: 1 },
  });
  const laterEdit = record({
    ts: 900,
    role: "reviewer",
    toolCalls: { edit: 1 },
  });
  const bashOnly = record({
    ts: 950,
    role: "reviewer",
    model: "other-1",
    provider: "other",
    usage: { ...USAGE, input: 100, cost: { ...USAGE.cost, total: 0 } },
    toolCalls: { bash: 3 },
  });
  const report = aggregateLedgerRecords([leadingCall, rightFirstEdit, laterEdit, bashOnly]);

  expect(report.total.modelCalls).toEqual(4);
  expect(report.total.editCalls).toEqual(2);
  expect(report.total.bashCallsPerEdit).toEqual(2);
  // First edit is the EARLIEST response naming the tool, not the first record.
  expect(report.total.firstEditAt).toEqual(500);
  expect(report.total.timeToFirstEditMs).toEqual(400);
  expect(report.total.cacheFraction).toBeCloseTo(4800 / 6400);

  expect(report.perRole.map((role) => role.scope)).toEqual(["orchestrator", "coder", "reviewer"]);
  const reviewer = report.perRole.find((role) => role.scope === "reviewer");
  // bash over edits within one scope: reviewer made 3 bash calls for 1 edit.
  expect(reviewer?.bashCallsPerEdit).toEqual(3);
  expect(reviewer?.cacheFraction).toBeCloseTo(2400 / 3000);

  expect(report.perModel.map((model) => model.scope)).toEqual(["faux/faux-1", "other/other-1"]);
  const other = report.perModel.find((model) => model.scope === "other/other-1");
  expect(other?.toolCalls).toEqual([{ tool: "bash", calls: 3 }]);
  expect(other?.firstEditAt).toBeUndefined();
  expect(other?.timeToFirstEditMs).toBeUndefined();
  // A role never offering run_role stays a zero count, not a missing key.
  expect(report.total.runRoleCalls).toEqual(0);
});

test("delegation shows up as run_role tool requests", () => {
  const delegating = record({ ts: 200, role: "orchestrator", toolCalls: { run_role: 2 } });
  const delegated = record({ ts: 300, role: "coder" });
  const report = aggregateLedgerRecords([delegating, delegated]);
  expect(report.perRole.map((role) => role.scope)).toEqual(["orchestrator", "coder"]);
  expect(report.total.runRoleCalls).toEqual(2);
});

test("a scope with no usage totals reports cacheFraction as undefined, and sorts roles by cost", () => {
  const empty = record({
    ts: 10,
    role: "b",
    usage: { ...USAGE, input: 0, cacheRead: 0, cost: { ...USAGE.cost, total: 0 } },
  });
  const cheap = record({
    ts: 20,
    role: "a",
    usage: { ...USAGE, cost: { ...USAGE.cost, total: 1.5 } },
  });
  const pricey = record({
    ts: 30,
    role: "c",
    usage: { ...USAGE, cost: { ...USAGE.cost, total: 9 } },
  });
  const report = aggregateLedgerRecords([empty, cheap, pricey]);
  expect(report.perRole.map((role) => role.scope)).toEqual(["c", "a", "b"]);
  expect(report.perRole[2]?.cacheFraction).toBeUndefined();
});

test("the human rendering keeps file health visible below the numbers", () => {
  const report = readLedgerFiles([]);
  expect(report.recordsRead).toEqual(0);
  // Reading nothing is a valid report, not a crash or a fabricated number.
  const text = renderLedgerReport(report);
  expect(text).toContain("total:");
});

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI = path.join(REPO_ROOT, "src/cli.ts");

function runCli(
  args: string[],
  options: { cwd?: string } = {},
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function ledgerFile(): { dir: string; file: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-ledger-cli-")));
  const file = path.join(dir, "run.jsonl");
  fs.writeFileSync(file, `${JSON.stringify(record({ ts: 1, usage: { ...USAGE } }))}\n`);
  return { dir, file };
}

test("the ledger command reports a named file as JSON", () => {
  const { file } = ledgerFile();
  const result = runCli(["ledger", "report", file, "--json"]);
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.recordsRead).toEqual(1);
  expect(parsed.total.modelCalls).toEqual(1);
  expect(parsed.files[0]?.records).toEqual(1);
});

test("the ledger command renders a human report naming the file's health", () => {
  const { file } = ledgerFile();
  const result = runCli(["ledger", "report", file]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("total: calls=1 fresh=500");
  expect(result.stdout).toContain("records=1 skipped=0");
});

test("a usage error from the ledger command exits 2 and names the reason", () => {
  const { file } = ledgerFile();
  const badAction = runCli(["ledger", "nonsense", file]);
  expect(badAction.code).toBe(2);
  // A nonexistent file is operator input, so it is named rather than swallowed.
  const missing = runCli(["ledger", "report", `${file}-missing`]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain(`${file}-missing`);
});

test("with no file args, the ledger command reads .ad-coder/ledger of the cwd", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-ledger-cli-")));
  const base = path.join(dir, ".ad-coder", "ledger");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "run.jsonl"), `${JSON.stringify(record({ ts: 1 }))}\n`);
  // A non-ledger file in the same directory is ignored, not parsed and not reported.
  fs.writeFileSync(path.join(base, "notes.txt"), "not a ledger");
  const result = runCli(["ledger", "report", "--json"], { cwd: dir });
  expect(result.code).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.files[0]?.records).toEqual(1);
  expect(parsed.files).toHaveLength(1);
});

test("a refusal row parses and contributes only zero amounts (issue #422)", () => {
  const refusalRow: LedgerRecord = {
    ts: 100,
    runId: "run-1",
    lane: "main",
    role: "coder",
    step: "turn:1",
    provider: "faux",
    model: "faux-1",
    stopReason: "refusal",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    refusal: {
      code: "conversation_refused",
      reason: "lane_stopping",
      message: "conversation lane is still stopping",
    },
  };
  const parsed = parseLedgerLine(JSON.stringify(refusalRow));
  expect(parsed).toEqual(refusalRow);

  const settled = record({ ts: 200 });
  const report = aggregateLedgerRecords([refusalRow, settled]);
  expect(report.total.modelCalls).toEqual(2);
  // The refusal row contributes zero tokens and zero money; the settled row's
  // numbers are exactly what the totals carry.
  expect(report.total.freshInput).toEqual(USAGE.input);
  expect(report.total.output).toEqual(USAGE.output);
  expect(report.total.costUsd).toBeCloseTo(USAGE.cost.total);
  expect(report.recordsRead).toEqual(2);
  expect(report.skippedLines).toEqual(0);
});
