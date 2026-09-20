/**
 * Single-writer lease files (docs/contracts/session-manager.md): a legacy
 * standalone console holds a durable lease the manager NEVER opens or steals.
 * States: none / stale (owning pid is dead) / live. A recorded `releasedAt`
 * is the ONLY adoption gate — the kill is not the release.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readOwnedJson, writeOwnedJson } from "./bindings";
import { validateProjectKey } from "./project-keys";
import type { LeaseRecord, SessionLeaseState } from "./types";
import { SessionManagerError } from "./types";

/** Manager-held token prefix; a standalone console records its own form. */
export const MANAGER_TOKEN_PREFIX = "sm:";

export interface LeaseIdentity {
  now(): number;
  hostIsLocal(host: string): boolean;
  pidAlive(pid: number): boolean;
}

export function defaultLeaseIdentity(): LeaseIdentity {
  const localHost = os.hostname();
  return {
    now: () => Date.now(),
    hostIsLocal: (host) => host === localHost,
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        return true; // EPERM &c: a process we cannot signal exists.
      }
    },
  };
}

export interface LeaseProbe {
  state: SessionLeaseState;
  record?: LeaseRecord;
}

export function leasePath(stateDir: string, projectKey: string): string {
  return path.join(stateDir, "leases", `${projectKey}.json`);
}

function readLease(stateDir: string, projectKey: string): LeaseRecord | undefined {
  const raw = readOwnedJson(stateDir, path.join("leases", `${projectKey}.json`));
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null)
    throw new SessionManagerError(
      "session_lease_held",
      true,
      "the project's lease file is malformed; its provenance cannot be established",
      "remove the malformed lease file from the private state directory, then retry",
    );
  return raw as LeaseRecord;
}

function writeLease(stateDir: string, projectKey: string, record: LeaseRecord): void {
  // mkdir before write: the leases subdirectory is owner-private too.
  fs.mkdirSync(path.join(stateDir, "leases"), { recursive: true });
  fs.chmodSync(path.join(stateDir, "leases"), 0o700);
  writeOwnedJson(stateDir, path.join("leases", `${projectKey}.json`), record);
}

/** Classify a persisted lease WITHOUT touching the session it names. */
export function probeLease(
  stateDir: string,
  rawProjectKey: string,
  identity: LeaseIdentity = defaultLeaseIdentity(),
): LeaseProbe {
  // The key becomes a lease FILENAME: validated before any filesystem access.
  const projectKey = validateProjectKey(rawProjectKey);
  const record = readLease(stateDir, projectKey);
  if (record === undefined) return { state: "none" };
  if (record.releasedAt !== undefined) return { state: "released", record };
  if (identity.hostIsLocal(record.host) && !identity.pidAlive(record.pid))
    return { state: "stale", record };
  return { state: "live", record };
}

/** Read-only standalone projection: a LIVE lease the manager does not hold. */
export function isStandaloneLive(probe: LeaseProbe): boolean {
  return probe.state === "live";
}

/**
 * Acquire the manager's own atomic exclusive lease. Two managers cannot both
 * hold one project; a STALE lease is marked released first, because a dead
 * pid is not a release — the record is, and this write IS the record.
 */
export function acquireManagerLease(
  stateDir: string,
  projectKey: string,
  sessionId: string,
  identity: LeaseIdentity = defaultLeaseIdentity(),
): { ownerToken: string } {
  const probe = probeLease(stateDir, projectKey, identity);
  if (probe.state === "live")
    throw new SessionManagerError(
      "session_lease_held",
      false,
      "another live process holds this project's interactive lease; the manager never steals a live session",
      "suggest the holding front detach or accept handoff first",
    );
  if (probe.state === "stale" && probe.record !== undefined)
    writeLease(stateDir, projectKey, { ...probe.record, releasedAt: identity.now() });
  const ownerToken = `${MANAGER_TOKEN_PREFIX}${crypto.randomUUID()}`;
  writeLease(stateDir, projectKey, {
    sessionId,
    pid: process.pid,
    host: os.hostname(),
    ownerToken,
    createdAt: identity.now(),
  });
  return { ownerToken };
}

/** Record the standalone release in the SAME lease row the manager probed. */
export function recordStandaloneReleaseInLease(
  stateDir: string,
  projectKey: string,
  sessionId: string,
  identity: LeaseIdentity = defaultLeaseIdentity(),
): void {
  const probe = probeLease(stateDir, projectKey, identity);
  if (probe.record === undefined || probe.record.sessionId !== sessionId)
    throw new SessionManagerError(
      "handoff_not_recorded",
      false,
      "no live lease naming that session exists to release",
      "the standalone console releases through :handoff accept on its own lease",
    );
  writeLease(stateDir, projectKey, {
    ...probe.record,
    releasedAt: identity.now(),
  });
}

export function releaseLease(
  stateDir: string,
  projectKey: string,
  identity: LeaseIdentity = defaultLeaseIdentity(),
): void {
  const probe = probeLease(stateDir, projectKey, identity);
  if (probe.record !== undefined && probe.record.releasedAt === undefined)
    writeLease(stateDir, projectKey, { ...probe.record, releasedAt: identity.now() });
}

/** Adoption matches the probed session id AND the accepted handoff proposal. */
export function ensureLeaseMatchesSession(
  probe: LeaseProbe,
  sessionId: string,
  accepted?: { sessionId: string },
): void {
  if (probe.record !== undefined && probe.record.sessionId !== sessionId)
    throw new SessionManagerError(
      "handoff_not_recorded",
      false,
      "the recorded lease names a different session than the project's shared one",
      "resolve the lease mismatch before adopting",
    );
  if (accepted !== undefined && accepted.sessionId !== sessionId)
    throw new SessionManagerError(
      "handoff_not_recorded",
      false,
      "the accepted handoff names a different session than the project's shared one",
      "resolve the handoff mismatch before adopting",
    );
}

// Re-export for wiring layers that clear an adopted manager lease.
export { MANAGER_TOKEN_PREFIX as managerTokenPrefix };
