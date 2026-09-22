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
 * Both gates return TYPED failures -- reason plus the action that clears it
 * -- so the CLI fronts name both, and a machine front gets a structured
 * `gate_failed` projection rather than shorthand usage (issue #425).
 *
 * Ad-hoc writers use the library entry points directly; no CLI write path is
 * offered, because a stamp the orchestrator hand-writes into the committed
 * log would certify a review that only the settled result data speaks for,
 * and the run-finish hook in `record-review-stamp.ts` is the writer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { StampRequirement } from "../config/types";
import { parseLedgerLine } from "../ledger/analytics";
import { LEDGER_BASE_DIR } from "../ledger/ledger";
import type { LedgerRecord } from "../ledger/types";
import {
  buildDeliverySignature,
  DELIVERY_SIGNATURE_LEAD_IN,
  renderDeliverySignatureStamped,
} from "./delivery-signature";
import { checkReviewStamps, type ReviewStampFailure } from "./record-review-stamp";

/**
 * A ledger source is command input, not a harness failure.  Keeping this
 * distinct from arbitrary filesystem errors lets both stamp fronts retain the
 * normal usage projection when the caller omitted the target's ledger.
 */
export class StampLedgerSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StampLedgerSourceError";
  }
}

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
  if (!fs.existsSync(base))
    throw new StampLedgerSourceError(`no ledger files exist under ${base}/`);
  const entries = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(base, entry.name))
    .sort();
  if (entries.length === 0)
    throw new StampLedgerSourceError(`no *.jsonl ledger files exist under ${base}/`);
  return entries;
}

/** The published PR form -- prose lead-in plus one fenced block -- from ledger paths alone. */
export function stampDeliveryText(targetDir: string, files: readonly string[] = []): string {
  const records = readLedgerRecords(ledgerRecordSources(targetDir, files));
  return renderDeliverySignatureStamped(buildDeliverySignature(records));
}

/**
 * Review-stamp gate failures: typed reasons with the action that clears each
 * (issue #425). Empty list means the stamp gate passes.
 */
export function stampCheckErrors(
  targetDir: string,
  requireStamp?: StampRequirement,
): ReviewStampFailure[] {
  return checkReviewStamps(targetDir, requireStamp).failures;
}

/**
 * The PR-body gate (issue #335): the body must carry the delivery block as
 * rendered from the ledger NOW, verbatim -- a hand-composed or stale block
 * defeats the point of rendering cost from evidence.
 *
 * Presence is a substring check of the freshly rendered published form (the
 * prose lead-in plus the fenced block, trimmed), so sentence wrapping and one
 * trailing-newline difference around the form do not matter. A body that
 * carries a similar block -- a `runs=`-headed line or the prose lead-in (the
 * two shape markers of the published form, issue #435), both whitespace-
 * tolerant -- that is NOT the fresh rendering is stale, not absent: the fix is
 * to re-run the render command and replace the whole form verbatim.
 */
export function stampBodyCheckErrors(
  bodyPath: string,
  targetDir: string,
  files: readonly string[],
): ReviewStampFailure[] {
  const block = stampDeliveryText(targetDir, files).trim();
  const body = fs.readFileSync(bodyPath, "utf8");
  if (body.includes(block)) return [];
  const hasSimilarBlock = body.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("runs=") || trimmed === DELIVERY_SIGNATURE_LEAD_IN;
  });
  if (hasSimilarBlock)
    return [
      {
        reason: `${bodyPath}: the delivery block is stale (a prose lead-in with a fenced runs= block, but its totals differ from the ledger now)`,
        action:
          're-run "ad-coder stamp delivery" and paste the whole form -- the prose lead-in plus the fenced runs= block -- into the pull-request body verbatim',
      },
    ];
  return [
    {
      reason: `${bodyPath}: the generated delivery form is absent (expect the prose lead-in followed by the fenced block whose first line starts with runs=)`,
      action:
        'render it with "ad-coder stamp delivery" (never compose one) and paste the whole form verbatim',
    },
  ];
}
