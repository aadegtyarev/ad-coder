/**
 * `ad-coder runs stop <runId>`: stop ONE run, addressed through the process
 * identity its own record carries (issue #479).
 *
 * WHY A RECORD-ADDRESSED STOP EXISTS. A run has an identity -- its `runId`,
 * its ledger, its record under `.ad-coder/runs/` -- but until #479 nothing
 * linked the id to a pid, so "stop my run" could only be spelled as a
 * machine-wide command-line match. A lane cleaning up its own stuck
 * `cli.ts role coder` process matched every lane at once and killed another
 * lane's run (2026-09-20, pids 1650952/1650955/1650958). This command makes
 * the identity the instrument: it reads the record the RUN wrote about
 * itself, and signals nothing it cannot positively tie to that record.
 *
 * THE REFUSAL RULE. Every fact is checked before the first signal leaves
 * this process: the record exists, carries a pid, that pid is alive and not
 * an unreaped zombie, its /proc start time matches the recorded one (a
 * reused pid fails here), and its command line carries BOTH the stopper's
 * `--target-dir` spelling AND the run's own witness tokens. Any miss refuses
 * with the checks printed -- non-zero exit, NOTHING signalled -- because
 * "cannot prove it is this run" and "is this run" are different facts and
 * only one of them may be signalled. The one miss that is not a refusal is a
 * dead pid: a run whose recorded process is gone reads as ALREADY GONE,
 * never as a crash and never as a success that stopped something.
 *
 * THE WITNESS BEFORE THE SIGNAL. The stop request (`writeRunStopRequest`) is
 * on disk before the first signal leaves, so a victim that dies before it
 * can record anything still says "I was stopped, not fallen over": its
 * record's pause carries the request (`signal`, `stopRequest`) and consumes
 * the witness. When this command confirms the death itself (escalation, or
 * the victim vanished between the checks and the signal), it also removes a
 * witness the victim demonstrably never consumed, so a stale request cannot
 * brand a later, unrelated interruption of the same runId.
 *
 * TARGET SPELLING. The identity check compares exact argv tokens, and a
 * victim's argv carries the `--target-dir` spelling its starter typed. The
 * command therefore verifies against the spelling the operator passes HERE,
 * and the target directory must be spelled as the run was started; a
 * different spelling of the same directory (a symlink's real path, `~`,
 * relative vs absolute) is a refusal naming the mismatch -- a near-miss is
 * refused, never guessed around.
 *
 * EXIT CODES (rendered in the command's own help, from the registry):
 *   0  a signal was delivered to the verified pid (escalated when --kill)
 *   1  nothing to stop -- no record names the id, or the run is already gone
 *   2  usage error (handled by the front: unknown action, missing id, ...)
 *   3  refusal -- the record's identity does not positively tie its pid to
 *      this run and target; what was checked is printed, nothing signalled
 *
 * Usage errors stay with the front (src/cli.ts's registry closure calls
 * `fail`), so this module's own failures are exactly the checked outcomes:
 * not-found, already-gone, and refusal.
 */
import * as path from "node:path";
import {
  consumeRunStopRequest,
  findStoppableRunRecord,
  processIsAlive,
  type StoppableRunRecord,
  verifyStopTarget,
  writeRunStopRequest,
} from "../orchestration/run-stop";
import { ProjectStore } from "../project-store/project-store";
import { ProjectStoreError } from "../project-store/types";

/** The bounded SIGTERM-to-SIGKILL escalation wait a `--kill` stop uses. */
export const DEFAULT_KILL_AFTER_MS = 2_000;
/** Grace after SIGKILL; SIGKILL cannot be handled, so this only bounds the read. */
const KILL_CONFIRM_GRACE_MS = 1_000;
/** Liveness poll period inside both bounded waits. */
const ALIVE_POLL_MS = 50;

export interface RunsStopParams {
  runId: string;
  /**
   * The `--target-dir` spelling the operator passed, used BOTH to find the
   * record and as the token the run's own command line must carry (see the
   * module header on target spelling).
   */
  targetDir: string;
  json: boolean;
  kill: boolean;
  group: boolean;
  killAfterMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One signal to the pid -- or, only when the record proved group leadership,
 * to the whole group. ESRCH means the target vanished between the checks and
 * the signal; anything else is unexpected and propagates.
 */
function signalRun(
  pid: number,
  group: number | undefined,
  signal: "SIGTERM" | "SIGKILL",
): "delivered" | "already_gone" {
  try {
    process.kill(group === undefined ? pid : -group, signal);
    return "delivered";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "already_gone";
    throw error;
  }
}

/** The machine-front error shape (`docs/contracts/errors.md`), on stderr. */
function writeJsonError(code: string, detail: string, text: string, nextAction?: string): void {
  process.stderr.write(
    `${JSON.stringify({
      error: {
        code,
        detail,
        text,
        retryable: false,
        ...(nextAction === undefined ? {} : { nextAction }),
      },
    })}\n`,
  );
}

/** A refusal prints exactly what was checked and exits 3. It signals NOTHING. */
function refuse(
  json: boolean,
  runId: string,
  reason: string,
  checked: Record<string, unknown>,
  nextAction: string,
): never {
  if (json) {
    // One structured record, the checks INSIDE it: a machine front gets the
    // whole refusal on stderr and nothing on stdout.
    process.stderr.write(
      `${JSON.stringify({
        error: {
          code: "run_stop_refused",
          detail: runId,
          text: reason,
          retryable: false,
          nextAction,
          checked,
        },
      })}\n`,
    );
  } else {
    process.stderr.write(
      `ad-coder: refusing to stop run ${runId}: ${reason}\n` +
        `checked: ${JSON.stringify(checked)}\n` +
        `nothing was signalled; ${nextAction}\n`,
    );
  }
  process.exit(3);
}

/** The already-gone outcome: exit 1, named as such, nothing signalled. */
function alreadyGone(json: boolean, runId: string, text: string, nextAction: string): never {
  if (json) writeJsonError("run_already_gone", runId, text, nextAction);
  else process.stderr.write(`ad-coder: ${text}\n`);
  process.exit(1);
}

export async function runsStopCommand(params: RunsStopParams): Promise<void> {
  const { runId, targetDir, json, kill, group, killAfterMs } = params;

  let record: StoppableRunRecord | undefined;
  try {
    record = findStoppableRunRecord(targetDir, runId);
  } catch (error) {
    if (!(error instanceof ProjectStoreError)) throw error;
    // A record that cannot be READ cannot be tied to anything: that is a
    // refusal, not a crash -- and never a signal.
    refuse(
      json,
      runId,
      `the run record could not be read: ${error.message}`,
      {
        recordRead: error.code,
        record: error.path ?? null,
      },
      "inspect the record file; a corrupt record names no trustworthy pid",
    );
  }
  if (record === undefined) {
    const runsDir = path.join(targetDir, ".ad-coder", "runs");
    const text = `no run record named ${runId} under ${runsDir}; nothing was signalled`;
    if (json)
      writeJsonError(
        "run_not_found",
        runId,
        text,
        "check the run id and the --target-dir spelling (the record lives under <target>/.ad-coder/runs/)",
      );
    else process.stderr.write(`ad-coder: ${text}\n`);
    process.exit(1);
  }

  const kind = record.kind === "standalone" ? "standalone role run" : "background run";
  const identity = record.identity;
  if (identity === undefined) {
    refuse(
      json,
      runId,
      `the ${kind} record carries no process identity; nothing recorded a pid for it`,
      { state: record.state ?? null, record: record.path },
      "records written before a run recorded its own process name no pid; restart the run to record one",
    );
  }

  const verification = verifyStopTarget({
    identity,
    stopperTargetDir: targetDir,
    cmdlineWitness: record.cmdlineWitness,
  });
  if (!verification.ok) {
    const { checked, reason } = verification;
    // The ONE dead-shaped miss: the recorded process is gone (never started,
    // exited, or an unreaped zombie). That is an outcome -- "already gone" --
    // not a crash and not a stop.
    if (checked.pidAlive === false || checked.state === "Z") {
      alreadyGone(
        json,
        runId,
        `run ${runId} is already gone (${reason}); nothing was signalled`,
        "nothing to stop; resume the run from its durable state if its record is paused",
      );
    }
    refuse(
      json,
      runId,
      reason,
      checked,
      `inspect ${record.path}; the record's identity must name this run's own live process`,
    );
  }

  // The group signal is refused BEFORE any signal -- including the pid-alone
  // one a non-group stop would have sent -- when the record cannot prove the
  // run leads its own process group. A shared group belongs to the lane that
  // started the run; signalling it is exactly the 2026-09-20 defect.
  let groupTarget: number | undefined;
  if (group) {
    const recorded = identity.groupId;
    const live = verification.live.groupId;
    const proven =
      recorded !== undefined &&
      live !== undefined &&
      recorded === identity.pid &&
      live === recorded;
    if (!proven) {
      refuse(
        json,
        runId,
        `the record does not prove the run leads its own process group (recorded group ${recorded ?? "none"}, live group ${live ?? "none"}, pid ${identity.pid}); the group may belong to the lane that started the run`,
        {
          pid: identity.pid,
          recordedGroup: recorded ?? null,
          liveGroup: live ?? null,
        },
        "drop --group to signal the pid alone, or restart the run under a launcher that makes it a group leader",
      );
    }
    groupTarget = recorded;
  }

  // The store is constructed only here, after a record exists: a stop against
  // a mistyped id leaves the project untouched.
  const store = new ProjectStore(targetDir);
  // The witness is durable BEFORE the first signal: a victim that dies before
  // it can record anything is still distinguishable, through its own pause
  // write, from one that fell over.
  writeRunStopRequest(store, runId, "SIGTERM");
  const targetDesc =
    groupTarget === undefined ? `pid ${identity.pid}` : `process group ${groupTarget}`;
  if (signalRun(identity.pid, groupTarget, "SIGTERM") === "already_gone") {
    // Dead in the race between the checks and the signal: it can never have
    // consumed the witness this command just wrote, so remove it -- a stale
    // request must not brand a later, unrelated interruption of the same id.
    consumeRunStopRequest(store, runId);
    alreadyGone(
      json,
      runId,
      `run ${runId} is already gone: it exited between the identity checks and the signal; nothing was signalled`,
      "nothing to stop; resume the run from its durable state if its record is paused",
    );
  }

  // Opt-in escalation: a bounded wait, then SIGKILL to the same target. The
  // liveness read is the run's own pid even in group mode -- the group signal
  // reaches it, and its death is what "stopped" means.
  const alive = (): boolean => processIsAlive(identity.pid);
  let escalated = false;
  let exitAfterMs: number | undefined;
  if (kill) {
    const start = Date.now();
    const termDeadline = start + killAfterMs;
    while (alive() && Date.now() < termDeadline) await sleep(ALIVE_POLL_MS);
    if (alive()) {
      signalRun(identity.pid, groupTarget, "SIGKILL");
      escalated = true;
      const killDeadline = Date.now() + KILL_CONFIRM_GRACE_MS;
      while (alive() && Date.now() < killDeadline) await sleep(ALIVE_POLL_MS);
    }
    if (!alive()) exitAfterMs = Date.now() - start;
  }
  const confirmed = exitAfterMs !== undefined;
  if (confirmed) {
    // Death is confirmed, so whatever the victim did not consume never will
    // be: an unconsumed witness must not outlive the run it brands.
    consumeRunStopRequest(store, runId);
  }

  const result = {
    status: confirmed ? "stopped" : "signalled",
    runId,
    kind,
    pid: identity.pid,
    signal: "SIGTERM",
    ...(groupTarget !== undefined && { group: groupTarget }),
    ...(escalated && { escalated: true }),
    ...(confirmed && { exitAfterMs }),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const groupNote = groupTarget === undefined ? "" : `; process group ${groupTarget} signalled`;
    const line = confirmed
      ? escalated
        ? `run ${runId} (${kind}): SIGKILL sent after SIGTERM went unheeded for ${killAfterMs} ms; ${targetDesc} exited (${exitAfterMs} ms from the first signal)${groupNote}`
        : `run ${runId} (${kind}): ${targetDesc} exited after SIGTERM (${exitAfterMs} ms)${groupNote}`
      : `run ${runId} (${kind}): SIGTERM sent to ${targetDesc}; death not confirmed -- rerun with --kill to wait and escalate${groupNote}`;
    process.stdout.write(`${line}\n`);
  }
  process.exit(0);
}
