/**
 * Resolve `ad-coder console --resume [<run-id>]` BEFORE anything is created.
 *
 * The flag has two forms. `--resume <id>` names the run to continue: the id is
 * validated FIRST (it feeds a file path), then the run's orchestrator ledger
 * `.ad-coder/ledger/<id>.jsonl` and its durable session under
 * `.ad-coder/sessions/` must both already exist -- a resume never creates a
 * session or a ledger file, so an unknown or malformed id fails as a typed
 * error and leaves the project untouched. `--resume` with no value discovers
 * the most recent orchestrator session for the target directory.
 *
 * THE DISCOVERY DISCRIMINATOR, verified against the writers: the orchestrator
 * conversation front attributes every one of its turns with role
 * "orchestrator" and step `turn:N` (`src/conversation/conversation.ts` builds
 * its Ledger from `role.name` and defaults the step to `turn:N`;
 * `src/orchestration/orchestrator.ts` pins the front role's name to
 * "orchestrator"). Standalone `ad-coder role` runs write step "run" and can
 * write role "orchestrator", and a drive/pipeline ledger only ever carries the
 * stage roles -- so a ledger identifies an orchestrator conversation front iff
 * it carries AT LEAST ONE record with role "orchestrator" AND step `turn:N`.
 * ANY record, not the first: a delegated `run_role` row can settle before the
 * front's first turn row (both fronts share one file), so "first record" would
 * misclassify a session that delegated immediately.
 *
 * SECURITY: every run id here -- from the flag or read off a directory
 * listing -- passes the same `[A-Za-z0-9_-]{1,64}` pattern the ledger and the
 * project store enforce, before any path is built from it. Discovery lists
 * only regular files (dirent kinds; a symlinked directory entry is not a file
 * entry) directly inside `.ad-coder/ledger/`, refuses a symlinked ledger
 * directory, never follows a symlinked final component, and never writes.
 * Errors carry the run id and a relative path only -- never file contents and
 * never absolute paths outside the target directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readLedgerRecords } from "../ledger/analytics";
import { LEDGER_BASE_DIR } from "../ledger/ledger";
import type { LedgerRecord } from "../ledger/types";
import { ProjectStoreError } from "../project-store/types";
import { assertRunId, RunnerError } from "../runner/errors";

/** A ledger file name is `<validated-run-id>.jsonl`; anything else is not a candidate. */
const LEDGER_FILE_NAME = /^([A-Za-z0-9_-]{1,64})\.jsonl$/;

/** The step shape only a conversation front's own turn writes (`turn:N`, N >= 1). */
const ORCHESTRATOR_TURN_STEP = /^turn:[1-9][0-9]*/;

/** The suffix every durable session file ends with; the id precedes it after a `_`. */
const SESSION_FILE_SUFFIX = ".jsonl";

/**
 * `.ad-coder` and its ledger directory, when they EXIST, must be real
 * directories, never symlinks -- the same chain safety `FileLedgerSink`
 * enforces before a write, applied to the read path. A MISSING component is
 * not an unsafe one: the caller's own ENOENT handling projects the actionable
 * not-found there. (A check-then-read race is acceptable for reads; the write
 * side re-checks the chain under its own fd.)
 */
function ledgerDirChainSafe(resolvedTargetDir: string): boolean {
  for (const segment of [".ad-coder", path.join(".ad-coder", "ledger")]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(resolvedTargetDir, segment));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return true;
}

/** The request the console's `--resume` flag parsed into. */
export type ResumeRequest = { bare: true } | { bare: false; runId: string };

/** A resolved resume: where to reopen, and what the restarted cost view replays. */
export interface ResumedLedger {
  runId: string;
  /** Absolute path of the resumed ledger, inside the target directory. */
  ledgerPath: string;
  /** Rows replayed into the readable sink's cost view; the mirror is NOT rewritten. */
  seedRecords: readonly LedgerRecord[];
  /** Ledger rows that could not be read back (truncated, corrupt, oversized). */
  skippedRows: number;
}

/**
 * Validate a run id the same way the ledger and project store do, projected as
 * a typed project-store failure: a raw `RunnerError` here would reach the CLI's
 * machine fronts as `internal_error`, and an invalid id is invalid INPUT with a
 * recovery action, not an internal defect.
 */
function assertResumeRunId(runId: string): string {
  try {
    return assertRunId(runId);
  } catch (error) {
    if (error instanceof RunnerError)
      throw new ProjectStoreError(
        "invalid_id",
        runId,
        `${error.message}; pass the run id a previous console printed as runId=, or start without --resume`,
      );
    throw error;
  }
}

/** The orchestrator ledger file for a VALIDATED run id; confined to the base dir. */
function orchestratorLedgerPath(resolvedTargetDir: string, runId: string): string {
  return path.join(resolvedTargetDir, ".ad-coder", "ledger", `${runId}.jsonl`);
}

/**
 * The durable session for a run is one `<timestamp>_<id>.jsonl` file under
 * `.ad-coder/sessions/--<cwd>--/`, named by the same create call
 * `openOrCreateSession` matches on (the timestamp carries no underscore, so
 * the LAST `_` delimits the id). The probe mirrors `listSessions`' cwd filter
 * without constructing a ProjectStore, which would create the store's
 * directories -- a refused resume must create nothing.
 */
function durableSessionExists(resolvedTargetDir: string, runId: string): boolean {
  const sessionsDir = path.join(
    resolvedTargetDir,
    ".ad-coder",
    "sessions",
    `--${resolvedTargetDir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.isFile()) return false;
    if (!entry.name.endsWith(SESSION_FILE_SUFFIX)) return false;
    const withoutSuffix = entry.name.slice(0, -SESSION_FILE_SUFFIX.length);
    const separator = withoutSuffix.lastIndexOf("_");
    return separator >= 0 && withoutSuffix.slice(separator + 1) === runId;
  });
}

/**
 * Require the resumed run's ledger to be a regular file, reached without
 * following a symlink at any component, and return its absolute path. ENOENT
 * is the not-found case the operator can act on; a symlink or a non-file is
 * refused outright -- the same posture the durable sink writes with.
 */
function assertLedgerFileReadable(resolvedTargetDir: string, runId: string): string {
  if (!ledgerDirChainSafe(resolvedTargetDir))
    throw new ProjectStoreError(
      "unsafe_path",
      LEDGER_BASE_DIR,
      "the ledger directory is not a real directory under the target; refusing to resume through a symlink",
    );
  const ledgerPath = orchestratorLedgerPath(resolvedTargetDir, runId);
  const relative = `${LEDGER_BASE_DIR}/${runId}.jsonl`;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(ledgerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ProjectStoreError(
        "not_found",
        runId,
        `no ledger for run ${runId} under ${LEDGER_BASE_DIR}/; resume needs a previous console run that wrote one -- check the id, or start without --resume`,
      );
    throw new ProjectStoreError(
      "unsafe_object",
      runId,
      `cannot read run ledger ${relative} (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new ProjectStoreError(
      "unsafe_object",
      runId,
      `resuming refuses anything but a regular ledger file: ${relative}`,
    );
  return ledgerPath;
}

/** Refuse a resume whose durable session is gone; the ledger alone is not enough. */
function assertDurableSession(resolvedTargetDir: string, runId: string): void {
  if (durableSessionExists(resolvedTargetDir, runId)) return;
  throw new ProjectStoreError(
    "not_found",
    runId,
    `no durable session for run ${runId} under .ad-coder/sessions/; a resumed conversation needs the session the previous console saved -- start without --resume`,
  );
}

/**
 * Resolve an EXPLICIT `--resume <id>`: validate the id before any path is
 * built, require ledger AND durable session, and read the previous run's rows
 * back for the seed. Nothing is created on any failure path.
 */
function resolveExplicitResume(
  resolvedTargetDir: string,
  runId: string,
  maxRecordBytes: number,
): ResumedLedger {
  assertResumeRunId(runId);
  const ledgerPath = assertLedgerFileReadable(resolvedTargetDir, runId);
  assertDurableSession(resolvedTargetDir, runId);
  return readSeedRecords(runId, ledgerPath, maxRecordBytes);
}

/** Read the resumed run's rows for the seed, mapping read failures to typed errors. */
function readSeedRecords(runId: string, ledgerPath: string, maxRecordBytes: number): ResumedLedger {
  const relative = `${LEDGER_BASE_DIR}/${runId}.jsonl`;
  try {
    const read = readLedgerRecords(ledgerPath, maxRecordBytes);
    return { runId, ledgerPath, seedRecords: read.records, skippedRows: read.skippedLines };
  } catch (error) {
    throw new ProjectStoreError(
      "unsafe_object",
      runId,
      `cannot read run ledger ${relative} (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
    );
  }
}

/** One candidate's discriminator verdict plus what a resume of it would replay. */
interface LedgerCandidate {
  runId: string;
  mtimeMs: number;
  records: readonly LedgerRecord[];
  skippedRows: number;
}

/**
 * Find the most recent orchestrator ledger in the target's ledger directory.
 * Only regular files named `<validated-id>.jsonl` directly inside the
 * directory are candidates; a symlinked `.ad-coder` or ledger directory is
 * not discoverable. Returns undefined when nothing qualifies.
 */
function discoverOrchestratorLedger(
  resolvedTargetDir: string,
  maxRecordBytes: number,
): LedgerCandidate | undefined {
  if (!ledgerDirChainSafe(resolvedTargetDir)) return undefined;
  const ledgerDir = path.join(resolvedTargetDir, ".ad-coder", "ledger");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(ledgerDir, { withFileTypes: true });
  } catch (error) {
    // A missing ledger directory means no previous run of ANY front: the
    // typed not-found projection belongs to the caller.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ProjectStoreError(
      "unsafe_object",
      LEDGER_BASE_DIR,
      `cannot list ${LEDGER_BASE_DIR}/ (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
    );
  }
  let best: LedgerCandidate | undefined;
  for (const entry of entries) {
    // A symlinked directory entry is not a file entry, so symlinks are
    // excluded before any path is built from the name.
    if (!entry.isFile()) continue;
    const match = LEDGER_FILE_NAME.exec(entry.name);
    // The id is taken from the NAME and validated by the pattern itself, so a
    // path is never built from an unvalidated directory entry.
    if (match === null) continue;
    const candidateRunId = match[1];
    if (candidateRunId === undefined) continue;
    const candidatePath = path.join(ledgerDir, entry.name);
    let fileStat: fs.Stats;
    try {
      fileStat = fs.lstatSync(candidatePath);
    } catch {
      continue; // Vanished between listing and stat: not a candidate.
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
    const read = readLedgerRecords(candidatePath, maxRecordBytes);
    const isOrchestratorFront = read.records.some(
      (record) => record.role === "orchestrator" && ORCHESTRATOR_TURN_STEP.test(record.step),
    );
    if (!isOrchestratorFront) continue;
    // Latest mtime wins; an exact tie (a pathological clock) breaks by the
    // greater id so the pick never depends on readdir order.
    if (
      best === undefined ||
      fileStat.mtimeMs > best.mtimeMs ||
      (fileStat.mtimeMs === best.mtimeMs && candidateRunId > best.runId)
    )
      best = {
        runId: candidateRunId,
        mtimeMs: fileStat.mtimeMs,
        records: read.records,
        skippedRows: read.skippedLines,
      };
  }
  return best;
}

/**
 * What a resolved resume adds to the orchestrator config: the run id whose
 * durable session reopens and the rows the restarted cost view replays.
 * Undefined (no `--resume`) adds NOTHING -- the default flow must stay
 * byte-identical, and this is the one seam where the flag could leak in.
 */
export function resumeOrchestratorConfig(resumed: ResumedLedger | undefined):
  | {
      runId?: string;
      seedLedgerRecords?: readonly LedgerRecord[];
    }
  | undefined {
  return resumed === undefined
    ? undefined
    : { runId: resumed.runId, seedLedgerRecords: resumed.seedRecords };
}

/**
 * The startup note for ledger rows the seed could not replay (truncated,
 * corrupt, oversized): the restarted cost view misses them, so the operator
 * must hear that before the first turn. Undefined when every row was read.
 * The path stays LEDGER_BASE_DIR-relative -- never an absolute path outside
 * the target directory.
 */
export function resumeSeedNote(resumed: ResumedLedger): string | undefined {
  if (resumed.skippedRows <= 0) return undefined;
  return `ad-coder: resumed ledger ${LEDGER_BASE_DIR}/${resumed.runId}.jsonl skipped ${resumed.skippedRows} unparseable row(s); pre-restart cost is partial\n`;
}

/**
 * Resolve the console's `--resume` request into the run to continue and the
 * rows its restarted cost view replays. Throws a typed `ProjectStoreError`
 * naming the run id and the recovery action whenever nothing qualifies;
 * creates nothing on any path. `maxRecordBytes` bounds one seeded row (0
 * unbounded), matching the durable sink's write-side limit semantics.
 */
export function resolveResumeRun(
  resolvedTargetDir: string,
  request: ResumeRequest,
  maxRecordBytes = 0,
): ResumedLedger {
  if (request.bare) {
    const winner = discoverOrchestratorLedger(resolvedTargetDir, maxRecordBytes);
    if (winner === undefined)
      throw new ProjectStoreError(
        "not_found",
        LEDGER_BASE_DIR,
        "no previous orchestrator session found; start without --resume",
      );
    // Behave exactly as an explicit resume of the winner from here on.
    assertDurableSession(resolvedTargetDir, winner.runId);
    return {
      runId: winner.runId,
      ledgerPath: orchestratorLedgerPath(resolvedTargetDir, winner.runId),
      seedRecords: winner.records,
      skippedRows: winner.skippedRows,
    };
  }
  return resolveExplicitResume(resolvedTargetDir, request.runId, maxRecordBytes);
}
