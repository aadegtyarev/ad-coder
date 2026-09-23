import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Context, Session } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { resolveTargetDir } from "../runner/errors";
import { ProjectStoreFileSystem } from "./filesystem-store";
import type {
  AttachmentMetadata,
  CleanupResult,
  ProjectOperationsConfig,
  ProjectSessionMetadata,
  ProjectStoreArea,
  ProjectStoreByteLimits,
  ProjectStoreConfig,
  ProjectStoreLayout,
  ProjectStoreRetention,
  VersionedState,
} from "./types";
import { ProjectStoreError } from "./types";

/**
 * The only recovery that may replace an overlapping journal is a named,
 * operator-initiated continuation. Keep it at the state boundary so each
 * front reports the same safe next step instead of suggesting a retry that
 * cannot resolve an ambiguity.
 */
export const AMBIGUOUS_JOURNAL_NEXT_ACTION =
  "inspect the journal, then explicitly run `ad-coder operations session-clear-ambiguous --id <session-id> --target-dir <project>` to archive it and start a marked continuation";

const AREAS: readonly ProjectStoreArea[] = [
  "sessions",
  "runs",
  "waits",
  "scratch",
  "attachments",
  "downloads",
  "cache",
  "ledger",
  "tmp",
];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_RETENTION = Object.fromEntries(
  AREAS.map((area) => [area, 0]),
) as ProjectStoreRetention;
const DEFAULT_BYTES: ProjectStoreByteLimits = { attachment: 0, state: 0, jsonlRecord: 0 };
export const DEFAULT_PROJECT_STORE_LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80] as const;
const STORE_GITIGNORE = "*\n!calibration.json\n";

export class ProjectStore {
  readonly layout: ProjectStoreLayout;
  readonly retention: ProjectStoreRetention;
  readonly byteLimits: ProjectStoreByteLimits;
  readonly fileSystem: ProjectStoreFileSystem;
  readonly projectOperations: ProjectOperationsConfig;
  readonly lockRetryDelaysMs: readonly number[];
  private readonly sessions: JsonlSessionRepo;
  /** Test-only synchronization seam for deterministic stale-lock races. */
  private versionedLockHook?: (phase: "stale-inspected") => void;

  constructor(targetDir: string, config: ProjectStoreConfig = {}) {
    const resolvedTarget = resolveTargetDir(targetDir);
    const root = path.join(resolvedTarget, ".ad-coder");
    const areaPaths = Object.fromEntries(
      AREAS.map((area) => [area, path.join(root, area)]),
    ) as Record<ProjectStoreArea, string>;
    this.layout = {
      targetDir: resolvedTarget,
      root,
      gitignore: path.join(root, ".gitignore"),
      ...areaPaths,
    };
    this.retention = { ...DEFAULT_RETENTION, ...config.retention };
    this.byteLimits = { ...DEFAULT_BYTES, ...config.byteLimits };
    this.validateLockRetryConfig(config.lockRetry);
    this.lockRetryDelaysMs =
      config.lockRetry?.delaysMs ?? DEFAULT_PROJECT_STORE_LOCK_RETRY_DELAYS_MS;
    this.validateLockRetry(this.lockRetryDelaysMs);
    this.projectOperations = {
      backlogBackend: "files",
      evidenceLimit: 0,
      aggregationLimit: 0,
      claimLeaseMs: 0,
      ...config.projectOperations,
      ldo: {
        root: ".codex/ldo",
        artifactCountLimit: 0,
        perFileByteLimit: 0,
        aggregateByteLimit: 0,
        ...config.projectOperations?.ldo,
      },
    };
    this.validateLimits(this.retention);
    this.validateLimits(this.byteLimits);
    this.validateLimits({
      evidenceLimit: this.projectOperations.evidenceLimit ?? 0,
      aggregationLimit: this.projectOperations.aggregationLimit ?? 0,
      claimLeaseMs: this.projectOperations.claimLeaseMs ?? 0,
      artifactCountLimit: this.projectOperations.ldo?.artifactCountLimit ?? 0,
      perFileByteLimit: this.projectOperations.ldo?.perFileByteLimit ?? 0,
      aggregateByteLimit: this.projectOperations.ldo?.aggregateByteLimit ?? 0,
    });
    if (!(["files", "github"] as const).includes(this.projectOperations.backlogBackend ?? "files"))
      throw new ProjectStoreError(
        "invalid_config",
        "projectOperations.backlogBackend",
        "unsupported backlog backend",
      );
    this.initialize();
    this.fileSystem = new ProjectStoreFileSystem(root, this.byteLimits.jsonlRecord);
    this.sessions = new JsonlSessionRepo({
      fileSystem: this.fileSystem,
      sessionsRoot: this.layout.sessions,
    });
  }

  validateId(id: string): string {
    if (!ID_PATTERN.test(id))
      throw new ProjectStoreError("invalid_id", id, `id must match ${String(ID_PATTERN)}`);
    return id;
  }

  /**
   * The sole durable location for a WaitService record.  Keeping this path in
   * ProjectStore means wait state gets the same private-directory, no-link and
   * versioned-write protections as every other durable control-plane record.
   */
  waitStatePath(id: string): string {
    return path.join(this.managedPath("waits", id), "state.json");
  }

  async createSession(
    id: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Session<ProjectSessionMetadata>> {
    return this.withLockedSession(id, context, async () => {
      const existing = await this.listSessions(context);
      if (existing.some((item) => item.id === id))
        throw new ProjectStoreError("already_exists", id, `session already exists: ${id}`);
      return this.sessions.create({ id, cwd: this.layout.targetDir }, context);
    });
  }

  async listSessions(context: Context = BACKGROUND_CONTEXT): Promise<ProjectSessionMetadata[]> {
    const listed = await this.sessions.list({ cwd: this.layout.targetDir }, context);
    return listed.map((metadata) => this.validateSessionMetadata(metadata));
  }

  async resumeSession(
    id: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Session<ProjectSessionMetadata>> {
    return this.withLockedSession(id, context, async () => {
      const metadata = await this.findSession(id, context);
      return await this.openSessionWithOrderedRecovery(metadata, context);
    });
  }

  /**
   * Explicit recovery for a session whose complete JSONL transactions overlap.
   * This never tries to select one conflicting record.  It preserves the raw
   * journal in scratch/recovery and starts a fresh same-id continuation with a
   * durable, machine-readable pointer to that evidence.
   */
  async clearAmbiguousSession(
    id: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Session<ProjectSessionMetadata>> {
    return this.withLockedSession(id, context, async () => {
      const metadata = await this.findSession(id, context);
      const artifactPath = this.fileSystem.quarantineOverlappingTransactions(metadata.path);
      if (artifactPath === undefined)
        throw new ProjectStoreError(
          "ambiguous_journal",
          metadata.path,
          "session journal is not a complete overlapping transaction set",
          AMBIGUOUS_JOURNAL_NEXT_ACTION,
        );
      const replacement = await this.sessions.create({ id, cwd: this.layout.targetDir }, context);
      const branch = await replacement.createBranch("main", null, context);
      await branch.appendCustomEntry(
        "ad-coder.session_recovery",
        {
          version: 1,
          state: "cleared_ambiguous_journal",
          artifact: { type: "ambiguous_journal", path: artifactPath },
          recovery: "new_continuation",
        },
        context,
      );
      return replacement;
    });
  }

  async deleteSession(id: string, context: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.validateId(id);
    const releaseCoordination = this.acquireLock(this.sessionCoordinationPath());
    let releaseLease: (() => void) | undefined;
    try {
      releaseLease = this.acquireSessionLease(id);
      const metadata = await this.findSession(id, context);
      await this.sessions.delete(metadata, context);
    } finally {
      releaseLease?.();
      releaseCoordination();
    }
  }

  /**
   * `ManagerSessionHost.ensureSession` (src/session-manager/types.ts): the ONE
   * shared durable Orchestrator conversation for a managed project, reopened
   * idempotently under the store's own per-session lock. Responsible for the
   * background context only; the session-manager owns WHICH id and when.
   */
  async ensureSession(id: string): Promise<Session<ProjectSessionMetadata>> {
    return await this.openOrCreateSession(id, BACKGROUND_CONTEXT);
  }

  async openOrCreateSession(
    id: string,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<Session<ProjectSessionMetadata>> {
    return this.withLockedSession(id, context, async () => {
      const matches = (await this.listSessions(context)).filter((item) => item.id === id);
      if (matches.length > 1)
        throw new ProjectStoreError("unsafe_object", id, `duplicate session metadata: ${id}`);
      if (matches[0] === undefined)
        return this.sessions.create({ id, cwd: this.layout.targetDir }, context);
      return await this.openSessionWithOrderedRecovery(matches[0], context);
    });
  }

  async close(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.sessions.close(context);
    await this.fileSystem.cleanup(context);
  }

  private async openSessionWithOrderedRecovery(
    metadata: ProjectSessionMetadata,
    context: Context,
  ): Promise<Session<ProjectSessionMetadata>> {
    try {
      return await this.sessions.open(metadata, context);
    } catch (error) {
      if (!this.hasOutOfOrderTransactionError(error)) throw error;
      if (!this.fileSystem.repairOutOfOrderTransactions(metadata.path)) {
        if (this.fileSystem.hasOverlappingTransactions(metadata.path))
          throw new ProjectStoreError(
            "ambiguous_journal",
            metadata.path,
            "session journal has overlapping committed transactions; inspect it or clear it for a new continuation",
            AMBIGUOUS_JOURNAL_NEXT_ACTION,
          );
        throw new ProjectStoreError(
          "corrupt_state",
          metadata.path,
          "session journal has a non-monotonic incomplete transaction",
        );
      }
      return await this.sessions.open(metadata, context);
    }
  }

  private hasOutOfOrderTransactionError(error: unknown): boolean {
    let current = error;
    while (current instanceof Error) {
      if (current.message.startsWith("Non-monotonic storage sequence:")) return true;
      current = current.cause;
    }
    return false;
  }

  async copyAttachment(
    source: string,
    name = path.basename(source),
    id: string = crypto.randomUUID(),
  ): Promise<AttachmentMetadata> {
    this.validateId(id);
    this.validateName(name);
    const attachmentDir = this.managedPath("attachments", id);
    this.createPrivateDir(attachmentDir);
    const destination = path.join(attachmentDir, name);
    const temporary = path.join(this.layout.tmp, `${id}-${crypto.randomUUID()}.tmp`);
    let sourceFd: number | undefined;
    let destinationFd: number | undefined;
    try {
      sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const before = fs.fstatSync(sourceFd);
      if (!before.isFile())
        throw new ProjectStoreError(
          "unsafe_object",
          source,
          "attachment source is not a regular file",
        );
      if (this.byteLimits.attachment > 0 && before.size > this.byteLimits.attachment) {
        throw new ProjectStoreError(
          "resource_limit",
          name,
          "attachment exceeds configured byte limit",
        );
      }
      destinationFd = fs.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let size = 0;
      for (;;) {
        const read = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        size += read;
        if (this.byteLimits.attachment > 0 && size > this.byteLimits.attachment)
          throw new ProjectStoreError(
            "resource_limit",
            name,
            "attachment exceeds configured byte limit",
          );
        fs.writeSync(destinationFd, buffer, 0, read);
        hash.update(buffer.subarray(0, read));
      }
      const after = fs.fstatSync(sourceFd);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new ProjectStoreError(
          "unsafe_object",
          source,
          "attachment source changed while being copied",
        );
      }
      fs.fsyncSync(destinationFd);
      fs.closeSync(destinationFd);
      destinationFd = undefined;
      this.assertDestination(destination);
      fs.renameSync(temporary, destination);
      fs.chmodSync(destination, 0o600);
      const metadata: AttachmentMetadata = {
        id,
        name,
        path: destination,
        size,
        sha256: hash.digest("hex"),
        createdAt: Date.now(),
      };
      this.writeVersionedJson(path.join(attachmentDir, "manifest.json"), metadata);
      return metadata;
    } finally {
      if (sourceFd !== undefined) fs.closeSync(sourceFd);
      if (destinationFd !== undefined) fs.closeSync(destinationFd);
      try {
        fs.unlinkSync(temporary);
      } catch {
        // The temporary may already have been atomically renamed or never created.
      }
    }
  }

  readAttachment(id: string): AttachmentMetadata {
    const metadata = this.readVersionedJson<AttachmentMetadata>(
      path.join(this.managedPath("attachments", id), "manifest.json"),
    ).value;
    this.validateId(metadata.id);
    this.validateName(metadata.name);
    const expected = path.join(this.layout.attachments, id, metadata.name);
    if (metadata.id !== id || metadata.path !== expected)
      throw new ProjectStoreError("unsafe_path", id, "attachment manifest destination is invalid");
    this.assertDestination(expected);
    return metadata;
  }

  listAttachments(): AttachmentMetadata[] {
    return fs
      .readdirSync(this.layout.attachments, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map((entry) => this.readAttachment(entry.name))
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  }

  writeVersionedJson<T>(
    destination: string,
    value: T,
    expectedVersion?: number,
  ): VersionedState<T> {
    this.assertInside(destination);
    this.createPrivateDir(path.dirname(destination));
    const release = this.acquireVersionedLock(`${destination}.lock`);
    try {
      let current = 0;
      try {
        current = this.readVersionedJson<T>(destination).version;
      } catch (error) {
        if (!(error instanceof ProjectStoreError) || error.code !== "not_found") throw error;
      }
      if (expectedVersion !== undefined && expectedVersion !== current)
        throw new ProjectStoreError(
          "version_conflict",
          destination,
          `expected version ${expectedVersion}, found ${current}`,
        );
      const next = { version: current + 1, value };
      const bytes = Buffer.from(`${JSON.stringify(next)}\n`);
      if (this.byteLimits.state > 0 && bytes.length > this.byteLimits.state)
        throw new ProjectStoreError(
          "resource_limit",
          destination,
          "state exceeds configured byte limit",
        );
      this.atomicWrite(destination, bytes);
      return next;
    } finally {
      release();
    }
  }

  /** Serialize a read/modify/write operation under the destination's store lock. */
  mutateVersionedJson<T>(
    destination: string,
    mutate: (current: VersionedState<T> | undefined) => T,
  ): VersionedState<T> {
    this.assertInside(destination);
    this.createPrivateDir(path.dirname(destination));
    const release = this.acquireVersionedLock(`${destination}.lock`);
    try {
      let current: VersionedState<T> | undefined;
      try {
        current = this.readVersionedJson<T>(destination);
      } catch (error) {
        if (!(error instanceof ProjectStoreError) || error.code !== "not_found") throw error;
      }
      const next = { version: (current?.version ?? 0) + 1, value: mutate(current) };
      const bytes = Buffer.from(`${JSON.stringify(next)}\n`);
      if (this.byteLimits.state > 0 && bytes.length > this.byteLimits.state)
        throw new ProjectStoreError(
          "resource_limit",
          destination,
          "state exceeds configured byte limit",
        );
      this.atomicWrite(destination, bytes);
      return next;
    } finally {
      release();
    }
  }

  readVersionedJson<T>(source: string): VersionedState<T> {
    this.assertInside(source);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ProjectStoreError("not_found", source, "managed state was not found");
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new ProjectStoreError(
        "unsafe_object",
        source,
        "managed state is not a private regular file",
      );
    if (this.byteLimits.state > 0 && stat.size > this.byteLimits.state)
      throw new ProjectStoreError("resource_limit", source, "state exceeds configured byte limit");
    let parsed: VersionedState<T>;
    try {
      parsed = JSON.parse(fs.readFileSync(source, "utf8")) as VersionedState<T>;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Corrupt bytes are a typed store failure, not a crash. A raw
      // SyntaxError escaped every handler that keys on ProjectStoreError --
      // `runs stop` reported a corrupt run record as a crash instead of a
      // refusal (issue #479), and the same gap turned any corrupt state file
      // into an untyped failure. The parse error's own message is dropped
      // deliberately: the JSON parser embeds a content snippet in it, and
      // error text stays identifiers and numbers only.
      throw new ProjectStoreError("corrupt_state", source, "managed state is not parseable JSON");
    }
    return parsed;
  }

  appendJsonl(destination: string, record: unknown): void {
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (this.byteLimits.jsonlRecord > 0 && bytes.length > this.byteLimits.jsonlRecord)
      throw new ProjectStoreError(
        "resource_limit",
        destination,
        "JSONL record exceeds configured byte limit",
      );
    this.assertInside(destination);
    const fd = fs.openSync(
      destination,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new ProjectStoreError("unsafe_object", destination, "JSONL destination is unsafe");
      fs.writeSync(fd, bytes);
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  }

  async cleanup(
    area: ProjectStoreArea,
    context: Context = BACKGROUND_CONTEXT,
  ): Promise<CleanupResult> {
    const limit = this.retention[area];
    const removed: string[] = [];
    if (limit === 0) return { area, removed };
    const lockName = area === "sessions" ? "session-coordination.lock" : `cleanup-${area}.lock`;
    const release = this.acquireLock(path.join(this.layout.tmp, lockName));
    try {
      if (area === "sessions") {
        const sessions = await this.listSessions(context);
        for (const metadata of sessions.slice(limit)) {
          let releaseLease: (() => void) | undefined;
          try {
            releaseLease = this.acquireSessionLease(metadata.id);
          } catch (error) {
            if (error instanceof ProjectStoreError && error.code === "version_conflict") continue;
            throw error;
          }
          try {
            const current = await this.findSession(metadata.id, context);
            await this.sessions.delete(current, context);
            removed.push(metadata.id);
          } finally {
            releaseLease();
          }
        }
        return { area, removed };
      }
      const candidates = fs
        .readdirSync(this.layout[area], { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
        .map((entry) => ({
          name: entry.name,
          path: this.managedPath(area, entry.name),
          mtime: fs.lstatSync(this.managedPath(area, entry.name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const entry of candidates.slice(limit)) {
        const stat = fs.lstatSync(entry.path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new ProjectStoreError("unsafe_object", entry.name, "cleanup candidate changed");
        fs.rmSync(entry.path, { recursive: true });
        removed.push(entry.name);
      }
      return { area, removed };
    } finally {
      release();
    }
  }

  private initialize(): void {
    this.createPrivateDir(this.layout.root);
    for (const area of AREAS) this.createPrivateDir(this.layout[area]);
    if (!fs.existsSync(this.layout.gitignore))
      this.atomicWrite(this.layout.gitignore, Buffer.from(STORE_GITIGNORE));
    else {
      const stat = fs.lstatSync(this.layout.gitignore);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new ProjectStoreError(
          "unsafe_path",
          this.layout.gitignore,
          "store gitignore must be a private regular file",
        );
      if (fs.readFileSync(this.layout.gitignore, "utf8") !== STORE_GITIGNORE)
        this.atomicWrite(this.layout.gitignore, Buffer.from(STORE_GITIGNORE));
    }
    fs.chmodSync(this.layout.gitignore, 0o600);
  }

  private createPrivateDir(directory: string): void {
    this.assertInside(directory, true);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ProjectStoreError(
        "unsafe_path",
        directory,
        "store component is not a real directory",
      );
    fs.chmodSync(directory, 0o700);
  }

  private atomicWrite(destination: string, bytes: Buffer): void {
    this.assertDestination(destination);
    this.createPrivateDir(path.dirname(destination));
    const temporary = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`,
    );
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
    try {
      this.assertDestination(destination);
      fs.renameSync(temporary, destination);
      const dirFd = fs.openSync(path.dirname(destination), fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Best-effort removal is safe here because publication failed and the random temp is inert.
      }
      throw error;
    }
  }

  private acquireVersionedLock(lockPath: string): () => void {
    this.assertDestination(lockPath);
    const identity = this.processIdentity();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return this.withVersionedLockCoordination(lockPath, () =>
          this.createLock(lockPath, identity),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = this.readVersionedLock(lockPath);
        if (holder !== undefined && !this.isVersionedLockHolderAlive(holder)) {
          this.versionedLockHook?.("stale-inspected");
          if (this.reclaimStaleLock(lockPath, holder)) continue;
        }
        // Releases before the start-time witness was introduced wrote either
        // `{ pid }` or `{ pid, token }`.  A dead owner of one of those files
        // must not strand every future resume.  Do not infer liveness from a
        // PID alone, though: without the witness a live or reused PID is
        // deliberately treated as held.
        const legacyHolder = this.readLegacyLock(lockPath);
        if (legacyHolder !== undefined && this.isProcessDefinitelyDead(legacyHolder.pid)) {
          this.versionedLockHook?.("stale-inspected");
          if (this.reclaimLegacyLock(lockPath, legacyHolder)) continue;
        }
        const delay = this.lockRetryDelaysMs[attempt];
        // Releases before 0.181.16 created the pathname first and wrote its
        // identity second.  A killed owner in that tiny interval leaves an
        // empty regular file: it carries neither a PID nor a token, so it
        // cannot enter either stale-owner recovery branch above.  Only after
        // the normal bounded contention schedule has elapsed may we reclaim
        // that exact inert legacy shape.  New writers publish a populated
        // inode atomically in `createLock`, so they never create this shape.
        if (delay === undefined && this.reclaimEmptyLegacyLock(lockPath)) continue;
        if (delay === undefined)
          throw new ProjectStoreError("version_conflict", lockPath, "managed state is locked");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
  }

  private acquireLock(lockPath: string): () => void {
    this.assertDestination(lockPath);
    try {
      return this.createLock(lockPath, { pid: process.pid });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ProjectStoreError("version_conflict", lockPath, "managed state is locked");
      throw error;
    }
  }

  private withVersionedLockCoordination<T>(lockPath: string, operation: () => T): T {
    const coordinationPath = `${lockPath}.coordination`;
    const identity = { ...this.processIdentity(), token: crypto.randomUUID() };
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.mkdirSync(coordinationPath, 0o700);
        try {
          fs.writeFileSync(path.join(coordinationPath, "owner"), `${JSON.stringify(identity)}\n`, {
            mode: 0o600,
          });
        } catch (writeError) {
          // A half-created coordination directory is inert by construction:
          // the owner identity never published.  Remove it best-effort so the
          // next attempt starts clean, but never let that cleanup hide the
          // publication error itself.
          try {
            fs.rmSync(coordinationPath, { recursive: true, force: true });
          } catch {
            // Left in place, it is reclaimable by the inert-owner branch below.
          }
          throw writeError;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = this.readVersionedLock(path.join(coordinationPath, "owner"));
        if (owner !== undefined && !this.isVersionedLockHolderAlive(owner)) {
          const current = this.readVersionedLock(path.join(coordinationPath, "owner"));
          if (current?.token !== owner.token) continue;
          const quarantine = `${coordinationPath}.reclaim-${owner.token}`;
          try {
            fs.renameSync(coordinationPath, quarantine);
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw renameError;
          }
          fs.rmSync(quarantine, { recursive: true, force: true });
          continue;
        }
        const legacyOwner = this.readLegacyLock(path.join(coordinationPath, "owner"));
        if (legacyOwner !== undefined && this.isProcessDefinitelyDead(legacyOwner.pid)) {
          const ownerPath = path.join(coordinationPath, "owner");
          const current = this.readLegacyLock(ownerPath);
          if (current?.raw !== legacyOwner.raw) continue;
          const quarantine = `${coordinationPath}.reclaim-${crypto.randomUUID()}`;
          try {
            fs.renameSync(coordinationPath, quarantine);
          } catch (renameError) {
            if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw renameError;
          }
          fs.rmSync(quarantine, { recursive: true, force: true });
          continue;
        }
        if (this.reclaimInertCoordination(coordinationPath)) continue;
        const delay = this.lockRetryDelaysMs[attempt];
        if (delay === undefined)
          throw new ProjectStoreError("version_conflict", lockPath, "managed state is locked");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
    }
    try {
      return operation();
    } finally {
      fs.rmSync(coordinationPath, { recursive: true, force: true });
    }
  }

  /**
   * Reclaim an ownerless coordination directory.  A directory whose owner was
   * never published leaves no PID and no token, so neither dead-owner branch
   * above can recognise it and it would otherwise refuse every contender
   * forever.  Only the unambiguously inert shape qualifies: no entries at all,
   * or a single `owner` entry that is a zero-byte, singly linked regular file.
   * An owner with content, any second entry, or any non-directory object is
   * deliberately not guessed at: that remains the typed contention refusal.
   */
  private reclaimInertCoordination(coordinationPath: string): boolean {
    if (this.coordinationShape(coordinationPath) !== "inert") return false;
    const quarantine = `${coordinationPath}.reclaim-${crypto.randomUUID()}`;
    try {
      fs.renameSync(coordinationPath, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (this.coordinationShape(quarantine) !== "inert") {
      // A contender published an owner between inspection and rename.  The
      // quarantined directory is evidence of that race, not ours to delete:
      // it is retained as an ambiguous shape and never a substitute for the
      // coordination directory a fresh caller creates itself.
      return false;
    }
    fs.rmSync(quarantine, { recursive: true, force: true });
    return true;
  }

  /**
   * Classify a coordination directory conservatively.  `"inert"` is the only
   * shape reclamation may delete; everything ambiguous stays refused.
   */
  private coordinationShape(directory: string): "inert" | "empty" | "ambiguous" {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "empty";
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "ambiguous";
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "empty";
      throw error;
    }
    if (entries.length === 0) return "inert";
    if (entries.length !== 1 || entries[0] !== "owner") return "ambiguous";
    let owner: fs.Stats;
    try {
      owner = fs.lstatSync(path.join(directory, "owner"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "inert";
      throw error;
    }
    if (!owner.isFile() || owner.isSymbolicLink() || owner.nlink !== 1 || owner.size !== 0)
      return "ambiguous";
    return "inert";
  }

  private createLock(
    lockPath: string,
    identity: { pid: number; startTime?: string; procfsCtimeNs?: string; token?: string },
  ): () => void {
    this.assertDestination(lockPath);
    const ownedIdentity = { ...identity, token: identity.token ?? crypto.randomUUID() };
    const temporary = path.join(
      path.dirname(lockPath),
      `.${path.basename(lockPath)}.${crypto.randomUUID()}.lock`,
    );
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, `${JSON.stringify(ownedIdentity)}\n`);
      fs.fsyncSync(fd);
      fs.linkSync(temporary, lockPath);
    } finally {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(temporary);
      } catch {
        // A failed cleanup leaves only an inert, random private temporary.
        // Never let that hide the acquisition result or its typed conflict.
      }
    }
    return () => {
      this.withVersionedLockCoordination(lockPath, () => {
        if (this.readLockToken(lockPath) !== ownedIdentity.token) return;
        const released = `${lockPath}.release-${ownedIdentity.token}`;
        try {
          fs.renameSync(lockPath, released);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return;
        }
        fs.unlinkSync(released);
      });
    };
  }

  /**
   * Recover the only ownerless legacy lock shape the old O_EXCL-then-write
   * publisher could leave.  A non-empty or non-regular object is deliberately
   * not guessed at: that remains a typed contention/refusal.
   */
  private reclaimEmptyLegacyLock(lockPath: string): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 0)
      return false;
    const quarantine = `${lockPath}.reclaim-empty-${crypto.randomUUID()}`;
    try {
      fs.renameSync(lockPath, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    try {
      const moved = fs.lstatSync(quarantine);
      // A writer that had the old inode open can still finish after rename.
      // Preserve that non-empty inode rather than deleting live ownership.
      if (!moved.isFile() || moved.isSymbolicLink() || moved.nlink !== 1 || moved.size !== 0)
        return false;
      fs.unlinkSync(quarantine);
      return true;
    } finally {
      // `quarantine` is intentionally retained if a raced old writer filled
      // it.  It is evidence of an unsafe concurrent legacy protocol, never a
      // substitute for a fresh lock at `lockPath`.
    }
  }

  private processIdentity(): { pid: number; startTime: string; procfsCtimeNs?: string } {
    const procfsCtimeNs = this.readProcessProcfsCtimeNs(process.pid);
    return {
      pid: process.pid,
      startTime: this.readProcessStartTime(process.pid) ?? "unavailable",
      ...(procfsCtimeNs === undefined ? {} : { procfsCtimeNs }),
    };
  }

  private reclaimStaleLock(
    lockPath: string,
    inspected: { pid: number; startTime: string; token: string },
  ): boolean {
    return this.withVersionedLockCoordination(lockPath, () => {
      const current = this.readVersionedLock(lockPath);
      // The coordination directory makes creation and reclamation one protocol:
      // a contender cannot replace the pathname between this identity check and rename.
      if (current?.token !== inspected.token) return false;
      const quarantine = `${lockPath}.reclaim-${inspected.token}`;
      try {
        fs.renameSync(lockPath, quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      const quarantined = this.readVersionedLock(quarantine);
      if (quarantined?.token !== inspected.token)
        throw new Error("stale lock ownership changed during reclamation");
      fs.unlinkSync(quarantine);
      return true;
    });
  }

  /**
   * Reclaim a recognised pre-witness lock while holding the current protocol's
   * coordination directory.  The byte comparison prevents deleting a lock a
   * contender installed after the initial inspection.
   */
  private reclaimLegacyLock(lockPath: string, inspected: { pid: number; raw: string }): boolean {
    return this.withVersionedLockCoordination(lockPath, () => {
      const current = this.readLegacyLock(lockPath);
      if (current?.raw !== inspected.raw) return false;
      const quarantine = `${lockPath}.reclaim-${crypto.randomUUID()}`;
      try {
        fs.renameSync(lockPath, quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      fs.unlinkSync(quarantine);
      return true;
    });
  }

  private readLockToken(lockPath: string): string | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { token?: unknown };
      return typeof value.token === "string" ? value.token : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
        return undefined;
      throw error;
    }
  }

  private readVersionedLock(
    lockPath: string,
  ): { pid: number; startTime: string; procfsCtimeNs?: string; token: string } | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Record<string, unknown>;
      if (
        !Number.isSafeInteger(value.pid) ||
        (value.pid as number) <= 0 ||
        typeof value.startTime !== "string" ||
        (value.startTime !== "unavailable" && !/^\d{1,32}$/.test(value.startTime)) ||
        (value.procfsCtimeNs !== undefined &&
          (typeof value.procfsCtimeNs !== "string" || !/^\d{1,32}$/.test(value.procfsCtimeNs))) ||
        typeof value.token !== "string" ||
        !/^[0-9a-f-]{36}$/.test(value.token)
      )
        return undefined;
      return {
        pid: value.pid as number,
        startTime: value.startTime,
        ...(value.procfsCtimeNs === undefined ? {} : { procfsCtimeNs: value.procfsCtimeNs }),
        token: value.token,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
        return undefined;
      throw error;
    }
  }

  /** Read only the two lock shapes emitted before `startTime` existed. */
  private readLegacyLock(lockPath: string): { pid: number; raw: string } | undefined {
    try {
      const raw = fs.readFileSync(lockPath, "utf8");
      const value = JSON.parse(raw) as Record<string, unknown>;
      const keys = Object.keys(value).sort();
      const pid = value.pid;
      const token = value.token;
      if (
        !Number.isSafeInteger(pid) ||
        (pid as number) <= 0 ||
        ((keys.length !== 1 || keys[0] !== "pid") &&
          (keys.length !== 2 || keys[0] !== "pid" || keys[1] !== "token")) ||
        (token !== undefined && (typeof token !== "string" || !/^[0-9a-f-]{36}$/.test(token)))
      )
        return undefined;
      return { pid: pid as number, raw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
        return undefined;
      throw error;
    }
  }

  private isVersionedLockHolderAlive(holder: {
    pid: number;
    startTime: string;
    procfsCtimeNs?: string;
  }): boolean {
    try {
      process.kill(holder.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      return true;
    }
    const current = this.readProcessIdentity(holder.pid);
    if (current === undefined || holder.startTime === "unavailable") return true;
    if (current.state === "Z") return false;
    if (current.startTime !== holder.startTime) return false;
    if (holder.procfsCtimeNs === undefined) return true;
    const currentProcfsCtimeNs = this.readProcessProcfsCtimeNs(holder.pid);
    // An unreadable witness remains a held lock; it is never permission to
    // reclaim a potentially live process.
    return currentProcfsCtimeNs === undefined || currentProcfsCtimeNs === holder.procfsCtimeNs;
  }

  /**
   * The old lock shape has no start-time witness.  Reclaim it only when the
   * operating system positively identifies the process as gone or zombie;
   * permission and procfs uncertainty remain a live lock.
   */
  private isProcessDefinitelyDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    return this.readProcessIdentity(pid)?.state === "Z";
  }

  private readProcessStartTime(pid: number): string | undefined {
    return this.readProcessIdentity(pid)?.startTime;
  }

  /** Nanosecond birth witness for the procfs pid directory, when available. */
  private readProcessProcfsCtimeNs(pid: number): string | undefined {
    try {
      const stat = fs.statSync(`/proc/${pid}`, { bigint: true }) as { ctimeNs?: bigint };
      return stat.ctimeNs?.toString();
    } catch {
      return undefined;
    }
  }

  private readProcessIdentity(pid: number): { state: string; startTime: string } | undefined {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(" ");
      const [state = "", startTime] = [tail[0], tail[19]];
      return state !== undefined && startTime !== undefined && /^\d{1,32}$/.test(startTime)
        ? { state, startTime }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private sessionLeasePath(id: string): string {
    return path.join(this.layout.tmp, `session-${this.validateId(id)}.lease`);
  }

  private sessionCoordinationPath(): string {
    return path.join(this.layout.tmp, "session-coordination.lock");
  }

  private acquireSessionLease(id: string): () => void {
    // A role process can die between opening its durable session and its
    // closeout handler. Use the same PID+start-time protocol as versioned
    // state, so resume reclaims that orphan but cannot steal a reused PID.
    return this.acquireVersionedLock(this.sessionLeasePath(id));
  }

  private async withLockedSession<T extends ProjectSessionMetadata>(
    id: string,
    _context: Context,
    open: () => Promise<Session<T>>,
  ): Promise<Session<T>> {
    this.validateId(id);
    // This short lock can itself be orphaned by a process death while opening
    // a session. It needs the same stale-owner recovery as the long lease.
    const releaseCoordination = this.acquireVersionedLock(this.sessionCoordinationPath());
    let release: (() => void) | undefined;
    let session: Session<T> | undefined;
    let openingFailed = false;
    let openingError: unknown;
    try {
      release = this.acquireSessionLease(id);
      session = await open();
    } catch (error) {
      openingFailed = true;
      openingError = error;
    } finally {
      releaseCoordination();
    }
    if (openingFailed) {
      release?.();
      throw openingError;
    }
    if (release === undefined || session === undefined) {
      release?.();
      throw new ProjectStoreError("not_found", id, "failed to open managed session");
    }
    let closed = false;
    const releaseLease = release;
    return new Proxy(session, {
      get(target, property) {
        if (property === "close") {
          return async (closeContext: Context) => {
            try {
              return await target.close(closeContext);
            } finally {
              if (!closed) {
                closed = true;
                releaseLease();
              }
            }
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private managedPath(area: ProjectStoreArea, id: string): string {
    return path.join(this.layout[area], this.validateId(id));
  }
  private validateName(name: string): void {
    if (
      name === "." ||
      name === ".." ||
      path.isAbsolute(name) ||
      name.includes("/") ||
      name.includes("\\") ||
      name.length === 0
    )
      throw new ProjectStoreError(
        "invalid_id",
        name,
        "destination name must be one path component",
      );
  }
  private validateLockRetryConfig(config: ProjectStoreConfig["lockRetry"]): void {
    if (config === undefined) return;
    if (
      typeof config !== "object" ||
      config === null ||
      Array.isArray(config) ||
      Object.getPrototypeOf(config) !== Object.prototype ||
      Object.keys(config).some((key) => key !== "delaysMs")
    )
      throw new ProjectStoreError(
        "invalid_config",
        "lockRetry",
        "lockRetry must contain only the delaysMs setting",
      );
    if (Object.hasOwn(config, "delaysMs"))
      this.validateLockRetry((config as { delaysMs: readonly number[] }).delaysMs);
  }

  private validateLockRetry(delays: readonly number[]): void {
    if (
      !Array.isArray(delays) ||
      delays.length === 0 ||
      delays.some((delay) => !Number.isSafeInteger(delay) || delay <= 0)
    )
      throw new ProjectStoreError(
        "invalid_config",
        "lockRetry.delaysMs",
        "lock retry delays must be a non-empty array of positive safe integers",
      );
  }
  private validateLimits<T extends object>(limits: T): void {
    for (const [name, value] of Object.entries(limits))
      if (!Number.isSafeInteger(value) || (value as number) < 0)
        throw new ProjectStoreError(
          "invalid_config",
          name,
          `${name} must be a non-negative integer`,
        );
  }
  private async findSession(id: string, context: Context): Promise<ProjectSessionMetadata> {
    this.validateId(id);
    const matches = (await this.listSessions(context)).filter((item) => item.id === id);
    if (matches.length === 0)
      throw new ProjectStoreError("not_found", id, `session not found: ${id}`);
    if (matches.length !== 1)
      throw new ProjectStoreError("unsafe_object", id, `duplicate session metadata: ${id}`);
    return matches[0] as ProjectSessionMetadata;
  }
  private validateSessionMetadata<T extends ProjectSessionMetadata>(metadata: T): T {
    if (metadata.cwd !== this.layout.targetDir)
      throw new ProjectStoreError("unsafe_path", metadata.cwd, "session belongs to another target");
    this.assertInside(metadata.path);
    this.assertDestination(metadata.path);
    return metadata;
  }
  private assertDestination(destination: string): void {
    this.assertInside(destination);
    try {
      const stat = fs.lstatSync(destination);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
        throw new ProjectStoreError("unsafe_object", destination, "destination is unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private assertInside(candidate: string, allowRoot = false): void {
    const resolved = path.resolve(candidate);
    if (
      (!allowRoot && resolved === this.layout.root) ||
      (resolved !== this.layout.root && !resolved.startsWith(`${this.layout.root}${path.sep}`))
    )
      throw new ProjectStoreError("unsafe_path", resolved, "path escapes the project store");
    let cursor = this.layout.targetDir;
    for (const component of path
      .relative(this.layout.targetDir, resolved)
      .split(path.sep)
      .slice(0, -1)) {
      if (!component) continue;
      cursor = path.join(cursor, component);
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw new ProjectStoreError("unsafe_path", cursor, "path has an unsafe component");
      } catch (error) {
        if (error instanceof ProjectStoreError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export function createProjectStore(targetDir: string, config?: ProjectStoreConfig): ProjectStore {
  return new ProjectStore(targetDir, config);
}

export const listProjectSessions = (store: ProjectStore, context?: Context) =>
  store.listSessions(context);
export const resumeProjectSession = (store: ProjectStore, id: string, context?: Context) =>
  store.resumeSession(id, context);
export const deleteProjectSession = (store: ProjectStore, id: string, context?: Context) =>
  store.deleteSession(id, context);
export const copyProjectAttachment = (
  store: ProjectStore,
  source: string,
  name?: string,
  id?: string,
) => store.copyAttachment(source, name, id);
