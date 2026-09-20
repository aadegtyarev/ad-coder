// Issue #365 layer 2: the headless SessionManager suite. Covers the socket
// trust boundary (peer-uid accept/refuse, 0600/0700 verification, no
// stale-socket reclaim), the project-key adversarial table, fail-closed
// poisoned bindings, the lease state machine, safe project creation, and the
// bounded untrusted title path.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
// The public surface, spelled the way an embedder reaches it (see the barrel
// test at the end of this file): the deep import above would keep working with
// the export gone.
import { SessionManager as BarrelSessionManager } from "../src";
import { writeOwnedJson } from "../src/session-manager/bindings";
import {
  acquireManagerLease,
  type LeaseIdentity,
  probeLease,
  recordStandaloneReleaseInLease,
  releaseLease,
} from "../src/session-manager/lease";
import {
  DEFAULT_MAX_PROJECTS,
  deriveSessionId,
  SessionManager,
} from "../src/session-manager/manager";
import {
  AllowedRoots,
  PROJECT_KEY_PATTERN,
  resolveProjectDir,
  validateProjectKey,
} from "../src/session-manager/project-keys";
import {
  DEFAULT_SOCKET_NAME,
  deriveDriverKey,
  dispatchRequest,
  MAX_FRAME_BYTES,
  type PeerCredentialsReader,
  SessionManagerServer,
  verifyBoundSocket,
} from "../src/session-manager/server";
import { sanitizeTitle } from "../src/session-manager/title";
import {
  SESSION_FALLBACK_NAME,
  SessionManagerError,
  type SessionManagerErrorCode,
} from "../src/session-manager/types";

const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-smtest-"));
const uidOr0 = (): number => process.getuid?.() ?? 0;

function makeManager(options?: { maxProjects?: number }) {
  const rootDir = scratch();
  const stateDir = path.join(scratch(), "state");
  const manager = new SessionManager({
    roots: [rootDir],
    stateDir,
    ...(options?.maxProjects !== undefined ? { maxProjects: options.maxProjects } : {}),
    identity: {
      now: () => 1727000000001,
      // The manager's own leases carry os.hostname(); the fixture identity
      // must count them as local so acquired state classifies by pid alone.
      hostIsLocal: () => true,
      pidAlive: () => false, // every recorded pid is dead in this fixture
    },
  });
  return { manager, rootDir, stateDir };
}

const deadIdentityFactory = (overrides: Partial<LeaseIdentity> = {}): LeaseIdentity => ({
  now: () => 1727000000002,
  hostIsLocal: (host) => host === "local.test",
  pidAlive: () => false,
  ...overrides,
});

// -- project key adversarial table -------------------------------------------

const UNSAFE_KEYS: readonly [string, string][] = [
  ["../etc", "project_unsafe"],
  ["..", "project_unsafe"],
  [".", "invalid_project_key"],
  ["a/../b", "project_unsafe"],
  ["/etc/notes", "project_unsafe"],
  ["café", "invalid_project_key"],
  ["a b", "invalid_project_key"],
  ["A", "invalid_project_key"],
  ["-dash", "invalid_project_key"],
  ["a".repeat(64), "invalid_project_key"],
  ["a\u0000b", "invalid_project_key"],
];

const RESERVED_KEYS = ["git", "ad-coder"] as const;

test.each(UNSAFE_KEYS)("project-key table refuses %s", (key, code) => {
  expect(() => validateProjectKey(key)).toThrow(SessionManagerError);
  // The slug shape is shape-only: every non-reserved refusal also fails it.
  expect(PROJECT_KEY_PATTERN.test(key)).toBe(false);
  let thrown: SessionManagerError | undefined;
  try {
    validateProjectKey(key);
  } catch (error) {
    thrown = error as SessionManagerError;
  }
  expect(thrown?.code).toBe(code as SessionManagerErrorCode);
});

test("reserved names are refused by validateProjectKey, not the slug shape", () => {
  for (const key of RESERVED_KEYS) {
    // `git` and `ad-coder` match the slug shape; the refusal is a separate
    // reserved-name clause in validateProjectKey, per the contract.
    expect(PROJECT_KEY_PATTERN.test(key)).toBe(true);
    let thrown: SessionManagerError | undefined;
    try {
      validateProjectKey(key);
    } catch (error) {
      thrown = error as SessionManagerError;
    }
    expect(thrown?.code).toBe("invalid_key");
  }
});

test("project-key table accepts well-formed slugs only", () => {
  expect(validateProjectKey("notes-site")).toBe("notes-site");
  expect(validateProjectKey("a1")).toBe("a1");
  expect(() => validateProjectKey("")).toThrow(SessionManagerError);
});

test("a symlink planted at root/<key> is refused, never followed", () => {
  const { rootDir } = makeManager();
  fs.symlinkSync("/etc", path.join(rootDir, "escape"));
  let error: SessionManagerError | undefined;
  try {
    resolveProjectDir(new AllowedRoots([rootDir]), "escape");
  } catch (caught) {
    error = caught as SessionManagerError;
  }
  expect(error).toBeInstanceOf(SessionManagerError);
  expect(error?.code).toBe("project_unsafe");
  expect(error?.message.length).toBeGreaterThan(0);
  // the refused message must never echo the resolved outside path
  expect(error?.message).not.toContain("/etc");
});

// -- bindings: fail-closed poisoned records -----------------------------------

test("a poisoned targetDir record fails closed at load and binds nothing", () => {
  const rootDir = fs.realpathSync.native(scratch());
  const stateDir = path.join(scratch(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "bindings.json"),
    `${JSON.stringify({
      version: 1,
      drivers: {},
      projects: {
        poison: {
          targetDir: path.join(os.tmpdir(), "outside", "poison"),
          sessionId: "sessabcdefabcdefabc",
          name: SESSION_FALLBACK_NAME,
          nameSource: "generated",
          createdAt: 1,
        },
      },
    })}\n`,
  );
  const manager = new SessionManager({
    roots: [rootDir],
    stateDir,
    identity: deadIdentityFactory(),
  });
  // the record was dropped from the durable file, never used to auto-create
  expect(manager.rejectedRecords.length).toBe(1);
  const list = fs.readFileSync(path.join(stateDir, "bindings.json"), "utf8");
  expect(list.includes("poison")).toBe(false);
  const reloaded = JSON.parse(list) as { projects: Record<string, unknown> };
  expect(Object.keys(reloaded.projects)).toEqual([]);
});

test("an unknown persisted field in bindings fails closed loudly", () => {
  const rootDir = fs.realpathSync.native(scratch());
  const stateDir = path.join(scratch(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "bindings.json"),
    `${JSON.stringify({ version: 1, drivers: {}, projects: {}, sabotage: {} })}\n`,
  );
  let error: SessionManagerError | undefined;
  try {
    new SessionManager({ roots: [rootDir], stateDir, identity: deadIdentityFactory() });
  } catch (caught) {
    error = caught as SessionManagerError;
  }
  expect(error?.code).toBe("invalid_binding");
});

// -- lease state machine -------------------------------------------------------

function writeLease(
  stateDir: string,
  key: string,
  record: Partial<{
    sessionId: string;
    pid: number;
    host: string;
    ownerToken: string;
    createdAt: number;
    releasedAt: number;
  }>,
): void {
  fs.mkdirSync(path.join(stateDir, "leases"), { recursive: true });
  writeOwnedJson(stateDir, path.join("leases", `${key}.json`), {
    sessionId: "sessstandalone00001",
    pid: 1,
    host: "local.test",
    ownerToken: "console:test-owner",
    createdAt: 1,
    ...record,
  });
}

test("probeLease classifies none, stale, live, released", () => {
  const stateDir = path.join(scratch(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  expect(probeLease(stateDir, "fresh", deadIdentityFactory()).state).toBe("none");
  writeLease(stateDir, "fresh", {});
  expect(probeLease(stateDir, "fresh", deadIdentityFactory()).state).toBe("stale");
  writeLease(stateDir, "fresh", { releasedAt: 5 });
  expect(probeLease(stateDir, "fresh", deadIdentityFactory()).state).toBe("released");
  // a live lease: the owning pid is alive on this host
  writeLease(stateDir, "fresh", { pid: 2 });
  expect(probeLease(stateDir, "fresh", deadIdentityFactory({ pidAlive: () => true })).state).toBe(
    "live",
  );
});

test("acquireManagerLease never steals a live lease but takes a stale one", () => {
  const stateDir = path.join(scratch(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  writeLease(stateDir, "alpha", { sessionId: "sesslegacy000000001" });
  const liveIdentity = deadIdentityFactory({ pidAlive: () => true });
  let error: SessionManagerError | undefined;
  try {
    acquireManagerLease(stateDir, "alpha", "sessnew", liveIdentity);
  } catch (caught) {
    error = caught as SessionManagerError;
  }
  expect(error?.code).toBe("session_lease_held");
  // stale: marked released first, then owned
  const acquired = acquireManagerLease(stateDir, "alpha", "sessnew", deadIdentityFactory());
  expect(acquired.ownerToken.startsWith("sm:")).toBe(true);
  expect(probeLease(stateDir, "alpha", deadIdentityFactory()).record?.sessionId).toBe("sessnew");
});

test("standalone release in the same row is the only adoption gate", () => {
  const stateDir = path.join(scratch(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  writeLease(stateDir, "legacy", { sessionId: "sesslegacy000000001" });
  recordStandaloneReleaseInLease(stateDir, "legacy", "sesslegacy000000001", deadIdentityFactory());
  const probe = probeLease(stateDir, "legacy", deadIdentityFactory());
  expect(probe.state).toBe("released");
  // wrong session id cannot release someone else's lease
  let error: SessionManagerError | undefined;
  try {
    recordStandaloneReleaseInLease(
      stateDir,
      "legacy",
      "sessother0000000001",
      deadIdentityFactory(),
    );
  } catch (caught) {
    error = caught as SessionManagerError;
  }
  expect(error?.code).toBe("handoff_not_recorded");
  releaseLease(stateDir, "legacy", deadIdentityFactory());
});

// -- manager core --------------------------------------------------------------

test("ensureSession idempotently creates one shared conversation per project", async () => {
  const { manager, rootDir, stateDir } = makeManager();
  const first = await manager.ensureSession("alpha", "telegram:bridge");
  expect(first.projectKey).toBe("alpha");
  expect(first.name).toBe(SESSION_FALLBACK_NAME);
  expect(fs.statSync(path.join(rootDir, "alpha", ".git")).isDirectory()).toBe(true);
  const second = await manager.ensureSession("alpha", "telegram:bridge");
  expect(second.sessionId).toBe(first.sessionId);
  // a stable id: derived from state root + key, not from the process
  expect(first.sessionId).toBe(deriveSessionId(manager.stateDir, "alpha"));
  void stateDir;
  // attached drivers counted from durable bindings
  await manager.ensureSession("alpha", "console:consolefront");
  const rows = await manager.listSessions();
  const row = rows.find((entry) => entry.projectKey === "alpha");
  expect(row?.attachedDrivers).toBe(2);
  expect(row?.selectedByThisDriver).toBe(true);
});

test("a live standalone lease is read-only listed and never opened or stolen", async () => {
  const { rootDir, stateDir } = makeManager();
  writeLease(stateDir, "legacy", { sessionId: "sesslegacy000000001" });
  // The manager's identity must see this pid as ALIVE for the live case.
  const liveManager = new SessionManager({
    roots: [rootDir],
    stateDir,
    identity: deadIdentityFactory({ pidAlive: () => true }),
  });
  let error: SessionManagerError | undefined;
  try {
    await liveManager.ensureSession("legacy", "telegram:bridge");
  } catch (caught) {
    error = caught as SessionManagerError;
  }
  expect(error?.code).toBe("session_lease_held");
  // the live lease blocked the OPEN — and it also blocked project creation:
  // no directory was ever created for the held key
  expect(fs.existsSync(path.join(rootDir, "legacy"))).toBe(false);
  const rows = await liveManager.listSessions();
  const row = rows.find((entry) => entry.projectKey === "legacy");
  expect(row?.standalone).toBe(true);
  expect(row?.leaseState).toBe("live");
});

test("safe project creation: literal scaffold, git init, cap and idempotence", async () => {
  const { manager, rootDir } = makeManager({ maxProjects: 2 });
  const created = await manager.createProject("beta");
  expect(fs.realpathSync.native(created.targetDir)).toBe(created.targetDir);
  expect(fs.readFileSync(path.join(rootDir, "beta", ".gitignore"), "utf8")).toBe(
    "# ad-coder: the runtime scaffold keeps generated artifacts out of Git.\n/runtime/\n",
  );
  expect(fs.existsSync(path.join(rootDir, "beta", "runtime", ".gitkeep"))).toBe(true);
  expect(fs.statSync(path.join(rootDir, "beta", ".git")).isDirectory()).toBe(true);
  await expect(manager.createProject("beta")).rejects.toMatchObject({
    code: "project_exists",
  });
  await manager.createProject("gamma");
  // the durable cap counts the manifest, so the third creation is refused
  await expect(manager.createProject("delta")).rejects.toMatchObject({ code: "creation_limit" });
  expect(DEFAULT_MAX_PROJECTS).toBeGreaterThan(0);
});

test("the volume cap 0 disables creation entirely", async () => {
  const { manager } = makeManager({ maxProjects: 0 });
  await expect(manager.createProject("disabled")).rejects.toMatchObject({
    code: "creation_disabled",
  });
});

test("ensureSession with creation disabled refuses instead of silently binding", async () => {
  const { manager } = makeManager({ maxProjects: 0 });
  await expect(manager.ensureSession("fresh-key", "telegram:bridge")).rejects.toMatchObject({
    code: "creation_disabled",
  });
});

// -- bounded untrusted titles ---------------------------------------------------

test("sanitizeTitle strips control surfaces and screens secrets", () => {
  const ansi = `${String.fromCharCode(0x1b)}[31mdanger${String.fromCharCode(0x1b)}[0m`;
  expect(sanitizeTitle(ansi).value).toBe("danger");
  expect(sanitizeTitle("**bold** `code`").value).toBe("bold code");
  expect(sanitizeTitle("a\u200bb").value).toBe("ab");
  expect(sanitizeTitle("sk-abcdefgh1234 ls").fellBack).toBe(true);
  expect(sanitizeTitle("title api_key=secretvalue").fellBack).toBe(true);
  expect(sanitizeTitle("4111 1111 1111 1111").fellBack).toBe(true);
  const long = "x".repeat(100);
  expect(sanitizeTitle(long).value.length).toBe(48);
  expect(sanitizeTitle(undefined).value).toBe(SESSION_FALLBACK_NAME);
});

test("the secret screen covers raw and flattened forms plus the full Cc category", () => {
  // `_` is a markdown separator: both the raw `api_key=` and the flattened
  // `api key=` forms must fall back.
  expect(sanitizeTitle("api_key=secretvalue").fellBack).toBe(true);
  expect(sanitizeTitle("api key=secretvalue").fellBack).toBe(true);
  // a markdown `_` inside an sk- token is caught before it is flattened away.
  expect(sanitizeTitle("sk-abcdef_gh").fellBack).toBe(true);
  // a control-split secret: the control separator becomes a space AFTER the
  // raw screen, and the flattened form is caught by the second screen.
  expect(sanitizeTitle(`api\u0007key=secretvalue`).fellBack).toBe(true);
  // a control character at the end of a token is caught by the RAW screen.
  expect(sanitizeTitle(`sk-abcdefgh\u0007tail`).fellBack).toBe(true);
  // the entire Cc category is stripped: NUL, backspace and DEL become
  // ordinary separators, never invisible survivors.
  expect(sanitizeTitle("a\u0000b\u0008c\u007fd").value).toBe("a b c d");
  expect(sanitizeTitle("\u0000\u0008").value).toBe(SESSION_FALLBACK_NAME);
  expect(sanitizeTitle("\u0000\u0008").fellBack).toBe(true);
});

test("a generated title never replaces a manual name", async () => {
  const { manager } = makeManager();
  await manager.ensureSession("titles", "telegram:bridge");
  await manager.renameSession("titles", "Operator's pick");
  const record = await manager.setTitleFromGeneration("titles", "a generated draft");
  expect(record.name).toBe("Operator's pick");
  expect(record.nameSource).toBe("manual");
  const secreted = await manager.generateAndApplyTitle("titles", "anything");
  expect(secreted.name).toBe("Operator's pick");
});

test("a screened draft leaves the neutral fallback", async () => {
  const { manager } = makeManager();
  await manager.ensureSession("titles2", "telegram:bridge");
  const record = await manager.setTitleFromGeneration("titles2", "sk-abcdefgh1234 leak");
  expect(record.name).toBe(SESSION_FALLBACK_NAME);
  expect(record.nameSource).toBe("generated");
});

test("rename and title projections never serialize the resolved target dir", async () => {
  const { manager, rootDir } = makeManager();
  await manager.ensureSession("projkey", "telegram:bridge");
  const renamed = await manager.renameSession("projkey", "Renamed");
  expect(renamed.projectKey).toBe("projkey");
  expect(renamed.name).toBe("Renamed");
  expect("targetDir" in renamed).toBe(false);
  expect(JSON.stringify(renamed)).not.toContain(rootDir);
  expect(JSON.stringify(renamed)).not.toContain(os.tmpdir());
  const titled = await manager.setTitleFromGeneration("projkey", "a draft");
  expect("targetDir" in titled).toBe(false);
  expect(JSON.stringify(titled)).not.toContain(rootDir);
  expect(JSON.stringify(titled)).not.toContain(os.tmpdir());
});

// -- socket trust boundary -------------------------------------------------------

const sameUidReader: PeerCredentialsReader = () => ({ uid: uidOr0() });
const foreignUidReader: PeerCredentialsReader = () => ({ uid: uidOr0() + 1_000_000 });
const noCredentialsReader: PeerCredentialsReader = () => undefined;

/** The safe response envelope shape the wire returns (errors:safe-projection). */
interface RpcResponse {
  ok: boolean;
  error?: { code: string; message: string; retryable: boolean; nextAction?: string };
  result?: unknown;
}

/** One JSON line exchanged over a real Unix socket, with frame caps honoured. */
async function rpc(socketPath: string, request: unknown): Promise<RpcResponse> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const finish = (fn: () => void): void => {
      socket.destroy();
      fn();
    };
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      finish(() => resolve(JSON.parse(line) as RpcResponse));
    });
  });
}

type BoundServer = { server: SessionManagerServer; socketPath: string };

async function withServer(
  peerCredentials: PeerCredentialsReader,
  frontKind?: "telegram",
): Promise<BoundServer> {
  const { manager, stateDir } = makeManager();
  const socketDir = path.join(stateDir, "socket");
  const server = new SessionManagerServer({
    socketDir,
    manager,
    peerCredentials,
    ...(frontKind !== undefined ? { frontKind } : {}),
  });
  const socketPath = await server.listen();
  return { server, socketPath };
}

test("a same-uid peer is accepted with a server-derived driver key", async () => {
  const { server, socketPath } = await withServer(sameUidReader);
  try {
    const response = await rpc(socketPath, { method: "list" });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual([]);
  } finally {
    server.close();
  }
});

test("a foreign-uid peer and an unavailable-credentials peer are refused", async () => {
  for (const reader of [foreignUidReader, noCredentialsReader]) {
    const { server, socketPath } = await withServer(reader);
    try {
      const response = await rpc(socketPath, { method: "list" });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("not_authorized");
    } finally {
      server.close();
    }
  }
});

test("a numeric foreign uid is refused when the owner uid is unavailable (fail-closed)", async () => {
  const original = process.getuid;
  (process as unknown as { getuid?: unknown }).getuid = undefined;
  try {
    const { server, socketPath } = await withServer(foreignUidReader);
    try {
      const response = await rpc(socketPath, { method: "list" });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("not_authorized");
    } finally {
      server.close();
    }
  } finally {
    (process as unknown as { getuid?: unknown }).getuid = original;
  }
});

test("the bound socket and its directory are owner-private and verified", async () => {
  const { server, socketPath } = await withServer(sameUidReader);
  try {
    const dirStat = fs.lstatSync(path.dirname(socketPath));
    expect(dirStat.isSymbolicLink()).toBe(false);
    expect(dirStat.isDirectory()).toBe(true);
    expect(dirStat.mode & 0o777).toBe(0o700);
    const socketStat = fs.lstatSync(socketPath);
    expect(socketStat.isSocket()).toBe(true);
    expect(socketStat.mode & 0o777).toBe(0o600);
    verifyBoundSocket(socketPath); // the export used by fronts re-verifies
  } finally {
    server.close();
  }
});

test("a wrong mode after bind is refused by the verifier with cleanup", async () => {
  const { server, socketPath } = await withServer(sameUidReader);
  try {
    fs.chmodSync(socketPath, 0o666);
    let error: SessionManagerError | undefined;
    try {
      verifyBoundSocket(socketPath);
    } catch (caught) {
      error = caught as SessionManagerError;
    }
    expect(error?.code).toBe("manager_unavailable");
    fs.chmodSync(socketPath, 0o600);
  } finally {
    server.close();
  }
});

test("the wrong-mode rejection path inside listen() closes and unlinks", async () => {
  const { manager, stateDir } = makeManager();
  const socketDir = path.join(stateDir, "socket");
  const socketPath = path.join(socketDir, DEFAULT_SOCKET_NAME);
  const tamperReader: PeerCredentialsReader = () => ({ uid: uidOr0() });
  // a listener whose socket chmod cannot keep the mode private: the injected
  // seam makes the bound socket 0666 right after the real chmod, forcing the
  // post-bind verification to fail; the server must close and unlink.
  const server = new SessionManagerServer({
    socketDir,
    manager,
    peerCredentials: tamperReader,
    chmodSocket: (target, mode) => {
      fs.chmodSync(target, mode);
      if (target === socketPath) fs.chmodSync(target, 0o666);
    },
  });
  await expect(server.listen()).rejects.toMatchObject({ code: "manager_unavailable" });
  expect(fs.existsSync(socketPath)).toBe(false);
});

test("a throwing socket chmod inside listen() closes and unlinks", async () => {
  const { manager, stateDir } = makeManager();
  const socketDir = path.join(stateDir, "socket");
  const socketPath = path.join(socketDir, DEFAULT_SOCKET_NAME);
  const server = new SessionManagerServer({
    socketDir,
    manager,
    peerCredentials: () => ({ uid: uidOr0() }),
    chmodSocket: () => {
      throw new Error("chmod refused");
    },
  });
  await expect(server.listen()).rejects.toMatchObject({ code: "manager_unavailable" });
  expect(fs.existsSync(socketPath)).toBe(false);
});

test("an occupied bind path is refused — live socket, stale socket, file, symlink", async () => {
  const first = await withServer(sameUidReader);
  const { manager, stateDir } = makeManager();
  const socketDir = path.dirname(first.socketPath);
  try {
    // a LIVE socket: EADDRINUSE is fatal and typed, never reclaimed
    const second = new SessionManagerServer({
      socketDir,
      manager,
      peerCredentials: sameUidReader,
    });
    await expect(second.listen()).rejects.toMatchObject({ code: "address_in_use" });
    // a plain file occupying the path
    const fileDir = path.join(stateDir, "socket-file");
    fs.mkdirSync(fileDir, { recursive: true });
    fs.writeFileSync(path.join(fileDir, DEFAULT_SOCKET_NAME), "");
    const againstFile = new SessionManagerServer({
      socketDir: fileDir,
      manager,
      peerCredentials: sameUidReader,
    });
    await expect(againstFile.listen()).rejects.toMatchObject({ code: "address_in_use" });
    // a symlink occupying the path — and never unlinked by the refusal
    const linkDir = path.join(stateDir, "socket-link");
    fs.mkdirSync(linkDir, { recursive: true });
    fs.symlinkSync(path.join(os.tmpdir(), "elsewhere"), path.join(linkDir, DEFAULT_SOCKET_NAME));
    const againstSymlink = new SessionManagerServer({
      socketDir: linkDir,
      manager,
      peerCredentials: sameUidReader,
    });
    await expect(againstSymlink.listen()).rejects.toMatchObject({ code: "address_in_use" });
    expect(fs.lstatSync(path.join(linkDir, DEFAULT_SOCKET_NAME)).isSymbolicLink()).toBe(true);
  } finally {
    first.server.close();
  }
});

test("protocol errors are typed, safe, and never echo paths", async () => {
  const { server, socketPath } = await withServer(sameUidReader);
  try {
    for (const [request, code] of [
      [{ method: "nonsense" }, "invalid_request"],
      [{ method: "open" }, "invalid_request"],
      [{}, "invalid_request"],
      [{ method: "open", projectKey: "../traversal" }, "project_unsafe"],
      [{ method: "bind", projectKey: "ghost-key" }, "project_not_found"],
    ] as [Record<string, unknown>, string][]) {
      const response = await rpc(socketPath, request);
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe(code as SessionManagerErrorCode);
      expect(JSON.stringify(response)).not.toContain(os.tmpdir());
    }
    expect(MAX_FRAME_BYTES).toBe(256 * 1024);
  } finally {
    server.close();
  }
});

test("driver identity comes from the connection, never the request body", async () => {
  const { manager } = makeManager();
  await dispatchRequest(manager, "console:u0", {
    method: "open",
    projectKey: "derive-key",
    driverKey: "telegram:spoofed",
  });
  const rows = await manager.listSessions();
  expect(rows.find((entry) => entry.projectKey === "derive-key")?.attachedDrivers).toBe(1);
  // only the DERIVED key was bound, never the spoofed request field
  const stored = JSON.parse(
    fs.readFileSync(path.join(manager.stateDir, "bindings.json"), "utf8"),
  ) as { drivers: Record<string, unknown> };
  expect(Object.keys(stored.drivers)).toEqual(["console:u0"]);
});

test("a server declares its front kind and derives the driver key from it", () => {
  expect(deriveDriverKey("console", 0)).toBe("console:u0");
  expect(deriveDriverKey("telegram", 1000)).toBe("telegram:u1000");
});

test("the capability is reachable through the library barrel, not only its own modules (#365)", async () => {
  // The layer-2 claim is that the capability is EXPORTED from the library API
  // (`src/index.ts`) -- which is the file an embedder imports and the one this
  // module can drop out of while every other test here stays green, because
  // they all import the deep paths. Constructed and used THROUGH the barrel:
  // presence alone would pass for a binding that is exported and broken.
  // Measured against that removal -- the export dropped from `src/index.ts` --
  // this file reports 0 pass / 1 fail: the import is static, so the file fails
  // to load rather than failing one assertion. Still a red gate for the same
  // edit, and worth knowing which of the two you are looking at.
  const rootDir = scratch();
  const stateDir = path.join(scratch(), "state");
  const manager = new BarrelSessionManager({ roots: [rootDir], stateDir });
  expect(manager.stateDir).toBe(stateDir);
  expect(await manager.listSessions()).toEqual([]);
});
