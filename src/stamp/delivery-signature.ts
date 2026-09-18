/**
 * Delivery signature and review stamp: the two derived blocks this project's
 * own delivery paperwork is made of (issues #240 and #239).
 *
 * Both are COMPUTED from evidence the run already wrote -- the ledger's
 * per-role usage rows (src/ledger/analytics.ts) and the reviewer's structured
 * verdict -- and both are rendered as text, never written from later history:
 * routed work must be tied to per-step cost and per-role scope exactly.
 */

import { aggregateLedgerRecords, type LedgerScopeStats } from "../ledger/analytics";
import type { LedgerRecord } from "../ledger/types";

/** Role names the delivery signature always names, even when they never ran. */
export const SIGNATURE_ROLES: readonly string[] = [
  // The orchestrator lane drives the whole run, so it leads the block: its row
  // is a row like the others, first so readers can sum rows to the header. (#336)
  "orchestrator",
  "planner",
  "researcher",
  "security",
  "coder",
  "reviewer",
];

/**
 * The whole signature: identifiers, tokens, and provider-reported money --
 * identifiers and numbers only, never task text or payload (`errors.md`).
 */
export interface DeliverySignature {
  runIds: string[];
  totalCalls: number;
  totalCostUsd: number;
  freshInput: number;
  cachedInput: number;
  output: number;
  reasoning: number | undefined;
  /** One row per contributing scope; per-issue detail lives in the ledger. */
  roles: {
    role: string;
    provider: string;
    model: string;
    calls: number | undefined;
    costUsd: number | undefined;
    ran: boolean;
  }[];
}

/** One compact line per role; line order is the SIGNATURE_ROLES order. */
function renderRoleRow(entry: DeliverySignature["roles"][number]): string {
  if (!entry.ran || entry.calls === undefined) return `${entry.role.padEnd(9)} -- did not run`;
  return `${entry.role.padEnd(9)} ${`${entry.provider}/${entry.model}`.padEnd(30)} calls=${String(
    entry.calls,
  ).padEnd(4)} cost=$${(entry.costUsd ?? 0).toFixed(6)}`;
}

/**
 * Build the delivery signature from ledger records alone. Per-role rows come
 * from the records' own role/provider/model values -- including the
 * orchestrator lane, which is a row like the others (#336); a declared role
 * with NO records still gets a row marked "did not run", because a missing planner or
 * reviewer is part of the run's story, not an absence to paper over (#239).
 */
export function buildDeliverySignature(
  records: readonly LedgerRecord[],
  roles: readonly string[] = SIGNATURE_ROLES,
): DeliverySignature {
  const report = aggregateLedgerRecords(records, []);
  const byRole = new Map<string, LedgerScopeStats>(
    report.perRole.map((scope) => [scope.scope, scope]),
  );
  const roleRows = roles.map((role) => {
    const stats = byRole.get(role);
    if (stats === undefined || stats.modelCalls === 0)
      return { role, provider: "-", model: "-", calls: undefined, costUsd: undefined, ran: false };
    // The role projection's scope is the role name; provider/model come from
    // the records themselves, as the dominant (provider, model) pair.
    const { mostProvider, mostModel } = dominantModel(records, role);
    return {
      role,
      provider: mostProvider,
      model: mostModel,
      calls: stats.modelCalls,
      costUsd: stats.costUsd,
      ran: true,
    };
  });
  return {
    runIds: [...new Set(records.map((record) => record.runId))],
    totalCalls: report.total.modelCalls,
    totalCostUsd: report.total.costUsd,
    freshInput: report.total.freshInput,
    cachedInput: report.total.cachedInputRead + report.total.cachedInputWrite,
    output: report.total.output,
    reasoning: report.total.reasoning,
    roles: roleRows,
  };
}

/** Most-used (provider, model) pair for a role, for the compact per-role row. */
function dominantModel(
  records: readonly LedgerRecord[],
  role: string,
): { mostProvider: string; mostModel: string } {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.role !== role) continue;
    const key = `${record.provider} ${record.model}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bestKey: string | undefined;
  let bestCount = 0;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  if (bestKey === undefined) return { mostProvider: "-", mostModel: "-" };
  const separator = bestKey.indexOf(" ");
  return { mostProvider: bestKey.slice(0, separator), mostModel: bestKey.slice(separator + 1) };
}

/**
 * The stable human rendering: one header with run ids / totals, then the
 * per-role block in SIGNATURE_ROLES order. It is the PR-comment block: compact
 * by construction, no per-call detail (the ledger holds that).
 */
export function renderDeliverySignature(signature: DeliverySignature): string {
  const header = [
    `runs ${signature.runIds.join(",") || "-"}`,
    `calls=${signature.totalCalls}`,
    `cost=$${signature.totalCostUsd.toFixed(6)}`,
    `tokens fresh=${signature.freshInput} cached=${signature.cachedInput} out=${signature.output}${
      signature.reasoning !== undefined ? ` reasoning=${signature.reasoning}` : ""
    }`,
  ].join(" | ");
  return `${header}\n${signature.roles.map(renderRoleRow).join("\n")}\n`;
}
