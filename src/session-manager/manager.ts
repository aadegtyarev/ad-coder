/**
 * The headless SessionManager core (issue #365 layer 2;
 * docs/contracts/session-manager.md). One class, one programmatic API — the
 * single declaration both fronts translate (front capability parity); the
 * Unix-socket transport implements this API, never its own policy.
 *
 * Safe data flows out: project KEYS, session ids, display names, counts and
 * statuses. Resolved filesystem paths stay behind these methods
 * (errors:safe-projection).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultStateDir, ensureStateDir, loadBindings, saveBindings } from "./bindings";
import {
  acquireManagerLease,
  defaultLeaseIdentity,
  isStandaloneLive,
  type LeaseIdentity,
  type LeaseProbe,
  probeLease,
  recordStandaloneReleaseInLease,
} from "./lease";
import {
  createProjectDirectories,
  createRuntimeScaffold,
  gitInit,
  type ProjectCreationPaths,
} from "./project-creation";
import { AllowedRoots, resolveProjectDir, validateProjectKey } from "./project-keys";
import { createManualSessionName, DEFAULT_TITLE_MAX_LENGTH, sanitizeTitle } from "./title";
import type { HandoffProposal, PersistedBindings } from "./types";
import {
  type ManagerSessionHost,
  type ProjectRecord,
  SESSION_FALLBACK_NAME,
  type SessionListItem,
  SessionManagerError,
  type SessionManagerOptions,
  type SessionProjection,
  validateDriverKey,
} from "./types";

/** Finite built-in creation-volume default; `max-projects: 0` disables. */
export const DEFAULT_MAX_PROJECTS = 64;

/** Types moved to ./types for option wiring; re-exported for API stability. */
export type { ManagerSessionHost } from "./types";

/**
 * THE stable per-project conversation id: derived from the project key and
 * the owner's configured state root — inputs of the project, never of a
 * process or a clock (docs/contracts/session-manager.md: stable IDs).
 */
export function deriveSessionId(stateDir: string, projectKey: string): string {
  const hash = crypto.createHash("sha256").update(`${stateDir}\u0000${projectKey}`).digest("hex");
  return `sess${hash.slice(0, 18)}`;
}

export class SessionManager {
  readonly roots: AllowedRoots;
  readonly stateDir: string;
  private readonly maxProjects: number;
  private readonly identity: LeaseIdentity;
  private readonly sessions?: ManagerSessionHost | undefined;
  private readonly generateTitle?: SessionManagerOptions["generateTitle"];
  private readonly titleMaxLength: number;
  private readonly now: () => number;
  private readonly loadRejections: readonly { projectKey: string; reason: string }[];
  private bindings: PersistedBindings;

  constructor(options: SessionManagerOptions) {
    this.roots = new AllowedRoots(options.roots);
    this.stateDir = ensureStateDir(options.stateDir ?? defaultStateDir());
    this.maxProjects = validateMaxProjects(options.maxProjects);
    this.identity = options.identity ?? defaultLeaseIdentity();
    this.sessions = options.sessions;
    this.generateTitle = options.generateTitle;
    this.titleMaxLength = options.titleMaxLength ?? DEFAULT_TITLE_MAX_LENGTH;
    this.now = options.now ?? (() => Date.now());
    // Fail-closed load: poisoned records are surfaced here and dropped from
    // the durable file; valid ones still bind (never silently into
    // auto-creation — a poisoned key stays refused).
    const loaded = loadBindings(this.stateDir, this.roots);
    this.loadRejections = loaded.rejected;
    this.bindings = loaded.bindings;
    if (loaded.rejected.length > 0) saveBindings(this.stateDir, this.bindings);
  }

  /** Poisoned persisted records found at load; the caller owns surfacing. */
  get rejectedRecords(): readonly { projectKey: string; reason: string }[] {
    return this.loadRejections;
  }

  // -- listing ------------------------------------------------------------

  /** Managed projects with their lease state, plus standalone-only lists. */
  async listSessions(): Promise<SessionListItem[]> {
    const attached = new Map<string, number>();
    for (const binding of Object.values(this.bindings.drivers))
      attached.set(binding.projectKey, (attached.get(binding.projectKey) ?? 0) + 1);
    const items: SessionListItem[] = [];
    const seenProjectKeys = new Set<string>();
    for (const projectKey of Object.keys(this.bindings.projects)) {
      const probe = probeLease(this.stateDir, projectKey, this.identity);
      seenProjectKeys.add(
        probe.record === undefined ? `none:${projectKey}` : `${probe.record.sessionId}`,
      );
      items.push(this.projectListItem(projectKey, probe, attached));
    }
    // A standalone-only lease (no managed record yet) is read-only listed.
    for (const projectKey of this.standaloneLeaseKeys()) {
      if (seenProjectKeys.has(probeKey(this.stateDir, projectKey, this.identity))) continue;
      const probe = probeLease(this.stateDir, projectKey, this.identity);
      items.push(this.projectListItem(projectKey, probe, attached));
    }
    return items;
  }

  private standaloneLeaseKeys(): string[] {
    const leasesDir = path.join(this.stateDir, "leases");
    let names: string[];
    try {
      names = fs.readdirSync(leasesDir);
    } catch {
      return [];
    }
    const keys: string[] = [];
    for (const name of names) {
      const key = name.replace(/\.json$/, "");
      try {
        if (probeLease(this.stateDir, key, this.identity).state === "live") keys.push(key);
      } catch {
        // A malformed lease file never takes the whole list down.
      }
    }
    return keys;
  }

  private projectListItem(
    projectKey: string,
    probe: LeaseProbe,
    attached: Map<string, number>,
  ): SessionListItem {
    const record = this.bindings.projects[projectKey];
    const standalone = isStandaloneLive(probe);
    return {
      sessionId: record?.sessionId ?? probe.record?.sessionId ?? "standalone",
      projectKey,
      name: record?.name ?? SESSION_FALLBACK_NAME,
      nameSource: record?.nameSource ?? "generated",
      standalone,
      leaseState: probe.state,
      attachedDrivers: attached.get(projectKey) ?? 0,
      selectedByThisDriver: record !== undefined,
      activeTurn: false,
      lastActivityAt: probe.record?.releasedAt ?? probe.record?.createdAt ?? this.now(),
    };
  }

  // -- binding and resolution ---------------------------------------------

  /**
   * `createSession(binding)` (Telegram contract): idempotent open of the ONE
   * shared conversation for `projectKey` by `driverKey`. A live standalone
   * lease is never opened or stolen; adoption of a released legacy lease is
   * the record's own `releasedAt` gate, not a kill.
   */
  async ensureSession(projectKey: string, driverKey: string): Promise<SessionListItem> {
    assertDriverKeyShape(driverKey);
    const key = validateProjectKey(projectKey);
    const bindingForDriver = this.bindings.drivers[driverKey];
    if (bindingForDriver === undefined || bindingForDriver.projectKey !== key) {
      // Attribute the opening front on EVERY path, exactly as the creation
      // path does: an already-existing record must not leave its first
      // opening driver unbound. A front may rebind only its own derived key;
      // a rebind overwrites that single binding, never a second one.
      this.bindings.drivers[driverKey] = {
        projectKey: key,
        driverKind: driverKeyKind(driverKey),
      };
    }
    const record = this.bindings.projects[key];
    if (record === undefined) {
      // A live standalone lease holds this project's single-writer state even
      // when the manager has no record yet: creation would silently stage a
      // shared conversation beside the live one, so it is refused here —
      // the same never-opened-or-stolen rule, applied BEFORE any creation.
      const probeBeforeCreate = probeLease(this.stateDir, key, this.identity);
      if (isStandaloneLive(probeBeforeCreate))
        throw new SessionManagerError(
          "session_lease_held",
          false,
          "a live standalone session holds this project's lease; it is never opened or stolen",
          "use the standalone console, or ask it to accept handoff first",
        );
      // createProject persists the record; `save()` after keeps the rebind in
      // the same atomic file as the fresh record.
      await this.createProject(key);
      this.bindings.drivers[driverKey] = { projectKey: key, driverKind: driverKeyKind(driverKey) };
      this.save();
      const createdRecord = this.bindings.projects[key];
      if (createdRecord === undefined)
        throw new SessionManagerError(
          "invalid_binding",
          false,
          "the freshly created project record could not be read back",
          "list the managed projects and retry the open",
        );
      return this.itemForRecord(key);
    }
    const probe = probeLease(this.stateDir, key, this.identity);
    if (probe.record !== undefined && probe.record.sessionId !== record.sessionId) {
      if (probe.state !== "released")
        throw new SessionManagerError(
          "handoff_not_recorded",
          false,
          "a live lease names a different session than the project's shared conversation",
          "let the holding front accept handoff first",
        );
    }
    if (isStandaloneLive(probe))
      throw new SessionManagerError(
        "session_lease_held",
        false,
        "a live standalone session holds this project's lease; it is never opened or stolen",
        "use the standalone console, or ask it to accept handoff first",
      );
    if (probe.state === "stale" || probe.state === "none")
      acquireManagerLease(this.stateDir, key, record.sessionId, this.identity);
    this.save();
    await this.materialize(record);
    return this.itemForRecord(key);
  }

  /**
   * Bind an ALREADY-RESOLVED project to a driver without creating anything;
   * the directory must exist inside a root (a `not_found` otherwise).
   */
  async bindDriver(projectKey: string, driverKey: string): Promise<void> {
    validateDriverKey(driverKey);
    const key = validateProjectKey(projectKey);
    const resolved = resolveProjectDir(this.roots, key);
    if (resolved?.exists !== true)
      throw new SessionManagerError(
        "project_not_found",
        false,
        "no project directory occupies that key under an allowed root",
        "create the project first, or check the configured allowed roots",
      );
    this.bindings.drivers[driverKey] = { projectKey: key, driverKind: driverKeyKind(driverKey) };
    this.bindings.projects[key] ??= {
      targetDir: resolved.dirReal,
      sessionId: deriveSessionId(this.stateDir, key),
      name: SESSION_FALLBACK_NAME,
      nameSource: "generated",
      createdAt: this.now(),
    };
    this.save();
  }

  /** `destroySession(binding)`: drop the front's binding, never the project. */
  unbindDriver(driverKey: string, projectKey?: string): void {
    validateDriverKey(driverKey);
    const binding = this.bindings.drivers[driverKey];
    if (binding === undefined)
      throw new SessionManagerError(
        "not_bound",
        false,
        "that front has no project binding",
        "bind a project first",
      );
    if (projectKey !== undefined && binding.projectKey !== projectKey)
      throw new SessionManagerError(
        "invalid_binding",
        false,
        "the front's binding does not name that project",
        "list the front's binding first",
      );
    delete this.bindings.drivers[driverKey];
    this.save();
  }

  /**
   * Safe project creation: a NEW, non-existing slug immediately under an
   * allowed root; `git init` (argv array, no shell) and ONLY the minimal
   * ignored runtime scaffold. A `0` volume cap disables; the cap counts the
   * durable manifest so restart cannot mint more than configured.
   */
  async createProject(projectKey: string): Promise<{ targetDir: string; sessionId: string }> {
    validateProjectKey(projectKey);
    if (this.maxProjects === 0)
      throw new SessionManagerError(
        "creation_disabled",
        false,
        "project creation is disabled (`session-manager.max-projects: 0`)",
        "raise max-projects in settings.yaml to allow creation",
      );
    const count = Object.keys(this.bindings.projects).length;
    if (count >= this.maxProjects)
      throw new SessionManagerError(
        "creation_limit",
        false,
        `the project creation volume cap (${this.maxProjects}) is reached`,
        "remove old projects or raise session-manager.max-projects",
      );
    if (resolveProjectDir(this.roots, projectKey) !== undefined)
      throw new SessionManagerError(
        "project_exists",
        false,
        "a project with that key already exists",
        "list existing projects first; safe creation never overwrites",
      );
    const rootReal = this.roots.values.find((root) => {
      try {
        fs.statSync(path.join(root, projectKey));
        return false;
      } catch {
        return true;
      }
    });
    if (rootReal === undefined)
      throw new SessionManagerError(
        "invalid_key",
        false,
        "the project key is occupied under some root or no root accepts it",
        "choose another slug",
      );
    const paths: ProjectCreationPaths = createProjectDirectories(rootReal, projectKey);
    createRuntimeScaffold(paths);
    gitInit(paths.dirReal);
    const record: ProjectRecord = {
      targetDir: paths.dirReal,
      sessionId: deriveSessionId(this.stateDir, projectKey),
      name: SESSION_FALLBACK_NAME,
      nameSource: "generated",
      createdAt: this.now(),
    };
    this.bindings.projects[projectKey] = record;
    this.save();
    await this.materialize(record);
    return { targetDir: paths.dirReal, sessionId: record.sessionId };
  }

  // -- names and titles ----------------------------------------------------

  /**
   * A manual display name: bounded, control-stripped, secret-screened (a
   * screened draft leaves the neutral fallback), and never replaced by a later
   * generated title.
   */
  async renameSession(projectKey: string, rawName: string): Promise<SessionProjection> {
    const key = validateProjectKey(projectKey);
    const record = this.requireRecord(key);
    record.name = createManualSessionName(rawName);
    record.nameSource = "manual";
    this.save();
    return this.projectRecord(key, record);
  }

  /**
   * A generated title passes the ONE shared sanitizer before persisting, and
   * only ever REPLACES a generated name: a manual name is never replaced
   * (docs/contracts/session-manager.md). A screen or length failure leaves
   * the neutral fallback (`New session`).
   */
  async setTitleFromGeneration(
    projectKey: string,
    draft: string | undefined,
  ): Promise<SessionProjection> {
    const key = validateProjectKey(projectKey);
    const record = this.requireRecord(key);
    if (record.nameSource === "manual") return this.projectRecord(key, record);
    const sanitized = sanitizeTitle(draft, this.titleMaxLength);
    record.name = sanitized.value;
    record.nameSource = "generated";
    this.save();
    return this.projectRecord(key, record);
  }

  /**
   * The title-only LLM call, routed through the owned
   * ProviderAdmissionController by the wiring (lowerest priority class
   * `title`); the manager only persists its bounded outcome.
   */
  async generateAndApplyTitle(
    projectKey: string,
    firstUserMessage: string,
  ): Promise<SessionProjection> {
    const key = validateProjectKey(projectKey);
    const record = this.requireRecord(key);
    if (this.generateTitle === undefined || record.nameSource === "manual")
      return this.projectRecord(key, record);
    try {
      const draft = await this.generateTitle({
        projectKey: key,
        sessionId: record.sessionId,
        firstUserMessage,
        priority: "title",
      });
      if (draft === undefined) return this.projectRecord(key, record);
      return await this.setTitleFromGeneration(key, draft);
    } catch {
      // A failed title call leaves the neutral fallback by design.
      return this.projectRecord(key, record);
    }
  }

  // -- leases and handoff ---------------------------------------------------

  /**
   * Handoff is PROPOSE-ONLY from the manager: the standalone console accepts
   * with its own durable release; adoption happens after the recorded release
   * exists in the SAME lease row. `read-only standalone` live leases refuse
   * every adopt attempt (`session_lease_held`).
   */
  async proposeHandoff(projectKey: string): Promise<HandoffProposal> {
    const key = validateProjectKey(projectKey);
    const probe = probeLease(this.stateDir, key, this.identity);
    if (!isStandaloneLive(probe))
      throw new SessionManagerError(
        "handoff_pending",
        false,
        "no live standalone lease exists to hand off",
        "handoff applies to a live standalone session only",
      );
    return {
      sessionId: probe.record?.sessionId ?? "",
      state: "proposed",
      proposedAt: this.now(),
    };
  }

  /**
   * The standalone side records its release in its OWN lease row; the manager
   * never writes another owner's lease — this is the console's action
   * surfaced once it settles its active turn.
   */
  async adoptAfterRelease(projectKey: string): Promise<SessionListItem> {
    const key = validateProjectKey(projectKey);
    const probe = probeLease(this.stateDir, key, this.identity);
    const sessionId = probe.record?.sessionId ?? this.bindings.projects[key]?.sessionId;
    if (
      probe.record === undefined ||
      sessionId === undefined ||
      probe.record.releasedAt === undefined
    )
      throw new SessionManagerError(
        "handoff_not_recorded",
        false,
        "the standalone side has not recorded its release; adoption is refused",
        "wait for :handoff accept to settle before adopting",
      );
    if (this.bindings.projects[key] === undefined) {
      await this.bindDriver(key, `console:u${process.getuid?.() ?? 0}`);
      // Destructure instead of re-indexing: control flow has already narrowed
      // the indexed read, and bindDriver's write is invisible to it.
      const { [key]: record } = this.bindings.projects;
      if (record === undefined)
        throw new SessionManagerError(
          "invalid_binding",
          false,
          "the adopted project record could not be read back after binding",
          "list the managed projects and retry the adoption",
        );
      record.sessionId = sessionId;
      this.save();
    }
    return this.itemForRecord(key);
  }

  /**
   * The standalone side's release record (called on that side, never by the
   * manager for a live lease it does not own).
   */
  recordStandaloneRelease(projectKey: string): void {
    const key = validateProjectKey(projectKey);
    const record = this.bindings.projects[key];
    recordStandaloneReleaseInLease(this.stateDir, key, record?.sessionId ?? "", this.identity);
  }

  // -- internals --------------------------------------------------------------

  private async materialize(record: ProjectRecord): Promise<void> {
    if (this.sessions === undefined) return;
    try {
      await this.sessions.ensureSession(record.sessionId);
    } catch {
      // The durable record exists; materialization retries on the next open.
    }
  }

  private itemForRecord(projectKey: string): SessionListItem {
    const probe = probeLease(this.stateDir, projectKey, this.identity);
    return this.projectListItem(projectKey, probe, this.attachedMap());
  }

  private attachedMap(): Map<string, number> {
    const attached = new Map<string, number>();
    for (const binding of Object.values(this.bindings.drivers))
      attached.set(binding.projectKey, (attached.get(binding.projectKey) ?? 0) + 1);
    return attached;
  }

  private requireRecord(projectKey: string): ProjectRecord {
    const record = this.bindings.projects[projectKey];
    if (record === undefined)
      throw new SessionManagerError(
        "project_not_found",
        false,
        "no managed project record carries that key",
        "list the managed projects first",
      );
    return record;
  }

  /** Safe wire shape: the durable record minus the resolved `targetDir`. */
  private projectRecord(projectKey: string, record: ProjectRecord): SessionProjection {
    return {
      projectKey,
      sessionId: record.sessionId,
      name: record.name,
      nameSource: record.nameSource,
      createdAt: record.createdAt,
      ...(record.profile !== undefined ? { profile: record.profile } : {}),
    };
  }

  private save(): void {
    saveBindings(this.stateDir, this.bindings);
  }
}

function probeKey(stateDir: string, projectKey: string, identity: LeaseIdentity): string {
  return probeLease(stateDir, projectKey, identity).record?.sessionId ?? projectKey;
}

function validateMaxProjects(maxProjects: number | undefined): number {
  if (maxProjects === undefined) return DEFAULT_MAX_PROJECTS;
  if (typeof maxProjects !== "number" || !Number.isInteger(maxProjects) || maxProjects < 0)
    throw new SessionManagerError(
      "invalid_config",
      false,
      "maxProjects must be a non-negative integer (`0` disables creation)",
      "set session-manager.max-projects to a non-negative integer",
    );
  return maxProjects;
}

function assertDriverKeyShape(driverKey: string): void {
  if (
    typeof driverKey !== "string" ||
    !/^(console|telegram):[A-Za-z0-9._:-]{1,64}$/.test(driverKey)
  )
    throw new SessionManagerError(
      "invalid_driver",
      false,
      "driver key must be `<kind>:<owner>` with kind console or telegram, derived by the server",
      "use the driver key the session-manager server attributed to this connection",
    );
}

function driverKeyKind(driverKey: string): "console" | "telegram" {
  const kind = driverKey.split(":")[0] ?? "";
  if (kind === "console" || kind === "telegram") return kind;
  throw new SessionManagerError(
    "invalid_driver",
    false,
    "driver kind must be console or telegram",
    "use the driver key the session-manager server attributed to this connection",
  );
}
