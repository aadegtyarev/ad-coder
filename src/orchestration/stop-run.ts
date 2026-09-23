/**
 * Programmatic counterpart of `ad-coder runs stop`.
 *
 * This deliberately owns the policy (identity verification, durable stop
 * witness, and bounded optional escalation) but no command-line parsing,
 * output, or process exit. Fronts render its typed result themselves.
 */
import * as path from "node:path";
import { ProjectStore } from "../project-store/project-store";
import { ProjectStoreError } from "../project-store/types";
import {
  consumeRunStopRequest,
  findStoppableRunRecord,
  processIsAlive,
  type StoppableRunRecord,
  verifyStopTarget,
  writeRunStopRequest,
} from "./run-stop";

export const DEFAULT_RUN_STOP_KILL_AFTER_MS = 2_000;
const KILL_CONFIRM_GRACE_MS = 1_000;
const ALIVE_POLL_MS = 50;

export interface StopRunInput {
  runId: string;
  /** Exact target-dir spelling that the run's command line must carry. */
  targetDir: string;
  /** Wait, then escalate to SIGKILL if SIGTERM did not end the verified run. */
  kill?: boolean;
  /** Signal the process group only when the record proves it is run-owned. */
  group?: boolean;
  killAfterMs?: number;
}

export interface StopRunSuccess {
  runId: string;
  kind: "standalone" | "background";
  pid: number;
  groupId?: number;
  escalated: boolean;
  exited: boolean;
  exitAfterMs?: number;
}

export type StopRunOutcome =
  | { status: "stopped" | "signalled"; result: StopRunSuccess }
  | { status: "already_gone"; runId: string; reason: string; nextAction: string }
  | { status: "not_found"; runId: string; checked: string[]; nextAction: string }
  | {
      status: "refused";
      runId: string;
      reason: string;
      checked: Record<string, unknown>;
      nextAction: string;
    };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function signal(pid: number, groupId: number | undefined, value: "SIGTERM" | "SIGKILL") {
  try {
    process.kill(groupId === undefined ? pid : -groupId, value);
    return "delivered" as const;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "already_gone" as const;
    throw error;
  }
}

/** Safely request one recorded run to stop, without rendering or exiting. */
export async function stopRun(input: StopRunInput): Promise<StopRunOutcome> {
  const { runId, targetDir, kill = false, group = false } = input;
  const killAfterMs = input.killAfterMs ?? DEFAULT_RUN_STOP_KILL_AFTER_MS;
  let record: StoppableRunRecord | undefined;
  try {
    record = findStoppableRunRecord(targetDir, runId);
  } catch (error) {
    if (!(error instanceof ProjectStoreError)) throw error;
    return {
      status: "refused",
      runId,
      reason: `the run record could not be read: ${error.message}`,
      checked: { recordRead: error.code, record: error.path ?? null },
      nextAction: "inspect the record file; a corrupt record names no trustworthy pid",
    };
  }
  if (record === undefined) {
    const runs = path.join(targetDir, ".ad-coder", "runs");
    return {
      status: "not_found",
      runId,
      checked: [
        path.join(runs, `standalone-${runId}.json`),
        path.join(runs, "background", `${runId}.json`),
      ],
      nextAction: "check the run id and exact target directory spelling",
    };
  }
  if (record.identity === undefined) {
    return {
      status: "refused",
      runId,
      reason: "the run record carries no process identity",
      checked: { state: record.state ?? null, record: record.path },
      nextAction: "restart the run so it records its process identity",
    };
  }
  const verification = verifyStopTarget({
    identity: record.identity,
    stopperTargetDir: targetDir,
    cmdlineWitness: record.cmdlineWitness,
  });
  if (!verification.ok) {
    if (verification.checked.pidAlive === false || verification.checked.state === "Z") {
      return {
        status: "already_gone",
        runId,
        reason: verification.reason,
        nextAction: "nothing to stop; resume from durable state if the run is paused",
      };
    }
    return {
      status: "refused",
      runId,
      reason: verification.reason,
      checked: verification.checked,
      nextAction: `inspect ${record.path}; it must name this run's live process`,
    };
  }
  let groupId: number | undefined;
  if (group) {
    const recorded = record.identity.groupId;
    const live = verification.live.groupId;
    if (
      recorded === undefined ||
      live === undefined ||
      recorded !== record.identity.pid ||
      live !== recorded
    ) {
      return {
        status: "refused",
        runId,
        reason: "the record does not prove the run leads its own process group",
        checked: {
          pid: record.identity.pid,
          recordedGroup: recorded ?? null,
          liveGroup: live ?? null,
        },
        nextAction: "drop group mode or restart the run under a detached group-owning launcher",
      };
    }
    groupId = recorded;
  }
  const store = new ProjectStore(targetDir);
  writeRunStopRequest(store, runId, "SIGTERM");
  if (signal(record.identity.pid, groupId, "SIGTERM") === "already_gone") {
    consumeRunStopRequest(store, runId);
    return {
      status: "already_gone",
      runId,
      reason: "the process exited between identity verification and SIGTERM",
      nextAction: "nothing to stop; resume from durable state if the run is paused",
    };
  }
  let escalated = false;
  let exitAfterMs: number | undefined;
  const pid = record.identity.pid;
  const alive = () => processIsAlive(pid);
  if (kill) {
    const started = Date.now();
    while (alive() && Date.now() < started + killAfterMs) await sleep(ALIVE_POLL_MS);
    if (alive()) {
      signal(record.identity.pid, groupId, "SIGKILL");
      escalated = true;
      const deadline = Date.now() + KILL_CONFIRM_GRACE_MS;
      while (alive() && Date.now() < deadline) await sleep(ALIVE_POLL_MS);
    }
    if (!alive()) exitAfterMs = Date.now() - started;
  }
  if (exitAfterMs !== undefined) consumeRunStopRequest(store, runId);
  const result: StopRunSuccess = {
    runId,
    kind: record.kind,
    pid: record.identity.pid,
    ...(groupId !== undefined && { groupId }),
    escalated,
    exited: exitAfterMs !== undefined,
    ...(exitAfterMs !== undefined && { exitAfterMs }),
  };
  return { status: result.exited ? "stopped" : "signalled", result };
}
