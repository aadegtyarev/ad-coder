/**
 * The `stamp` CLI surfaces (issues #240 and #239).
 *
 * `stampDeliveryText` renders the delivery signature straight from ledger
 * records -- a projection of what the ledger already wrote, so no model
 * summary of its own cost can reach it, and per-call detail stays in the
 * ledger (the comment block is the compact view only).
 *
 * `stampCheckErrors` is the gate's command: it verifies that a review stamp
 * exists, parses, matches the verdict rule, and names the CURRENT tree
 * digest -- a stale stamp must not pass (`review-stamp.ts`).
 *
 * `stampBodyCheckErrors` is the pull-request-body gate (issue #335): it
 * verifies that a PR body carries the freshly rendered delivery block
 * verbatim -- absent or stale bodies fail with the render command named.
 *
 * Ad-hoc writers use the library entry points directly; no CLI write path is
 * offered, because a stamp the orchestrator hand-writes into the committed
 * log would certify a review that only the settled result data speaks for,
 * and the run-finish hook in `record-review-stamp.ts` is the writer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseLedgerLine } from "../ledger/analytics";
import { LEDGER_BASE_DIR } from "../ledger/ledger";
import type { LedgerRecord } from "../ledger/types";
import { buildDeliverySignature, renderDeliverySignature } from "./delivery-signature";
import { checkReviewStamps } from "./record-review-stamp";

/** Read ledger files leniently: one parseable record per line, blanks skipped. */
export function readLedgerRecords(paths: readonly string[]): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  for (const filePath of paths) {
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      const record = parseLedgerLine(line);
      if (record !== undefined) records.push(record);
    }
  }
  return records;
}

/** Ledger files for a target: explicit paths, or every *.jsonl in the store. */
export function ledgerRecordSources(targetDir: string, files: readonly string[]): string[] {
  if (files.length > 0) return files.map((file) => path.resolve(file));
  const base = path.join(targetDir, LEDGER_BASE_DIR);
  if (!fs.existsSync(base)) throw new Error(`no ledger files exist under ${base}/`);
  const entries = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(base, entry.name))
    .sort();
  if (entries.length === 0) throw new Error(`no *.jsonl ledger files exist under ${base}/`);
  return entries;
}

/** The whole delivery signature block text, from ledger paths alone. */
export function stampDeliveryText(targetDir: string, files: readonly string[] = []): string {
  const records = readLedgerRecords(ledgerRecordSources(targetDir, files));
  return renderDeliverySignature(buildDeliverySignature(records));
}

/** Reasons the branch may not merge; empty list means the stamp gate passes. */
export function stampCheckErrors(targetDir: string): string[] {
  return checkReviewStamps(targetDir).errors;
}

/**
 * The PR-body gate (issue #335): the body must carry the delivery block as
 * rendered from the ledger NOW, verbatim -- a hand-composed or stale block
 * defeats the point of rendering cost from evidence.
 *
 * Presence is a substring check of the freshly rendered block (trimmed), so
 * sentence wrapping and one trailing-newline difference around the block do
 * not matter. A body that carries a similar block -- a `runs ` header line --
 * that is NOT the fresh rendering is stale, not absent: the fix is to re-run
 * the render command and replace the block verbatim.
 */
export function stampBodyCheckErrors(
  bodyPath: string,
  targetDir: string,
  files: readonly string[],
): string[] {
  const block = stampDeliveryText(targetDir, files).trim();
  const body = fs.readFileSync(bodyPath, "utf8");
  if (body.includes(block)) return [];
  const hasSimilarBlock = body.split("\n").some((line) => line.startsWith("runs "));
  if (hasSimilarBlock)
    return [
      `${bodyPath}: the delivery block is stale (rendered cost differs from the ledger now); re-run "ad-coder stamp delivery" and replace the block verbatim`,
    ];
  return [
    `${bodyPath}: the generated delivery block is absent (render it with "ad-coder stamp delivery", never compose one)`,
  ];
}
