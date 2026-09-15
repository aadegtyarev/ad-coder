#!/usr/bin/env bun
import * as fs from "node:fs";
import { type CalibrationTask, scoreCalibrationRun } from "../src/evaluation/calibration";
import type { LedgerRecord } from "../src/ledger/types";

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

/**
 * WHY THE COMPLEXITY TIERS ARE NO LONGER ARGUMENTS.
 *
 * They used to arrive as two trailing positionals an operator typed, so
 * `complexityCorrect` and `plannerAgreement` measured what the operator
 * believed, and passing the same value twice made them tautologically true.
 * They now come from the run report `evals/runner/corpus.ts` assembles out of
 * the console turn stream, the workflow checkpoint and the ledger -- all
 * observed. A run without a report simply reports `null` for both.
 */
const [taskFile, ledgerFile, checksFile, inventory, duration, thinkingLevel, reportFile] =
  process.argv.slice(2);
if (!taskFile || !ledgerFile || !checksFile || !inventory || !duration || !thinkingLevel)
  throw new Error(
    "usage: calibration-score <task.json> <ledger.jsonl> <checks.json> <inventory> <duration-ms> <thinking-level> [report.json]",
  );
const report =
  reportFile === undefined
    ? undefined
    : readJson<{ predictedComplexity?: string | null; plannerComplexity?: string | null }>(
        reportFile,
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
  thinkingLevel,
  durationMs: Number(duration),
  ...(report?.predictedComplexity != null && {
    orchestratorComplexity: report.predictedComplexity as CalibrationTask["complexity"],
  }),
  ...(report?.plannerComplexity != null && {
    plannerComplexity: report.plannerComplexity as CalibrationTask["complexity"],
  }),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
