import * as fs from "node:fs";
import * as path from "node:path";
import { ProjectStore } from "../project-store/project-store";
import { ProjectStoreError } from "../project-store/types";

/**
 * The process identity a started run records about itself (issue #479).
 *
 * A run HAS identity -- `runId` in its record and its own ledger -- but until
 * #479 nothing linked the runId to a pid, so "stop my run" could only mean
 * "stop everything similar", and a lane cleaning up its own stuck run matched
 * another lane's `cli.ts role coder` process and killed its process GROUP
 * (pids 1650952/1650955/1650958, measured 2026-09-20). The link is written by
 * the run's own process at start, so a record naming a pid is that run's
 * self-description, never an observer's guess.
 */
export interface RunProcessIdentity {
  pid: number;
  /**
   * `/proc/<pid>/stat` field 22 (clock ticks since boot), the same read
   * test/preload.ts uses for run-root ownership. Comparing it at stop time
   * pins the pid against reuse: a reused pid's start time differs. Undefined
   * where procfs is unavailable (macOS), which degrades the guard -- the
   * argv checks below stay.
   */
  startTime?: string;
  /**
   * `/proc/<pid>/stat` field 5 (pgrp). A detached background worker is its
   * own group leader: the launcher's `detached` spawn puts the child in its
   * own process group (measured 2026-09-20 under both `bun run` and `bun
   * test`: a detached child reports pgrp == pid), while a role run in a lane
   * shares the lane's group -- so `groupId === pid` in the record is the
   * proof that an escalated stop may touch the group at all, and anything
   * else means the group belongs to someone else and is never signalled.
   */
  groupId?: number;
}

/**
 * The additive stop-request a stopper writes BEFORE it signals (issue #479),
 * keyed by runId under `.ad-coder/runs/`. It is the witness that says "this
 * run was asked to stop" when the victim dies before it can write anything:
 * a run found dead with this file present was stopped, not fallen over.
 */
export interface RunStopRequest {
  runId: string;
  /** Wall clock at the write, so a victim can order itself against it. */
  requestedAt: number;
  /** The pid of the process that asked. */
  requesterPid: number;
  /** The first signal the stop delivers. */
  signal: "SIGTERM";
}

/** What a live process reports about itself; every read targets ONE pid. */
export interface LiveProcessIdentity {
  pid: number;
  /** `ps -o args= -p <pid>` for this pid only, split into argv-like tokens. */
  argv: string[];
  startTime?: string;
  groupId?: number;
  /** procfs state letter; "Z" is an exited process nobody has reaped yet. */
  state?: string;
}

/** One `process.kill(pid, 0)` liveness read; EPERM is alive-but-not-ours. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read `/proc/<pid>/stat` for one pid: state letter, process group, and the
 * start time that pins the pid against reuse. Undefined when procfs says
 * nothing (macOS, hidepid, the process was reaped); callers must degrade --
 * "cannot read it" never means "kill it".
 *
 * The tail starts at field 3 (state) after `) `, so pgrp is index 2 and
 * starttime (field 22) is index 19 -- the same offsets test/preload.ts uses
 * for run-root ownership markers. (Index 1 is the PARENT pid, not the group:
 * an off-by-one there once recorded every worker's parent as its "group",
 * which would have made a group stop hit the spawner's lane -- issue #479.)
 */
export function readProcessStat(
  pid: number,
): { state: string; groupId: string; startTime: string } | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(" ");
    const [state = "", , pgrp = "", , , , , , , , , , , , , , , , , starttime = ""] = tail;
    if (state === "" || pgrp === "" || starttime === "") return undefined;
    return { state, groupId: pgrp, startTime: starttime };
  } catch {
    return undefined;
  }
}

/**
 * Read the command line of ONE pid via `ps -o args= -p <pid>` -- never a
 * table scan. Undefined when ps reports nothing (dead pid, unreapable
 * zombie, kernel thread); an empty result for a live pid is the zombie case
 * the caller distinguishes through `readProcessStat`'s state letter.
 */
export function readProcessArgv(pid: number): string[] | undefined {
  const read = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (read.exitCode !== 0) return undefined;
  const args = read.stdout.toString().trim();
  return args === "" ? undefined : args.split(" ");
}

/** The identity the CURRENT process records about itself at a run's start. */
export function selfProcessIdentity(): RunProcessIdentity {
  const stat = readProcessStat(process.pid);
  return {
    pid: process.pid,
    ...(stat?.startTime !== undefined && { startTime: stat.startTime }),
    ...(stat?.groupId !== undefined && { groupId: Number(stat.groupId) }),
  };
}

/** `stop-<runId>.json` beside the run records it witnesses. */
export function stopRequestPath(store: ProjectStore, runId: string): string {
  return path.join(store.layout.runs, `stop-${store.validateId(runId)}.json`);
}

/** Write the witness atomically; a stop never signals without it on disk. */
export function writeRunStopRequest(
  store: ProjectStore,
  runId: string,
  signal: RunStopRequest["signal"],
): RunStopRequest {
  const request: RunStopRequest = {
    runId,
    requestedAt: Date.now(),
    requesterPid: process.pid,
    signal,
  };
  store.writeVersionedJson(stopRequestPath(store, runId), request);
  return request;
}

/**
 * Read the witness from a victim's side. Absence -- no file, unreadable,
 * corrupt -- reads as "no stop was asked" and never as a crash: this record
 * is advisory for the victim, and throwing from here would turn an external
 * stop into a mystery failure in the victim's own closeout.
 */
export function readRunStopRequest(store: ProjectStore, runId: string): RunStopRequest | undefined {
  try {
    const value = store.readVersionedJson<RunStopRequest>(stopRequestPath(store, runId)).value;
    return typeof value === "object" && value !== null ? (value as RunStopRequest) : undefined;
  } catch (error) {
    if (error instanceof ProjectStoreError) return undefined;
    throw error;
  }
}

/**
 * Remove the witness once a victim has recorded it in its own durable state
 * (pause) or an operator resumed past it. Left behind, a stale request would
 * brand a later, unrelated interruption of the same runId as an external
 * stop. Errors are contained: a witness that would not unlink must not
 * corrupt the victim's closeout.
 */
export function consumeRunStopRequest(store: ProjectStore, runId: string): void {
  try {
    fs.rmSync(stopRequestPath(store, runId), { force: true });
  } catch {
    // The pause already names the request; an unremovable file is logged debris.
  }
}

/**
 * One stoppable run record as `runs stop` reads it: the two record families
 * that carry a process identity are the standalone role checkpoint
 * (`standalone-<runId>.json`) and the detached background worker record
 * (`background/<runId>.json`). Pipeline records (`coordinator-`, `control-`)
 * run inside their host process and have no identity of their own, so they
 * are not found here -- a stop of one reports "no stoppable record" rather
 * than guessing at a host pid.
 */
export interface StoppableRunRecord {
  kind: "standalone" | "background";
  path: string;
  state: string | undefined;
  identity: RunProcessIdentity | undefined;
  /**
   * The token pair the run's own command line carries for THIS run: where the
   * launcher puts the run's identity in argv. A background worker carries
   * `--id <runId>` (createBackgroundHostLauncher, src/cli.ts); a standalone
   * role run carries `role <name>` -- its runId never reaches its argv, which
   * is why the pid and start time are recorded by the run itself.
   */
  cmdlineWitness: readonly [string, string] | undefined;
}

/**
 * Find the run record for `runId` under `targetDir` without creating
 * anything: both candidates are probed with lstat first, so a stop against a
 * mistyped id or an empty directory answers "not found" and leaves the
 * project untouched. The first readable record wins; the two families cannot
 * collide (a runId is generated once, by one family).
 */
export function findStoppableRunRecord(
  targetDir: string,
  runId: string,
): StoppableRunRecord | undefined {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId))
    throw new ProjectStoreError(
      "invalid_id",
      runId,
      `run id must match ${"^[A-Za-z0-9_-]{1,64}$"}`,
    );
  const root = path.join(targetDir, ".ad-coder", "runs");
  const candidates = [
    { kind: "standalone" as const, file: path.join(root, `standalone-${runId}.json`) },
    { kind: "background" as const, file: path.join(root, "background", `${runId}.json`) },
  ];
  const present = candidates.find(({ file }) => {
    try {
      return fs.lstatSync(file).isFile();
    } catch {
      return false;
    }
  });
  if (present === undefined) return undefined;
  // Constructed only when a record exists: a stop against a mistyped id or an
  // empty directory must not leave a freshly created empty store behind.
  const store = new ProjectStore(targetDir);
  const value = store.readVersionedJson<StandaloneRecordShape & BackgroundRecordShape>(
    present.file,
  ).value;
  return {
    kind: present.kind,
    path: present.file,
    state: present.kind === "standalone" ? value.status : value.lifecycle,
    identity: value.process,
    cmdlineWitness:
      present.kind === "standalone"
        ? value.role === undefined
          ? undefined
          : (["role", value.role] as const)
        : (["--id", runId] as const),
  };
}

/** The fields `runs stop` reads; every family leaves the other's absent. */
interface StandaloneRecordShape {
  status?: string;
  role?: string;
  process?: RunProcessIdentity;
}

interface BackgroundRecordShape {
  lifecycle?: string;
  process?: RunProcessIdentity;
}

/**
 * Check the record's process identity against the live process, reading that
 * one pid only. Every failure returns a reason; NOTHING here signals. The
 * checks, in order: alive (`process.kill(pid, 0)`), not a zombie (an exited
 * process nobody reaped is gone as far as the run is concerned and has no
 * argv to identify), start time equal to the recorded one when both sides
 * are readable (the pid-reuse guard), the stopper's target directory in the
 * argv tokens, and the run's own witness tokens. A pid whose argv carries
 * the target inside a LONGER path (`…-scale` vs `…-scale-2`) fails the exact
 * token comparison, which is the point: near-misses are refusals.
 */
export function verifyStopTarget(params: {
  identity: RunProcessIdentity;
  stopperTargetDir: string;
  cmdlineWitness: readonly [string, string] | undefined;
}):
  | { ok: true; live: LiveProcessIdentity }
  | { ok: false; reason: string; checked: Record<string, unknown> } {
  const { identity, stopperTargetDir, cmdlineWitness } = params;
  const checked: Record<string, unknown> = {};
  if (!processIsAlive(identity.pid))
    return {
      ok: false,
      reason: `pid ${identity.pid} is not alive`,
      checked: { ...checked, pidAlive: false },
    };
  const stat = readProcessStat(identity.pid);
  checked.state = stat?.state ?? null;
  if (stat?.state === "Z")
    return {
      ok: false,
      reason: `pid ${identity.pid} exited and was never reaped (state Z)`,
      checked: { ...checked, pidAlive: true },
    };
  checked.startTimeMatches = null;
  if (identity.startTime !== undefined && stat?.startTime !== undefined) {
    checked.startTimeMatches = stat.startTime === identity.startTime;
    if (checked.startTimeMatches === false)
      return {
        ok: false,
        reason: `pid ${identity.pid} start time ${stat.startTime} does not match the recorded ${identity.startTime}; the pid was reused`,
        checked,
      };
  }
  const argv = readProcessArgv(identity.pid);
  checked.argvRead = argv !== undefined;
  if (argv === undefined)
    return {
      ok: false,
      reason: `command line of pid ${identity.pid} could not be read for identification`,
      checked,
    };
  checked.argv = argv;
  checked.targetDirInArgv = argv.includes(stopperTargetDir);
  if (!checked.targetDirInArgv)
    return {
      ok: false,
      reason: `command line of pid ${identity.pid} does not carry the target directory ${stopperTargetDir}`,
      checked,
    };
  checked.witnessInArgv =
    cmdlineWitness !== undefined &&
    argv.some(
      (token, index) => token === cmdlineWitness[0] && argv[index + 1] === cmdlineWitness[1],
    );
  if (checked.witnessInArgv !== true)
    return {
      ok: false,
      reason: `command line of pid ${identity.pid} does not carry the run's own ${
        cmdlineWitness === undefined
          ? "identity tokens"
          : `${cmdlineWitness[0]} ${cmdlineWitness[1]}`
      }`,
      checked,
    };
  return {
    ok: true,
    live: {
      pid: identity.pid,
      argv,
      ...(stat?.startTime !== undefined && { startTime: stat.startTime }),
      ...(stat?.groupId !== undefined && { groupId: Number(stat.groupId) }),
      ...(stat?.state !== undefined && { state: stat.state }),
    },
  };
}
