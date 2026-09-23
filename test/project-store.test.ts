import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND_CONTEXT, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { ProjectStore, ProjectStoreError } from "../src";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function target(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-store-"));
  roots.push(root);
  return root;
}

function processStartTime(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const field = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(" ")[19];
  if (field === undefined) throw new Error(`missing process start time for ${pid}`);
  return field;
}

function processProcfsCtimeNs(pid: number): string {
  return fs.statSync(`/proc/${pid}`, { bigint: true }).ctimeNs.toString();
}

async function childHoldingLock(): Promise<{
  process: ReturnType<typeof Bun.spawn>;
  startTime: string;
}> {
  const child = Bun.spawn(["sleep", "60"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return { process: child, startTime: processStartTime(child.pid) };
    } catch {
      await Bun.sleep(5);
    }
  }
  child.kill();
  throw new Error("child did not become observable");
}

describe("ProjectStore", () => {
  test("creates the complete private layout under a permissive umask without changing target gitignore", () => {
    const root = target();
    fs.writeFileSync(path.join(root, ".gitignore"), "user-owned\n");
    const previousUmask = process.umask(0);
    let store: ProjectStore;
    try {
      store = new ProjectStore(root);
    } finally {
      process.umask(previousUmask);
    }
    expect(fs.readFileSync(path.join(root, ".gitignore"), "utf8")).toBe("user-owned\n");
    expect(fs.readFileSync(store.layout.gitignore, "utf8")).toBe("*\n!calibration.json\n");
    for (const directory of [
      store.layout.root,
      store.layout.sessions,
      store.layout.runs,
      store.layout.waits,
      store.layout.scratch,
      store.layout.attachments,
      store.layout.downloads,
      store.layout.cache,
      store.layout.ledger,
      store.layout.tmp,
    ]) {
      expect(
        fs.realpathSync(directory).startsWith(`${fs.realpathSync(store.layout.root)}${path.sep}`) ||
          directory === store.layout.root,
      ).toBe(true);
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(fs.statSync(store.layout.gitignore).mode & 0o777).toBe(0o600);
    expect(() => new ProjectStore(root)).not.toThrow();
  });

  test("persists session lifecycle and makes repeated delete explicit", async () => {
    const root = target();
    const first = new ProjectStore(root);
    const session = await first.createSession("session_one");
    await session.close(BACKGROUND_CONTEXT);
    const second = new ProjectStore(root);
    expect((await second.listSessions()).map((item) => item.id)).toEqual(["session_one"]);
    const reopened = await second.resumeSession("session_one");
    await reopened.close(BACKGROUND_CONTEXT);
    await second.deleteSession("session_one");
    await expect(second.deleteSession("session_one")).rejects.toMatchObject({ code: "not_found" });
  });

  test("releases session coordination before cleaning up a failed open", async () => {
    const store = new ProjectStore(target(), { lockRetry: { delaysMs: [1] } });
    const session = await store.createSession("failed_open");
    await session.close(BACKGROUND_CONTEXT);
    const lease = path.join(store.layout.tmp, "session-failed_open.lease");
    const coordination = path.join(store.layout.tmp, "session-coordination.lock");
    const storeWithLeaseHook = store as unknown as {
      acquireSessionLease(id: string): () => void;
    };
    const acquireLease = storeWithLeaseHook.acquireSessionLease.bind(store);
    let cleanupCalled = false;
    storeWithLeaseHook.acquireSessionLease = (id) => {
      const release = acquireLease(id);
      return () => {
        cleanupCalled = true;
        expect(fs.existsSync(coordination)).toBe(false);
        release();
      };
    };

    await expect(store.createSession("failed_open")).rejects.toMatchObject({
      code: "already_exists",
    });
    expect(cleanupCalled).toBe(true);
    expect(fs.existsSync(lease)).toBe(false);
    expect(fs.existsSync(coordination)).toBe(false);
  });

  test("rejects final session symlinks and hard links before listing or resuming", async () => {
    const root = target();
    const store = new ProjectStore(root);
    const session = await store.createSession("session_link");
    await session.close(BACKGROUND_CONTEXT);
    const [metadata] = await store.listSessions();
    if (metadata === undefined) throw new Error("missing session metadata");
    const outside = path.join(target(), "outside.jsonl");
    fs.renameSync(metadata.path, outside);
    fs.symlinkSync(outside, metadata.path);
    await expect(store.listSessions()).rejects.toMatchObject({ code: "unsafe_object" });
    await expect(store.resumeSession("session_link")).rejects.toMatchObject({
      code: "unsafe_object",
    });

    fs.unlinkSync(metadata.path);
    fs.linkSync(outside, metadata.path);
    await expect(store.listSessions()).rejects.toMatchObject({ code: "unsafe_object" });
  });

  test("prevents another store from deleting an active session", async () => {
    const root = target();
    const first = new ProjectStore(root);
    const active = await first.createSession("active_session");
    const second = new ProjectStore(root);
    await expect(second.deleteSession("active_session")).rejects.toMatchObject({
      code: "version_conflict",
    });
    await active.close(BACKGROUND_CONTEXT);
    await second.deleteSession("active_session");
  });

  test("waits for a live versioned-state holder and preserves the typed refusal", async () => {
    const root = target();
    const store = new ProjectStore(root);
    const file = path.join(store.layout.runs, "live_lock.json");
    store.mutateVersionedJson(file, () => ({ ready: true }));
    const holder = await childHoldingLock();
    const lock = `${file}.lock`;
    fs.writeFileSync(
      lock,
      `${JSON.stringify({ pid: holder.process.pid, startTime: holder.startTime, token: crypto.randomUUID() })}\n`,
      {
        mode: 0o600,
      },
    );
    try {
      expect(processStartTime(holder.process.pid)).toBe(holder.startTime);
      const started = performance.now();
      expect(() => store.mutateVersionedJson(file, (current) => current?.value ?? {})).toThrow(
        new ProjectStoreError("version_conflict", lock, "managed state is locked"),
      );
      expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    } finally {
      holder.process.kill();
      await holder.process.exited;
      fs.rmSync(lock, { force: true });
    }
  });

  test("direct writer uses the bounded versioned-lock protocol", async () => {
    const root = target();
    const store = new ProjectStore(root, { lockRetry: { delaysMs: [1, 1] } });
    const file = path.join(store.layout.runs, "direct_lock.json");
    store.writeVersionedJson(file, { ready: true });
    const holder = await childHoldingLock();
    const lock = `${file}.lock`;
    fs.writeFileSync(
      lock,
      `${JSON.stringify({ pid: holder.process.pid, startTime: holder.startTime, token: crypto.randomUUID() })}\n`,
      { mode: 0o600 },
    );
    try {
      expect(() => store.writeVersionedJson(file, { blocked: true })).toThrow(
        new ProjectStoreError("version_conflict", lock, "managed state is locked"),
      );
    } finally {
      holder.process.kill();
      await holder.process.exited;
      fs.rmSync(lock, { force: true });
    }
  });

  test("stale reclamation cannot remove a rival lock installed after inspection", () => {
    const root = target();
    const store = new ProjectStore(root, { lockRetry: { delaysMs: [1] } });
    const file = path.join(store.layout.runs, "contender_race.json");
    store.writeVersionedJson(file, { before: true });
    const lock = `${file}.lock`;
    const staleToken = crypto.randomUUID();
    fs.writeFileSync(
      lock,
      `${JSON.stringify({ pid: 999999, startTime: "1", token: staleToken })}\n`,
      { mode: 0o600 },
    );
    const rivalToken = crypto.randomUUID();
    (store as unknown as { versionedLockHook: (phase: string) => void }).versionedLockHook = () => {
      fs.unlinkSync(lock);
      fs.writeFileSync(
        lock,
        `${JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid), token: rivalToken })}\n`,
        { mode: 0o600 },
      );
    };
    expect(() => store.writeVersionedJson(file, { after: true })).toThrow(
      new ProjectStoreError("version_conflict", lock, "managed state is locked"),
    );
    expect(JSON.parse(fs.readFileSync(lock, "utf8"))).toMatchObject({ token: rivalToken });
  });

  test("direct writer reclaims a dead holder", async () => {
    const root = target();
    const store = new ProjectStore(root);
    const file = path.join(store.layout.runs, "direct_dead_lock.json");
    store.writeVersionedJson(file, { before: true });
    const holder = await childHoldingLock();
    const lock = `${file}.lock`;
    fs.writeFileSync(
      lock,
      `${JSON.stringify({ pid: holder.process.pid, startTime: holder.startTime, token: crypto.randomUUID() })}\n`,
      { mode: 0o600 },
    );
    holder.process.kill();
    await holder.process.exited;
    expect(store.writeVersionedJson(file, { after: true }).value).toEqual({ after: true });
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("takes over a versioned-state lock after its holder dies", async () => {
    const root = target();
    const store = new ProjectStore(root);
    const file = path.join(store.layout.runs, "dead_lock.json");
    store.mutateVersionedJson(file, () => ({ before: true }));
    const holder = await childHoldingLock();
    const lock = `${file}.lock`;
    fs.writeFileSync(
      lock,
      `${JSON.stringify({ pid: holder.process.pid, startTime: holder.startTime, token: crypto.randomUUID() })}\n`,
      {
        mode: 0o600,
      },
    );
    holder.process.kill();
    await holder.process.exited;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        process.kill(holder.process.pid, 0);
        await Bun.sleep(5);
      } catch {
        break;
      }
    }
    expect(store.mutateVersionedJson(file, () => ({ after: true })).value).toEqual({ after: true });
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("direct writer uses the lock start-time witness when a pid is reused", () => {
    const root = target();
    const store = new ProjectStore(root);
    const file = path.join(store.layout.runs, "direct_reused_pid.json");
    store.writeVersionedJson(file, { ready: true });
    const lock = `${file}.lock`;
    fs.writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, startTime: "0", token: crypto.randomUUID() })}\n`,
      { mode: 0o600 },
    );
    expect(store.writeVersionedJson(file, { recovered: true }).value).toEqual({ recovered: true });
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("uses the lock start-time witness when a pid is reused", () => {
    const root = target();
    const store = new ProjectStore(root);
    const file = path.join(store.layout.runs, "reused_pid.json");
    store.mutateVersionedJson(file, () => ({ ready: true }));
    const lock = `${file}.lock`;
    fs.writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, startTime: "0", token: crypto.randomUUID() })}\n`,
      {
        mode: 0o600,
      },
    );
    expect(store.mutateVersionedJson(file, () => ({ recovered: true })).value).toEqual({
      recovered: true,
    });
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("uses the procfs birth witness when a sandbox reuses a pid in the same tick", () => {
    const root = target();
    const store = new ProjectStore(root);
    const file = path.join(store.layout.runs, "reused_pid_same_tick.json");
    store.mutateVersionedJson(file, () => ({ ready: true }));
    const lock = `${file}.lock`;
    // External Codex execs can restart at PID 2 before the kernel's clock-tick
    // start-time changes.  The PID and start time below deliberately match
    // this live process; only the nanosecond procfs birth witness proves that
    // the lock belongs to its predecessor.
    fs.writeFileSync(
      lock,
      `${JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid), procfsCtimeNs: "0", token: crypto.randomUUID() })}\n`,
      { mode: 0o600 },
    );
    expect(store.mutateVersionedJson(file, () => ({ recovered: true })).value).toEqual({
      recovered: true,
    });
    expect(fs.existsSync(lock)).toBe(false);
    expect(processProcfsCtimeNs(process.pid)).not.toBe("0");
  });

  test("accepts an empty lock retry policy as the default policy", () => {
    expect(new ProjectStore(target(), { lockRetry: {} }).lockRetryDelaysMs).toEqual([
      10, 20, 40, 80,
    ]);
  });

  test("rejects invalid lock retry policy", () => {
    expect(() => new ProjectStore(target(), { lockRetry: { delaysMs: [] } })).toThrow(
      new ProjectStoreError(
        "invalid_config",
        "lockRetry.delaysMs",
        "lock retry delays must be a non-empty array of positive safe integers",
      ),
    );
    expect(() => new ProjectStore(target(), { lockRetry: { delaysMs: [0] } })).toThrow(
      ProjectStoreError,
    );
    expect(new ProjectStore(target(), { lockRetry: { delaysMs: [1] } }).lockRetryDelaysMs).toEqual([
      1,
    ]);
    expect(
      () =>
        new ProjectStore(target(), {
          lockRetry: { delaysMs: [1], unknown: true } as never,
        }),
    ).toThrow(ProjectStoreError);
    expect(() => new ProjectStore(target(), { lockRetry: [] as never })).toThrow(ProjectStoreError);
  });

  test("recovers a stale session lease but never steals a live one", async () => {
    const root = target();
    const store = new ProjectStore(root);
    const session = await store.createSession("stale_session");
    await session.close(BACKGROUND_CONTEXT);
    const lease = path.join(store.layout.tmp, "session-stale_session.lease");
    // Simulate a killed standalone role whose PID has already been reused by
    // this test process. A PID-only lease check would reject resume forever.
    const deadOwner = { pid: process.pid, startTime: "0", token: crypto.randomUUID() };
    fs.writeFileSync(lease, `${JSON.stringify(deadOwner)}\n`, { mode: 0o600 });
    const coordination = path.join(store.layout.tmp, "session-coordination.lock");
    fs.writeFileSync(coordination, `${JSON.stringify(deadOwner)}\n`, { mode: 0o600 });
    const reopened = await new ProjectStore(root).resumeSession("stale_session");
    await reopened.close(BACKGROUND_CONTEXT);
    expect(fs.existsSync(lease)).toBe(false);
    expect(fs.existsSync(coordination)).toBe(false);
  });

  test("resume reclaims the empty legacy session lease left when its owner was killed", async () => {
    const root = target();
    const store = new ProjectStore(root, { lockRetry: { delaysMs: [1] } });
    const session = await store.createSession("empty_lease_session");
    await session.close(BACKGROUND_CONTEXT);
    const lease = path.join(store.layout.tmp, "session-empty_lease_session.lease");
    // Pre-0.181.16 created this O_EXCL pathname before it wrote the PID and
    // token.  SIGKILL at that exact point left an empty lease which could not
    // be recognised as either a live owner or a reclaimable dead owner.
    fs.writeFileSync(lease, "", { mode: 0o600 });

    const reopened = await new ProjectStore(root, { lockRetry: { delaysMs: [1] } }).resumeSession(
      "empty_lease_session",
    );
    await reopened.close(BACKGROUND_CONTEXT);

    expect(fs.existsSync(lease)).toBe(false);
  });

  test("recovers legacy pid-only session locks after a killed standalone role", async () => {
    const root = target();
    const store = new ProjectStore(root);
    const session = await store.createSession("legacy_session");
    await session.close(BACKGROUND_CONTEXT);
    const holder = await childHoldingLock();
    const lease = path.join(store.layout.tmp, "session-legacy_session.lease");
    const coordination = path.join(store.layout.tmp, "session-coordination.lock");
    // This is the on-disk form a standalone role from before the start-time
    // witness left behind when its harness was killed.
    fs.writeFileSync(lease, `${JSON.stringify({ pid: holder.process.pid })}\n`, { mode: 0o600 });
    fs.writeFileSync(coordination, `${JSON.stringify({ pid: holder.process.pid })}\n`, {
      mode: 0o600,
    });
    holder.process.kill();
    await holder.process.exited;

    const reopened = await new ProjectStore(root).resumeSession("legacy_session");
    await reopened.close(BACKGROUND_CONTEXT);

    expect(fs.existsSync(lease)).toBe(false);
    expect(fs.existsSync(coordination)).toBe(false);
  });

  test("cleanup skips a session leased by another store", async () => {
    const root = target();
    const first = new ProjectStore(root, { retention: { sessions: 1 } });
    const active = await first.createSession("z_old_active");
    const second = new ProjectStore(root, { retention: { sessions: 1 } });
    const recent = await second.createSession("a_recent_closed");
    await recent.close(BACKGROUND_CONTEXT);
    expect(await second.cleanup("sessions")).toEqual({ area: "sessions", removed: [] });
    expect((await second.listSessions()).map(({ id }) => id).sort()).toEqual([
      "a_recent_closed",
      "z_old_active",
    ]);
    await active.close(BACKGROUND_CONTEXT);
    expect((await second.cleanup("sessions")).removed).toEqual(["z_old_active"]);
  });

  test("session listing filters metadata belonging to another target", async () => {
    const root = target();
    const store = new ProjectStore(root);
    const own = await store.createSession("own_session");
    await own.close(BACKGROUND_CONTEXT);
    const repo = new JsonlSessionRepo({
      fileSystem: store.fileSystem,
      sessionsRoot: store.layout.sessions,
    });
    const foreign = await repo.create({ id: "foreign_session", cwd: target() }, BACKGROUND_CONTEXT);
    await foreign.close(BACKGROUND_CONTEXT);
    expect((await store.listSessions()).map(({ id }) => id)).toEqual(["own_session"]);
  });

  test("copies stable attachment bytes and rejects escaping names", async () => {
    const root = target();
    const source = path.join(root, "source.txt");
    fs.writeFileSync(source, "attached");
    const store = new ProjectStore(root);
    const metadata = await store.copyAttachment(source, "note.txt", "attachment_one");
    expect(metadata).toMatchObject({ name: "note.txt", size: 8 });
    expect(fs.readFileSync(metadata.path, "utf8")).toBe("attached");
    expect(fs.statSync(metadata.path).mode & 0o777).toBe(0o600);
    expect(
      fs.statSync(path.join(store.layout.attachments, metadata.id, "manifest.json")).mode & 0o777,
    ).toBe(0o600);
    expect(new ProjectStore(root).readAttachment("attachment_one")).toEqual(metadata);
    await expect(store.copyAttachment(source, "../escape", "bad_name")).rejects.toBeInstanceOf(
      ProjectStoreError,
    );
    await expect(store.copyAttachment(source, "/absolute", "bad_absolute")).rejects.toBeInstanceOf(
      ProjectStoreError,
    );
    await expect(store.copyAttachment(source, "..", "bad_dot")).rejects.toBeInstanceOf(
      ProjectStoreError,
    );
    await expect(store.copyAttachment(root, "directory", "bad_source")).rejects.toMatchObject({
      code: "unsafe_object",
    });
    const sourceLink = path.join(root, "source-link");
    fs.symlinkSync(source, sourceLink);
    await expect(store.copyAttachment(sourceLink, "link", "bad_link")).rejects.toThrow();

    const outside = path.join(target(), "outside.txt");
    fs.writeFileSync(outside, "outside");
    const linkedDir = path.join(store.layout.attachments, "linked_destination");
    fs.mkdirSync(linkedDir);
    fs.linkSync(outside, path.join(linkedDir, "note.txt"));
    await expect(
      store.copyAttachment(source, "note.txt", "linked_destination"),
    ).rejects.toMatchObject({ code: "unsafe_object" });

    const manifestPath = path.join(store.layout.attachments, metadata.id, "manifest.json");
    store.writeVersionedJson(manifestPath, { ...metadata, path: outside }, 1);
    expect(() => store.readAttachment(metadata.id)).toThrow(ProjectStoreError);
  });

  test("supports version conflicts and deletion-disabled cleanup", async () => {
    const store = new ProjectStore(target());
    const statePath = path.join(store.layout.runs, "state.json");
    expect(store.writeVersionedJson(statePath, { ok: true })).toMatchObject({ version: 1 });
    expect(() => store.writeVersionedJson(statePath, { ok: false }, 0)).toThrow(ProjectStoreError);
    expect(new ProjectStore(store.layout.targetDir).readVersionedJson(statePath)).toEqual({
      version: 1,
      value: { ok: true },
    });
    fs.writeFileSync(`${statePath}.interrupted.tmp`, "partial");
    expect(store.readVersionedJson(statePath).value).toEqual({ ok: true });
    expect((await store.cleanup("runs")).removed).toEqual([]);
  });

  test("a corrupt managed state file is a typed store error, not a raw parse crash", () => {
    const store = new ProjectStore(target());
    const statePath = path.join(store.layout.runs, "corrupt.json");
    store.writeVersionedJson(statePath, { ok: true });
    fs.writeFileSync(statePath, "{corrupted");
    try {
      store.readVersionedJson(statePath);
      expect.unreachable();
    } catch (error) {
      // A raw SyntaxError escaped every handler that keys on ProjectStoreError:
      // `runs stop` reported a corrupt run record as a crash instead of a
      // refusal (issue #479). The store owns the read, so the read types it.
      expect(error).toBeInstanceOf(ProjectStoreError);
      expect(error).toMatchObject({ code: "corrupt_state", path: statePath });
      // The parser's message embeds a content snippet; the typed message must
      // not carry file contents.
      expect((error as ProjectStoreError).message).toBe("managed state is not parseable JSON");
      expect((error as ProjectStoreError).message).not.toContain("corrupted");
    }
  });

  test("positive cleanup removes only the oldest managed directories", async () => {
    const root = target();
    const store = new ProjectStore(root, { retention: { runs: 1 } });
    const old = path.join(store.layout.runs, "old_run");
    const current = path.join(store.layout.runs, "current_run");
    const unknown = path.join(store.layout.runs, "not.managed");
    fs.mkdirSync(old);
    fs.mkdirSync(current);
    fs.mkdirSync(unknown);
    fs.utimesSync(old, 1, 1);
    fs.utimesSync(current, 2, 2);
    expect(await store.cleanup("runs")).toEqual({ area: "runs", removed: ["old_run"] });
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);
  });

  test("enforces configured JSONL limits for durable sessions", async () => {
    const store = new ProjectStore(target(), { byteLimits: { jsonlRecord: 8 } });
    await expect(store.createSession("limited_session")).rejects.toMatchObject({
      code: "resource_limit",
    });
  });

  test("commits concurrent session transactions in sequence order", async () => {
    const store = new ProjectStore(target());
    const journal = path.join(store.layout.sessions, "ordered.jsonl");
    const later = store.fileSystem.appendFile(
      journal,
      `${JSON.stringify({ kind: "value", op: "set", seq: 3, namespace: "test", key: "later" })}\n`,
      BACKGROUND_CONTEXT,
    );
    const first = store.fileSystem.appendFile(
      journal,
      `${JSON.stringify({ kind: "value", op: "set", seq: 1, namespace: "test", key: "first" })}\n`,
      BACKGROUND_CONTEXT,
    );
    const second = store.fileSystem.appendFile(
      journal,
      `${JSON.stringify({ kind: "value", op: "set", seq: 2, namespace: "test", key: "second" })}\n`,
      BACKGROUND_CONTEXT,
    );
    await expect(Promise.all([later, first, second])).resolves.toEqual([
      { ok: true, value: undefined },
      { ok: true, value: undefined },
      { ok: true, value: undefined },
    ]);
    expect(
      fs
        .readFileSync(journal, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { seq: number }).seq),
    ).toEqual([1, 2, 3]);
  });

  test("resumes a complete journal whose older appends arrived out of order", async () => {
    const root = target();
    const store = new ProjectStore(root);
    const created = await store.createSession("reordered_session");
    const branch = await created.createBranch("main", null, BACKGROUND_CONTEXT);
    await branch.appendCustomEntry("test", { ready: true }, BACKGROUND_CONTEXT);
    await created.close(BACKGROUND_CONTEXT);
    const [metadata] = await store.listSessions();
    if (metadata === undefined) throw new Error("missing session metadata");
    const records = fs
      .readFileSync(metadata.path, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .flatMap((line) => {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed : [parsed];
      }) as Array<{ seq: number }>;
    const last = records.at(-1)?.seq;
    if (last === undefined) throw new Error("missing session transaction");
    fs.appendFileSync(
      metadata.path,
      `${JSON.stringify({ kind: "value", op: "set", seq: last + 2, namespace: "test", key: "later" })}\n${JSON.stringify({ kind: "value", op: "set", seq: last + 1, namespace: "test", key: "first" })}\n`,
    );
    const resumed = await new ProjectStore(root).resumeSession("reordered_session");
    await resumed.close(BACKGROUND_CONTEXT);
    const sequences = fs
      .readFileSync(metadata.path, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .flatMap((line) => {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed : [parsed];
      })
      .map(({ seq }: { seq: number }) => seq);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
  });

  test("pauses an overlapping journal until an explicit clear preserves it", async () => {
    const root = target();
    const store = new ProjectStore(root);
    const created = await store.createSession("ambiguous_session");
    const branch = await created.createBranch("main", null, BACKGROUND_CONTEXT);
    await branch.appendCustomEntry("test", { ready: true }, BACKGROUND_CONTEXT);
    await created.close(BACKGROUND_CONTEXT);
    const [metadata] = await store.listSessions();
    if (metadata === undefined) throw new Error("missing session metadata");
    const records = fs
      .readFileSync(metadata.path, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .flatMap((line) => {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed : [parsed];
      }) as Array<{ seq: number }>;
    const duplicate = records.at(-1)?.seq;
    if (duplicate === undefined) throw new Error("missing session transaction");
    fs.appendFileSync(
      metadata.path,
      `${JSON.stringify({ kind: "value", op: "set", seq: duplicate, namespace: "test", key: "duplicate" })}\n`,
    );
    const before = fs.readFileSync(metadata.path, "utf8");
    expect(store.fileSystem.repairOutOfOrderTransactions(metadata.path)).toBe(false);
    expect(fs.readFileSync(metadata.path, "utf8")).toBe(before);
    // A normal resume is read-only.  It returns a typed ambiguity instead of
    // inventing an ordering that would lose one of the colliding records.
    await expect(new ProjectStore(root).resumeSession("ambiguous_session")).rejects.toMatchObject({
      code: "ambiguous_journal",
      path: metadata.path,
    });
    expect(fs.readFileSync(metadata.path, "utf8")).toBe(before);

    // Clear is an explicit operator recovery action. It moves the exact bytes
    // out of the active sessions directory and records their safe location on
    // the new same-id continuation; it never rewrites or drops the evidence.
    const recovered = await new ProjectStore(root).clearAmbiguousSession("ambiguous_session");
    const recovery = (await recovered.findEntries({ type: "custom" }, BACKGROUND_CONTEXT)).find(
      (entry) => entry.type === "custom" && entry.customType === "ad-coder.session_recovery",
    );
    expect(recovery).toMatchObject({
      type: "custom",
      data: {
        state: "cleared_ambiguous_journal",
        recovery: "new_continuation",
        artifact: { type: "ambiguous_journal" },
      },
    });
    if (recovery?.type !== "custom") throw new Error("missing durable recovery entry");
    const artifact = (recovery.data as { artifact: { path: string } }).artifact.path;
    expect(artifact).toContain(path.join(".ad-coder", "scratch", "recovery"));
    expect(fs.readFileSync(artifact, "utf8")).toBe(before);
    await recovered.close(BACKGROUND_CONTEXT);
    await expect(new ProjectStore(root).resumeSession("ambiguous_session")).resolves.toBeDefined();
  });

  test("rejects a pre-planted runtime symlink", () => {
    const root = target();
    const outside = target();
    fs.mkdirSync(path.join(root, ".ad-coder"));
    fs.symlinkSync(outside, path.join(root, ".ad-coder", "sessions"));
    expect(() => new ProjectStore(root)).toThrow(ProjectStoreError);
  });

  test("rejects malformed identifiers and state paths outside the store", async () => {
    const root = target();
    const store = new ProjectStore(root);
    await expect(store.createSession("../escape")).rejects.toMatchObject({ code: "invalid_id" });
    expect(() => store.writeVersionedJson(path.join(root, "outside.json"), {})).toThrow(
      ProjectStoreError,
    );
  });
});
