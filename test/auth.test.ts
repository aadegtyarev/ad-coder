import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import {
  AuthError,
  assertCredentialPathOutsideProject,
  FileCredentialStore,
  getAuthStatus,
  login,
  logout,
  requireModelAuthentication,
} from "ad-coder";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function storePath(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-auth-"));
  roots.push(root);
  return { root, file: path.join(root, "private", "credentials.json") };
}

const oauth = {
  type: "oauth" as const,
  access: "sentinel-access",
  refresh: "sentinel-refresh",
  expires: Date.now() + 60_000,
};

async function runStoreProcess(
  file: string,
  action: "refresh" | "logout",
  marker?: string,
): Promise<void> {
  const script = `
    import { FileCredentialStore } from ${JSON.stringify(path.resolve("src/auth/credential-store.ts"))};
    import * as fs from "node:fs";
    const store = new FileCredentialStore({ path: process.env.TEST_CREDENTIAL_FILE });
    if (process.env.TEST_ACTION === "logout") await store.delete("openai-codex");
    else await store.modify("openai-codex", async (current) => {
      if (process.env.TEST_MARKER) fs.writeFileSync(process.env.TEST_MARKER, "locked");
      await Bun.sleep(100);
      return current ? { ...current, expires: current.expires + 1 } : undefined;
    });
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: {
      ...process.env,
      TEST_CREDENTIAL_FILE: file,
      TEST_ACTION: action,
      ...(marker !== undefined && { TEST_MARKER: marker }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    const diagnostic = (await new Response(child.stderr).text()).trim();
    throw new Error(`credential child exited ${exitCode}: ${diagnostic}`);
  }
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("credential child did not acquire its lock");
    await Bun.sleep(10);
  }
}

test("file credentials persist across instances with private directory and file modes", async () => {
  const { file } = storePath();
  await new FileCredentialStore({ path: file }).modify("openai-codex", async () => oauth);
  expect(await new FileCredentialStore({ path: file }).read("openai-codex")).toEqual(oauth);
  expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(await new FileCredentialStore({ path: file }).list()).toEqual([
    { providerId: "openai-codex", type: "oauth" },
  ]);
});

test("credential mutations serialize and a failed mutation preserves the prior file", async () => {
  const { file } = storePath();
  const store = new FileCredentialStore({ path: file });
  await store.modify("openai-codex", async () => oauth);
  const order: number[] = [];
  const first = store.modify("openai-codex", async (current) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(1);
    return { ...current!, expires: 2 };
  });
  const second = store.modify("openai-codex", async (current) => {
    order.push(2);
    return { ...current!, expires: 3 };
  });
  await Promise.all([first, second]);
  expect(order).toEqual([1, 2]);
  expect(((await store.read("openai-codex")) as typeof oauth | undefined)?.expires).toBe(3);
  await expect(
    store.modify("openai-codex", async () => {
      throw new Error("sentinel-access");
    }),
  ).rejects.toThrow();
  expect(
    (
      (await new FileCredentialStore({ path: file }).read("openai-codex")) as
        | typeof oauth
        | undefined
    )?.expires,
  ).toBe(3);
});

test("independent processes serialize refreshes and logout cannot be undone by an older refresh", async () => {
  const { root, file } = storePath();
  const store = new FileCredentialStore({ path: file });
  await store.modify("openai-codex", async () => oauth);
  await Promise.all([runStoreProcess(file, "refresh"), runStoreProcess(file, "refresh")]);
  expect(((await store.read("openai-codex")) as typeof oauth).expires).toBe(oauth.expires + 2);

  const marker = path.join(root, "refresh-locked");
  const refresh = runStoreProcess(file, "refresh", marker);
  await waitForFile(marker);
  const remove = runStoreProcess(file, "logout");
  await Promise.all([refresh, remove]);
  expect(await new FileCredentialStore({ path: file }).read("openai-codex")).toBeUndefined();
});

test("an interrupted publication artifact leaves the previous valid store readable", async () => {
  const { file } = storePath();
  const store = new FileCredentialStore({ path: file });
  await store.modify("openai-codex", async () => oauth);
  fs.writeFileSync(path.join(path.dirname(file), ".credentials.json.interrupted.tmp"), "{", {
    mode: 0o600,
  });
  expect(await new FileCredentialStore({ path: file }).read("openai-codex")).toEqual(oauth);
});

test("directory replacement during a transaction cannot redirect credential publication", async () => {
  const { root, file } = storePath();
  const store = new FileCredentialStore({ path: file });
  await store.modify("openai-codex", async () => oauth);
  const originalDirectory = path.dirname(file);
  const movedDirectory = path.join(root, "moved-private");
  await store.modify("openai-codex", async (current) => {
    if (current?.type !== "oauth") throw new Error("expected stored OAuth credential");
    fs.renameSync(originalDirectory, movedDirectory);
    fs.mkdirSync(originalDirectory, { mode: 0o700 });
    return { ...current, expires: current.expires + 1 };
  });
  expect(fs.existsSync(file)).toBe(false);
  const persisted = JSON.parse(
    fs.readFileSync(path.join(movedDirectory, path.basename(file)), "utf8"),
  ) as Record<string, typeof oauth>;
  expect(persisted["openai-codex"]?.expires).toBe(oauth.expires + 1);
});

test("an abandoned cross-process lock is recovered conservatively", async () => {
  const { file } = storePath();
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2_147_483_647, createdAt: 0 }), {
    mode: 0o600,
  });
  const old = new Date(0);
  fs.utimesSync(`${file}.lock`, old, old);
  const store = new FileCredentialStore({ path: file, staleLockMs: 0 });
  await store.modify("openai-codex", async () => oauth);
  expect(await store.read("openai-codex")).toEqual(oauth);
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
});

test("malformed, symlinked, and hard-linked credential files fail closed without token text", async () => {
  const malformed = storePath();
  fs.mkdirSync(path.dirname(malformed.file), { mode: 0o700 });
  fs.writeFileSync(malformed.file, '{"openai-codex":{"type":"oauth","access":"sentinel-access"}}', {
    mode: 0o600,
  });
  let malformedError: unknown;
  try {
    await new FileCredentialStore({ path: malformed.file }).list();
  } catch (error) {
    malformedError = error;
  }
  expect(malformedError).toBeInstanceOf(AuthError);
  expect(String(malformedError)).not.toContain("sentinel-access");

  const linked = storePath();
  fs.mkdirSync(path.dirname(linked.file), { mode: 0o700 });
  const target = path.join(linked.root, "target");
  fs.writeFileSync(target, "{}", { mode: 0o600 });
  fs.symlinkSync(target, linked.file);
  await expect(
    new FileCredentialStore({ path: linked.file }).modify("openai-codex", async () => oauth),
  ).rejects.toBeInstanceOf(AuthError);

  const hard = storePath();
  fs.mkdirSync(path.dirname(hard.file), { mode: 0o700 });
  const hardTarget = path.join(hard.root, "target");
  fs.writeFileSync(hardTarget, "{}", { mode: 0o600 });
  fs.linkSync(hardTarget, hard.file);
  await expect(new FileCredentialStore({ path: hard.file }).list()).rejects.toBeInstanceOf(
    AuthError,
  );
});

test("ancestor and lock symlinks plus shared credential directories fail closed", async () => {
  const ancestor = storePath();
  const privateTarget = path.join(ancestor.root, "target");
  fs.mkdirSync(privateTarget, { mode: 0o700 });
  fs.symlinkSync(privateTarget, path.dirname(ancestor.file));
  await expect(new FileCredentialStore({ path: ancestor.file }).list()).rejects.toBeInstanceOf(
    AuthError,
  );

  const lock = storePath();
  fs.mkdirSync(path.dirname(lock.file), { mode: 0o700 });
  fs.symlinkSync(path.join(lock.root, "missing"), `${lock.file}.lock`);
  await expect(
    new FileCredentialStore({ path: lock.file }).modify("openai-codex", async () => oauth),
  ).rejects.toBeInstanceOf(AuthError);

  const sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ad-coder-auth-shared-"));
  roots.push(sharedRoot);
  fs.chmodSync(sharedRoot, 0o777);
  await expect(
    new FileCredentialStore({ path: path.join(sharedRoot, "credentials.json") }).list(),
  ).rejects.toBeInstanceOf(AuthError);
});

test("credential path boundaries reject relative, project, git, and symlink aliases", () => {
  const { root } = storePath();
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  expect(() => assertCredentialPathOutsideProject("relative.json", project)).toThrow(AuthError);
  expect(() =>
    assertCredentialPathOutsideProject(path.join(project, "credentials.json"), project),
  ).toThrow(AuthError);
  expect(() =>
    assertCredentialPathOutsideProject(path.join(project, ".git", "auth.json"), project),
  ).toThrow(AuthError);
  const alias = path.join(root, "alias");
  fs.symlinkSync(project, alias);
  expect(() => assertCredentialPathOutsideProject(path.join(alias, "auth.json"), project)).toThrow(
    AuthError,
  );
});

test("headless auth projections never return credentials and preflight fails actionably", async () => {
  let authenticated = false;
  const models = {
    getProvider: () => ({}),
    checkAuth: async () =>
      authenticated ? { type: "oauth" as const, source: "OAuth" } : undefined,
    getAuth: async () =>
      authenticated ? { auth: { apiKey: "sentinel-access" }, source: "OAuth" } : undefined,
    login: async () => {
      authenticated = true;
      return oauth;
    },
    logout: async () => {
      authenticated = false;
    },
  } as unknown as Models;
  const interaction = { prompt: async () => "browser", notify: () => undefined };
  await expect(requireModelAuthentication(models, "openai-codex")).rejects.toMatchObject({
    code: "authentication_required",
    detail: "openai-codex",
  });
  const loginResult = await login(models, "openai-codex", "oauth", interaction);
  expect(loginResult).toEqual({ providerId: "openai-codex", authenticated: true, type: "oauth" });
  expect(JSON.stringify(loginResult)).not.toContain("sentinel");
  expect(await getAuthStatus(models, "openai-codex")).toEqual({
    providerId: "openai-codex",
    authenticated: true,
    type: "oauth",
    source: "OAuth",
  });
  expect(await logout(models, "openai-codex")).toEqual({
    providerId: "openai-codex",
    authenticated: false,
  });
});
