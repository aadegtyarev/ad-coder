#!/usr/bin/env bun
import * as fs from "node:fs";
import { type CalibrationTask, scoreCalibrationRun } from "../src/evaluation/calibration";
import type { LedgerRecord } from "../src/ledger/types";

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

const [taskFile, ledgerFile, checksFile, inventory, duration] = process.argv.slice(2);
if (!taskFile || !ledgerFile || !checksFile || !inventory || !duration)
  throw new Error(
    "usage: calibration-score <task.json> <ledger.jsonl> <checks.json> <inventory> <duration-ms>",
  );
const ledger = fs
  .readFileSync(ledgerFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as LedgerRecord);
const result = scoreCalibrationRun({
  task: readJson<CalibrationTask>(taskFile),
  ledger,
  checks: readJson(checksFile),
  inventory,
  durationMs: Number(duration),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
