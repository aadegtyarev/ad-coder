/**
 * The headless SessionManager's own vocabulary (issue #365 layer 2;
 * docs/contracts/session-manager.md). Every public shape here is safe data:
 * a project KEY (a slug, never a path), a session id, a display name, counts
 * and statuses. Resolved filesystem paths stay inside the manager and never
 * surface in an error or an event relay (errors:safe-projection).
 */

import type { AdmissionPriorityClass } from "../provider-admission";
import type { LeaseIdentity } from "./lease";

/** How a displayed name came to be. A manual name is never replaced. */
export type SessionNameSource = "generated" | "manual";

/** The neutral fallback until a title settles or an operator names the session. */
export const SESSION_FALLBACK_NAME = "New session";

/** Driver kinds the handshake accepts. The protocol is exactly two tokens. */
export const DRIVER_KINDS = ["console", "telegram"] as const;
export type DriverKind = (typeof DRIVER_KINDS)[number];

/**
 * Stable per-driver identity the manager binds to a project. DERIVED by the
 * server from a verified same-uid handshake plus the front kind — never a
 * client-supplied request field (docs/contracts/session-manager.md).
 * Shape: `<kind>:<owner token>`, where the owner half is uid- or
 * server-derived and opaque; a client may only ever present the key the
 * server printed for it.
 */
export type DriverKey = string;

export const DRIVER_KEY_PATTERN = /^(console|telegram):[A-Za-z0-9._:-]{1,64}$/;

export function validateDriverKey(input: string): DriverKey {
  if (typeof input !== "string" || !DRIVER_KEY_PATTERN.test(input))
    throw new SessionManagerError(
      "invalid_driver",
      false,
      "driver key must be `<kind>:<owner>` with kind console or telegram, derived by the server",
      "use the driver key the session-manager server attributed to this connection",
    );
  return input;
}

export interface BindingRecord {
  projectKey: string;
  /** FRONT kind attribution on the durable record (a rebind trace names the actor). */
  driverKind: DriverKind;
}

export interface ProjectRecord {
  /** Real-path-validated directory inside an allowed root. Never a secret. */
  targetDir: string;
  /** ONE shared durable conversation; minted once and reused by every front. */
  sessionId: string;
  profile?: string;
  name: string;
  nameSource: SessionNameSource;
  createdAt: number;
}

export interface PersistedBindings {
  version: 1;
  drivers: Record<string, BindingRecord>;
  projects: Record<string, ProjectRecord>;
}

/** A lease file record. A recorded `releasedAt` is the ONLY adoption gate. */
export interface LeaseRecord {
  sessionId: string;
  pid: number;
  host: string;
  ownerToken: string;
  createdAt: number;
  releasedAt?: number;
}

export type SessionLeaseState = "none" | "stale" | "live" | "released";

export interface SessionListItem {
  sessionId: string;
  projectKey: string;
  name: string;
  nameSource: SessionNameSource;
  standalone: boolean;
  leaseState: SessionLeaseState;
  attachedDrivers: number;
  selectedByThisDriver: boolean;
  activeTurn: boolean;
  lastActivityAt: number;
}

/**
 * The safe wire projection of a project record: everything a front may render
 * except the resolved `targetDir`, which never crosses the transport boundary
 * (errors:safe-projection). `projectKey` is a slug, never a path.
 */
export type SessionProjection = Omit<ProjectRecord, "targetDir"> & { projectKey: string };

/**
 * The safe-projection event shape: a monotone sequence number and the envelope
 * only — never a payload, never a resolved path, never a prompt
 * (docs/contracts/session-manager.md, errors:safe-projection).
 */
export interface SafeEventProjection {
  sequence: number;
  kind: string;
  status: string;
  occurredAt: number;
}

export interface EventPage {
  events: readonly SafeEventProjection[];
  nextCursor: number;
  gap: boolean;
}

export interface HandoffProposal {
  sessionId: string;
  state: "proposed" | "accepted" | "adopted";
  proposedAt: number;
}

/** Typed, stable failure codes; projection rules live in errors.ts docs. */
export type SessionManagerErrorCode =
  | "invalid_request"
  | "address_in_use"
  | "invalid_key"
  | "invalid_root"
  | "invalid_binding"
  | "unsafe_path"
  | "not_found"
  | "already_exists"
  | "already_bound"
  | "ambiguous_root"
  | "creation_disabled"
  | "creation_limit"
  | "locked"
  | "invalid_name"
  | "invalid_driver"
  | "invalid_project_key"
  | "project_unsafe"
  | "project_exists"
  | "project_not_found"
  | "session_lease_held"
  | "handoff_pending"
  | "handoff_not_recorded"
  | "not_authorized"
  | "not_bound"
  | "invalid_config"
  | "manager_unavailable";

export class SessionManagerError extends Error {
  override readonly name = "SessionManagerError";
  constructor(
    readonly code: SessionManagerErrorCode,
    readonly retryable: boolean,
    message: string,
    readonly nextAction?: string,
    override readonly cause?: unknown,
    /** An optional NON-SECRET trace label (a key name, a file name) — never a resolved path. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** Safe message projection for a caught session-manager failure. */
export function sessionManagerErrorMessage(error: unknown): string {
  if (error instanceof SessionManagerError) return error.message;
  return "the session-manager state could not be validated";
}

/**
 * The per-project session dependency the manager calls to materialize the ONE
 * shared durable Orchestrator conversation. Satisfied by
 * `ProjectStore.ensureSession` (src/project-store/project-store.ts); wired by
 * `SessionManagerOptions.sessions`, never constructed by a front directly.
 */
export interface ManagerSessionHost {
  ensureSession(sessionId: string): Promise<unknown>;
}

/**
 * The admitted, title-only generation call routed through the controller.
 */
export interface TitleRequest {
  projectKey: string;
  sessionId: string;
  firstUserMessage: string;
  priority: Extract<AdmissionPriorityClass, "title">;
}

export type TitleGenerator = (request: TitleRequest) => Promise<string | undefined>;

/** Durable background-event page behind a caller-owned acknowledged cursor. */
export type SessionManagerEventSource = (
  projectKey: string,
  cursor: number,
  limit: number,
) => EventPage;

export interface SessionManagerOptions {
  /** Absolute allowed roots; project keys resolve to their immediate children. */
  roots: readonly string[];
  /** Owner-private state directory; defaults under XDG_STATE_HOME, never a project. */
  stateDir?: string;
  /** Non-negative-integer creation volume cap with a finite default; `0` disables. */
  maxProjects?: number;
  identity?: LeaseIdentity;
  /**
   * The per-project conversation host; absent (front wiring not yet attached)
   * keeps every record durable and defers materialization to the next open
   * (docs/contracts/session-manager.md: durability precedes transport).
   */
  sessions?: ManagerSessionHost;
  readEvents?: SessionManagerEventSource;
  generateTitle?: TitleGenerator;
  titleMaxLength?: number;
  now?: () => number;
}
