/**
 * Read ledger files back the way real work wrote them.
 *
 * Everything here consumes the record shape in ./types and produces derived
 * numbers only: counts, sums, ratios, and offsets. It never reads or re-embarks
 * any payload the ledger deliberately does not store, so a report is as safe to
 * emit on stdout as the ledger file is to keep.
 *
 * Two shapes the ledger CANNOT supply (it stores requests, not outcomes) are
 * deliberately absent from every projection:
 * - A failed-edit rate: `toolCalls` counts what a model REQUESTED, which does
 *   not say whether any edit applied or errored. That number needs an
 *   `after_tool` outcome hook and is a follow-on in ./types.
 * - Time to green tests: a passing test run emits nothing into this ledger.
 */
import * as fs from "node:fs";
import type { LedgerRecord } from "./types";

/** One tool name's total over a scope. Sorted by descending call count when projected. */
export interface ToolCount {
  tool: string;
  calls: number;
}

/** Aggregated numbers for one grouping of ledger records: totals, a role, or a model. */
export interface LedgerScopeStats {
  /** Role name, model id, or "total" depending on which projection this is. */
  scope: string;
  modelCalls: number;
  freshInput: number;
  cachedInputRead: number;
  cachedInputWrite: number;
  output: number;
  /** undefined when NO record in the scope reported one, not 0. */
  reasoning: number | undefined;
  /** Sum of provider-reported cost.total -- copied, never recomputed from tokens. */
  costUsd: number;
  toolCalls: ToolCount[];
  bashCalls: number;
  editCalls: number;
  /** bash / edits; undefined when the scope made no edit calls, not 0. */
  bashCallsPerEdit: number | undefined;
  /**
   * (cacheRead + cacheWrite) / (fresh input + cached, output excluded): how
   * much of what the model had to READ each turn was already cached.
   * undefined when the scope's totals add to 0.
   */
  cacheFraction: number | undefined;
  /** Times the scope's responses REQUESTED `run_role` -- delegation, not outcomes. */
  runRoleCalls: number;
  /** Epoch ms of the first response naming the edit tool; undefined if never. */
  firstEditAt: number | undefined;
  /** firstEditAt minus the scope's first response ts; undefined if never edited. */
  timeToFirstEditMs: number | undefined;
}

/** One file's read health, so a skipped line is reported rather than silently dropped. */
export interface LedgerFileStats {
  path: string;
  records: number;
  skippedLines: number;
}

/** One file's parsed records plus the same line-health accounting the report keeps. */
export interface LedgerRecordsRead {
  records: LedgerRecord[];
  skippedLines: number;
}

/** The whole reading: one totals projection, per-role and per-model projections, file health. */
export interface LedgerReport {
  files: LedgerFileStats[];
  recordsRead: number;
  skippedLines: number;
  total: LedgerScopeStats;
  perRole: LedgerScopeStats[];
  perModel: LedgerScopeStats[];
}

/**
 * Parse one ledger line, leniently. Returns undefined for anything that is not
 * a well-formed record in the ./types shape.
 *
 * A ledger file is APPENDED by a live run, so a reader can open it
 * mid-write: the final line may be truncated, and any line may fail to parse.
 * That is data loss of one line, reported as a skipped line -- never throw,
 * never crash a count that took a whole session to accumulate.
 */
export function parseLedgerLine(line: string): LedgerRecord | undefined {
  if (line.trim().length === 0) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as LedgerRecord;
  if (!isFiniteNumber(candidate.ts) || typeof candidate.runId !== "string") return undefined;
  if (typeof candidate.role !== "string" || typeof candidate.model !== "string") return undefined;
  const usage = candidate.usage as LedgerRecord["usage"] | undefined;
  if (usage === undefined) return undefined;
  if (
    !isFiniteNumber(usage.input) ||
    !isFiniteNumber(usage.output) ||
    !isFiniteNumber(usage.cacheRead) ||
    !isFiniteNumber(usage.cacheWrite) ||
    !isFiniteNumber(usage.totalTokens)
  )
    return undefined;
  if (usage.cost === undefined || !isFiniteNumber(usage.cost.total)) return undefined;
  if (usage.reasoning !== undefined && !isFiniteNumber(usage.reasoning)) return undefined;
  return candidate;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read one ledger JSONL file back into its records -- the same lenient parse
 * `readLedgerFiles` aggregates, kept separate so a caller that needs the rows
 * themselves (a resumed front seeding its readable sink from the ledger the
 * previous process wrote) does not have to re-derive them from a report.
 *
 * A line longer than `maxRecordBytes` is skipped like an unparseable one and
 * counted in `skippedLines` rather than loaded; 0 (the default) bounds
 * nothing, matching the write-side sink where 0 also disables its limit.
 */
export function readLedgerRecords(filePath: string, maxRecordBytes = 0): LedgerRecordsRead {
  const text = fs.readFileSync(filePath, "utf8");
  const records: LedgerRecord[] = [];
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    if (maxRecordBytes > 0 && Buffer.byteLength(line, "utf8") > maxRecordBytes) {
      // The row exists but cannot be trusted at this size; skipping it keeps
      // the reader bounded and the read non-fatal.
      skippedLines++;
      continue;
    }
    const record = parseLedgerLine(line);
    if (record === undefined) {
      if (line.trim().length > 0) skippedLines++;
      continue;
    }
    records.push(record);
  }
  return { records, skippedLines };
}

/**
 * Read one or more ledger JSONL files and derive the report.
 *
 * Files that cannot be opened raise immediately: an operator who spelled a
 * wrong path must see that path named, not a silently empty report. Lines that
 * do not parse are counted in the file stats and left out of the aggregates.
 */
export function readLedgerFiles(paths: string[]): LedgerReport {
  const records: LedgerRecord[] = [];
  const files: LedgerFileStats[] = [];
  for (const filePath of paths) {
    const read = readLedgerRecords(filePath);
    records.push(...read.records);
    files.push({ path: filePath, records: read.records.length, skippedLines: read.skippedLines });
  }
  return aggregateLedgerRecords(records, files);
}

/**
 * Derive the report from records a caller already holds -- the library entry
 * point behind `readLedgerFiles`, so an orchestrator role can answer "how did
 * that run actually go" from a readable sink's records without shelling out.
 *
 * File stats are attached by the file reader; programmatic callers pass an
 * empty file list and get `recordsRead` as their only line-health signal.
 */
export function aggregateLedgerRecords(
  records: readonly LedgerRecord[],
  files: readonly LedgerFileStats[] = [],
): LedgerReport {
  const fileSnapshot = files.map((file) => ({ ...file }));
  return {
    files: fileSnapshot,
    recordsRead: records.length,
    skippedLines: fileSnapshot.reduce((sum, file) => sum + file.skippedLines, 0),
    total: aggregateScope("total", records),
    perRole: [...group(records, (record) => record.role).entries()]
      .map(([role, roleRecords]) => aggregateScope(role, roleRecords))
      .sort(byCostDesc),
    perModel: [...group(records, (record) => `${record.provider}/${record.model}`).entries()]
      .map(([model, modelRecords]) => aggregateScope(model, modelRecords))
      .sort(byCostDesc),
  };
}

function group(
  records: readonly LedgerRecord[],
  key: (record: LedgerRecord) => string,
): Map<string, LedgerRecord[]> {
  const groups = new Map<string, LedgerRecord[]>();
  for (const record of records) {
    const bucket = groups.get(key(record));
    if (bucket === undefined) groups.set(key(record), [record]);
    else bucket.push(record);
  }
  return groups;
}

function byCostDesc(left: LedgerScopeStats, right: LedgerScopeStats): number {
  return right.costUsd - left.costUsd;
}

function aggregateScope(scope: string, records: readonly LedgerRecord[]): LedgerScopeStats {
  const tools = new Map<string, number>();
  let freshInput = 0;
  let cachedRead = 0;
  let cachedWrite = 0;
  let output = 0;
  let cost = 0;
  let reasoningSum = 0;
  let sawReasoning = false;
  let firstModelCallAt: number | undefined;
  let firstEditAt: number | undefined;

  for (const record of records) {
    freshInput += record.usage.input;
    cachedRead += record.usage.cacheRead;
    cachedWrite += record.usage.cacheWrite;
    output += record.usage.output;
    cost += record.usage.cost.total;
    if (record.usage.reasoning !== undefined) {
      sawReasoning = true;
      reasoningSum += record.usage.reasoning;
    }
    if (firstModelCallAt === undefined || record.ts < firstModelCallAt)
      firstModelCallAt = record.ts;
    for (const [tool, calls] of Object.entries(record.toolCalls ?? {})) {
      if (!isFiniteNumber(calls) || calls <= 0) continue;
      tools.set(tool, (tools.get(tool) ?? 0) + calls);
    }
    if ((record.toolCalls?.edit ?? 0) > 0) {
      if (firstEditAt === undefined || record.ts < firstEditAt) firstEditAt = record.ts;
    }
  }

  const bashCalls = tools.get("bash") ?? 0;
  const editCalls = tools.get("edit") ?? 0;
  const cachedInput = cachedRead + cachedWrite;
  const denominator = freshInput + cachedInput;
  return {
    scope,
    modelCalls: records.length,
    freshInput,
    cachedInputRead: cachedRead,
    cachedInputWrite: cachedWrite,
    output: output,
    reasoning: sawReasoning ? reasoningSum : undefined,
    costUsd: cost,
    toolCalls: [...tools.entries()]
      .map(([tool, calls]) => ({ tool, calls }))
      .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool)),
    bashCalls,
    editCalls,
    bashCallsPerEdit: editCalls === 0 ? undefined : bashCalls / editCalls,
    cacheFraction: denominator === 0 ? undefined : cachedInput / denominator,
    runRoleCalls: tools.get("run_role") ?? 0,
    firstEditAt,
    timeToFirstEditMs:
      firstEditAt === undefined || firstModelCallAt === undefined
        ? undefined
        : firstEditAt - firstModelCallAt,
  };
}

/**
 * The stable human rendering: totals first, then per-role and per-model sorted
 * by cost, then each file's read health. File stats always reach even the human
 * reader so a truncated line is never silently dropped.
 */
export function renderLedgerReport(report: LedgerReport): string {
  const lines = [
    renderScopeStats("total", report.total),
    ...report.perRole.map((stats) => renderScopeStats(`role ${stats.scope}`, stats)),
    ...report.perModel.map((stats) => renderScopeStats(`model ${stats.scope}`, stats)),
  ];
  for (const file of report.files)
    lines.push(`file=${file.path} records=${file.records} skipped=${file.skippedLines}`);
  return `${lines.join("\n")}\n`;
}

function renderScopeStats(label: string, stats: LedgerScopeStats): string {
  const numbers = [
    `calls=${stats.modelCalls}`,
    `fresh=${stats.freshInput}`,
    `cached=${stats.cachedInputRead + stats.cachedInputWrite}`,
    `out=${stats.output}`,
    `reasoning=${stats.reasoning ?? 0}`,
    `cost=$${stats.costUsd.toFixed(6)}`,
  ];
  if (stats.cacheFraction !== undefined)
    numbers.push(`cacheFraction=${stats.cacheFraction.toFixed(2)}`);
  if (stats.editCalls > 0) numbers.push(`edits=${stats.editCalls}`);
  if (stats.bashCallsPerEdit !== undefined)
    numbers.push(`bashPerEdit=${stats.bashCallsPerEdit.toFixed(1)}`);
  if (stats.runRoleCalls > 0) numbers.push(`runRoleCalls=${stats.runRoleCalls}`);
  if (stats.timeToFirstEditMs !== undefined)
    numbers.push(`timeToFirstEdit=${stats.timeToFirstEditMs}`);
  const tools = stats.toolCalls.map((entry) => `${entry.tool}=${entry.calls}`).join(" ");
  return `${label}: ${numbers.join(" ")}${tools ? ` tools ${tools}` : ""}`;
}
