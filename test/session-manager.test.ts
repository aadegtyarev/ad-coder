// Issue #365 layer 2: the headless SessionManager suite. Covers the socket
// trust boundary (peer-uid accept/refuse, 0600/0700 verification, no
// stale-socket reclaim), the project-key adversarial table, fail-closed
// poisoned bindings, the lease state machine, safe project creation, the
// bounded untrusted title path, and segment-aware containment (a sibling that
// merely SHARES a root's prefix is outside it).

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
import { ucredBuffer, ucredUid } from "../src/session-manager/peer-credentials";
import {
  AllowedRoots,
  assertRealPathInsideRoot,
  isInsideRoot,
  PROJECT_KEY_PATTERN,
  resolveProjectDir,
  validateProjectKey,
} from "../src/session-manager/project-keys";
import {
  DEFAULT_SOCKET_NAME,
  defaultPeerCredentialsReader,
  deriveDriverKey,
  dispatchRequest,
  MAX_FRAME_BYTES,
  type PeerCredentialsReader,
  SessionManagerServer,
  verifyBoundSocket,
} from "../src/session-manager/server";
import {
  createManualSessionName,
  DEFAULT_TITLE_MAX_LENGTH,
  MANUAL_NAME_MAX_LENGTH,
  sanitizeTitle,
} from "../src/session-manager/title";
import {
  SESSION_FALLBACK_NAME,
  SessionManagerError,
  type SessionManagerErrorCode,
} from "../src/session-manager/types";

const ESC = String.fromCharCode(0x1b);
const REPO_ROOT = path.resolve(import.meta.dir, "..");
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

test("containment is segment-aware: a sibling sharing the root's prefix is outside (#365)", () => {
  // docs/contracts/session-manager.md names this counter-example by hand:
  // `root=/home/u/proj` must not admit `/home/u/proj-x`. Measured before this
  // test existed: replacing `isInsideRoot`'s `path.relative` body with
  // `candidate.startsWith(root)` left this whole file green (41 pass / 0
  // fail) -- and `assertRealPathInsideRoot` is that same predicate, gating
  // every adoption and every creation.
  const parent = fs.realpathSync.native(scratch());
  const root = path.join(parent, "proj");
  const sibling = path.join(parent, "proj-x");
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);
  const roots = new AllowedRoots([root]);
  expect(isInsideRoot(root, sibling)).toBe(false);
  expect(isInsideRoot(root, root)).toBe(true);
  expect(isInsideRoot(root, path.join(root, "child"))).toBe(true);
  expect(isInsideRoot(root, parent)).toBe(false);
  // The gate must refuse the sibling AND admit the immediate child: a
  // predicate that simply threw would satisfy the refusal on its own.
  expect(() => assertRealPathInsideRoot(sibling, roots)).toThrow(SessionManagerError);
  expect(() => assertRealPathInsideRoot(sibling, roots)).toThrow(/outside every allowed root/);
  expect(() => assertRealPathInsideRoot(path.join(root, "child"), roots)).not.toThrow();
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

test("a binding whose targetDir is a sibling sharing the root's prefix fails closed (#365)", () => {
  // The same counter-example as the containment test above, on the durable
  // record path. Measured before this test existed: weakening the check to
  // `real.startsWith(root)` adopted this record -- 41 pass / 0 fail, the
  // poisoned sibling bound as a project.
  const parent = fs.realpathSync.native(scratch());
  const rootDir = path.join(parent, "proj");
  const sibling = path.join(parent, "proj-x");
  fs.mkdirSync(rootDir);
  fs.mkdirSync(sibling);
  const stateDir = path.join(scratch(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "bindings.json"),
    `${JSON.stringify({
      version: 1,
      drivers: {},
      projects: {
        sibling: {
          targetDir: sibling,
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
  expect(manager.rejectedRecords.length).toBe(1);
  const list = fs.readFileSync(path.join(stateDir, "bindings.json"), "utf8");
  expect(list.includes("sibling")).toBe(false);
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

test("the length cap counts code points, so a surrogate pair is never cut (#365)", () => {
  // docs/contracts/session-manager.md: both name paths are "length-capped in
  // code points". Measured on this tree before the fix: clamping by UTF-16
  // units sliced through a surrogate pair, and the name persisted with a LONE
  // surrogate in it -- 25 code points instead of 48, `isWellFormed() === false`.
  // The ASCII case above never noticed, because a code unit IS a code point
  // there.
  const astral = "\u{1D11E}"; // one code point, two UTF-16 units
  const generated = sanitizeTitle(astral.repeat(60)).value;
  expect([...generated].length).toBe(DEFAULT_TITLE_MAX_LENGTH);
  expect(generated.endsWith("…")).toBe(true);
  expect(generated.isWellFormed()).toBe(true);
  const manual = createManualSessionName(astral.repeat(80));
  expect([...manual].length).toBe(MANUAL_NAME_MAX_LENGTH);
  expect(manual.isWellFormed()).toBe(true);
});

test("a manual name is secret-screened and leaves the neutral fallback (#365)", async () => {
  // docs/contracts/session-manager.md screens BOTH name paths ("Titles are
  // UNTRUSTED model output and manual names are remote user input: both ...
  // secret-screened ... A candidate that sanitizes to empty falls back to
  // `New session`"). Measured before the fix: the manual path skipped the
  // screen, so `renameSession` persisted a pasted secret into a display name
  // every front renders.
  for (const draft of [
    "token=sk-abcdefghijk",
    "sk-abcdefgh1234 ls",
    "4111 1111 1111 1111",
    "api​key=secretvalue", // split by a zero-width: caught after the strip
    "xoxb-1234567890abc",
  ])
    expect(createManualSessionName(draft)).toBe(SESSION_FALLBACK_NAME);
  // The typed refusal still owns the empty case -- a screened name is NOT one.
  expect(() => createManualSessionName("\u0000\u0008")).toThrow(RangeError);
  // An ordinary manual name is untouched, and the fallback is still a MANUAL
  // name: no later generated title may replace it.
  const { manager, stateDir } = makeManager();
  await manager.ensureSession("manual-screen", "telegram:bridge");
  const renamed = await manager.renameSession("manual-screen", "Operator's pick");
  expect(renamed.name).toBe("Operator's pick");
  expect(renamed.nameSource).toBe("manual");
  const screened = await manager.renameSession("manual-screen", "token=sk-abcdefghijk");
  expect(screened.name).toBe(SESSION_FALLBACK_NAME);
  expect(screened.nameSource).toBe("manual");
  // The secret reaches no durable byte: neither the projection nor the store.
  expect(JSON.stringify(screened)).not.toContain("sk-abcdefghijk");
  expect(fs.readFileSync(path.join(stateDir, "bindings.json"), "utf8")).not.toContain(
    "sk-abcdefghijk",
  );
});

test("no separator hides a secret from the manual screen (#365)", async () => {
  // Round 2 measured the bypass: the manual strip REPLACED the ESC byte of an
  // ANSI sequence instead of removing the sequence, so the persisted name was
  // `token [31m=supersecret` -- no assignment for the screen to see -- and the
  // secret reached bindings.json. A markdown character the manual path KEEPS
  // hid the same assignment the generated path catches.
  for (const draft of [
    `token${ESC}[31m=supersecret`,
    "token*=supersecret",
    "token`=supersecret",
    "token#=supersecret",
    "token~=supersecret",
  ])
    expect(createManualSessionName(draft)).toBe(SESSION_FALLBACK_NAME);
  // The separator the FLATTENED projection destroys, caught by the
  // persisted-form screen alone: `_` is a markdown character, so flattening
  // splits this token in two and the next screen can no longer see 8+ chars.
  expect(createManualSessionName("sk-abcdefg_h1234")).toBe(SESSION_FALLBACK_NAME);
  // The durable path, not just the function: a rename leaves no fragment of
  // the sequence and no secret in the store.
  const { manager, stateDir } = makeManager();
  await manager.ensureSession("separator-screen", "telegram:bridge");
  const record = await manager.renameSession("separator-screen", "token*=supersecret");
  expect(record.name).toBe(SESSION_FALLBACK_NAME);
  const durable = fs.readFileSync(path.join(stateDir, "bindings.json"), "utf8");
  expect(durable).not.toContain("supersecret");
  expect(durable).not.toContain("[31m");
  // An ordinary name with punctuation the manual path keeps is untouched: the
  // screen works on a projection that is never persisted.
  expect(createManualSessionName("Fix *urgent* thing")).toBe("Fix *urgent* thing");
  expect(createManualSessionName("snake_case name")).toBe("snake_case name");
});

test("a uid with the high bit set decodes as the kernel's unsigned uid (#365)", () => {
  // uid_t is an UNSIGNED 32-bit integer. Round 2 measured the signed decode:
  // 3_000_000_000 came back as -1294967296, which can never equal
  // `process.getuid()`'s positive value, so the owner of such a uid would be
  // refused on every connection on such a system.
  const ucred = ucredBuffer();
  ucred[1] = 3_000_000_000;
  expect(ucredUid(ucred)).toBe(3_000_000_000);
  ucred[1] = 0;
  expect(ucredUid(ucred)).toBe(0);
  expect(ucredBuffer().byteLength).toBe(12);
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

test("the DEFAULT reader authorizes a same-uid client via the kernel's lookup (#365)", async () => {
  // The production path: no injected reader (the CLI front constructs exactly
  // this way). Measured before the fix -- the default reader read a
  // `peerUid` attribution no runtime provides, so EVERY real same-uid client
  // was refused `not_authorized` and the advertised socket service was
  // unreachable. The uid below is the one the KERNEL reported for this
  // process on the accepted connection.
  const uid = process.getuid?.();
  if (uid === undefined) return; // no uid to attribute on this platform
  const { manager, stateDir } = makeManager();
  const socketDir = path.join(stateDir, "socket");
  const server = new SessionManagerServer({ socketDir, manager });
  const socketPath = await server.listen();
  try {
    const opened = await rpc(socketPath, { method: "open", projectKey: "default-reader" });
    expect(opened.ok).toBe(true);
    const listed = await rpc(socketPath, { method: "list" });
    expect(listed.ok).toBe(true);
    const rows = listed.result as { projectKey: string; selectedByThisDriver: boolean }[];
    expect(rows.map((row) => row.projectKey)).toEqual(["default-reader"]);
    expect(rows[0]?.selectedByThisDriver).toBe(true);
    // The durable trace names the uid the kernel attributed, under the front
    // kind the server declared -- never anything the client sent.
    const bindings = JSON.parse(fs.readFileSync(path.join(stateDir, "bindings.json"), "utf8")) as {
      drivers: Record<string, { projectKey: string }>;
    };
    expect(Object.keys(bindings.drivers)).toEqual([deriveDriverKey("console", uid)]);
    expect(bindings.drivers[deriveDriverKey("console", uid)]?.projectKey).toBe("default-reader");
  } finally {
    server.close();
  }
});

test("the default reader fails closed, and the refusal names its cause (#365)", async () => {
  // No descriptor was ever handed to this object, so there is no syscall to
  // make: the reader reports "no credentials" rather than inventing a uid.
  expect(defaultPeerCredentialsReader({} as net.Socket)).toBeUndefined();
  // The refusal distinguishes a missing credential from an intruder: an
  // unavailable lookup must not read as "you are not the owner".
  const { server, socketPath } = await withServer(noCredentialsReader);
  try {
    const response = await rpc(socketPath, { method: "list" });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("not_authorized");
    expect(response.error?.message).toContain("credentials could not be established");
  } finally {
    server.close();
  }
});

test("the CLI front itself serves a same-uid client (#365)", async () => {
  // The load-bearing end-to-end control for the fix above: the front the
  // operator runs (`ad-coder session-manager serve`) builds the server with NO
  // injected reader, so before the fix this connection was refused. It is also
  // the only test that drives the front's own option wiring.
  if (process.getuid?.() === undefined) return;
  const rootDir = scratch();
  const stateDir = path.join(scratch(), "state");
  const socketDir = path.join(scratch(), "socket");
  const configHome = scratch();
  const child = Bun.spawn(
    [
      "bun",
      "run",
      path.join(REPO_ROOT, "src/cli.ts"),
      "session-manager",
      "serve",
      "--allowed-roots",
      rootDir,
      "--state-dir",
      stateDir,
      "--socket-dir",
      socketDir,
      "--json",
    ],
    {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, XDG_CONFIG_HOME: configHome },
    },
  );
  try {
    const socketPath = path.join(socketDir, DEFAULT_SOCKET_NAME);
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(socketPath)) {
      if (Date.now() > deadline) throw new Error("the serve front never bound its socket");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const response = await rpc(socketPath, { method: "list" });
    expect(response.ok).toBe(true);
    expect(response.result).toEqual([]);
    const opened = await rpc(socketPath, { method: "open", projectKey: "cli-front" });
    expect(opened.ok).toBe(true);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await child.stdout.cancel();
    await child.stderr.cancel();
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
