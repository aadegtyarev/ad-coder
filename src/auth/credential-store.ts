import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { AuthError } from "./errors";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 5 * 60_000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;

type CredentialFile = Record<string, Credential>;

export interface FileCredentialStoreOptions {
  path?: string;
  lockWaitMs?: number;
  staleLockMs?: number;
}

export function defaultCredentialPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME;
  return path.join(
    configHome && path.isAbsolute(configHome) ? configHome : path.join(os.homedir(), ".config"),
    "ad-coder",
    "credentials.json",
  );
}

export function assertCredentialPathOutsideProject(
  credentialPath: string,
  targetDir: string,
): void {
  if (!path.isAbsolute(credentialPath))
    throw new AuthError(
      "invalid_credential_path",
      credentialPath,
      "credential path must be absolute",
    );
  const canonicalProspectivePath = (selected: string): string => {
    let existing = selected;
    const missing: string[] = [];
    while (!fs.existsSync(existing)) {
      missing.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    return path.join(fs.realpathSync(existing), ...missing);
  };
  const project = canonicalProspectivePath(path.resolve(targetDir));
  let existing = path.dirname(credentialPath);
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const candidateParent = path.join(fs.realpathSync(existing), ...missing);
  const candidate = path.join(candidateParent, path.basename(credentialPath));
  const inside = (root: string): boolean =>
    candidate === root || candidate.startsWith(`${root}${path.sep}`);
  if (inside(project))
    throw new AuthError(
      "invalid_credential_path",
      candidate,
      "credential path must be outside the target project and Git metadata",
    );
  const gitEntry = path.join(project, ".git");
  if (fs.existsSync(gitEntry)) {
    const stat = fs.lstatSync(gitEntry);
    if (stat.isDirectory()) {
      const gitRoot = fs.realpathSync(gitEntry);
      if (inside(gitRoot))
        throw new AuthError(
          "invalid_credential_path",
          candidate,
          "credential path must be outside the target project and Git metadata",
        );
    } else if (stat.isFile()) {
      const content = fs.readFileSync(gitEntry, "utf8").trim();
      if (content.startsWith("gitdir:")) {
        const gitRoot = fs.realpathSync(
          path.resolve(project, content.slice("gitdir:".length).trim()),
        );
        if (inside(gitRoot))
          throw new AuthError(
            "invalid_credential_path",
            candidate,
            "credential path must be outside the target project and Git metadata",
          );
      }
    }
  }
}

function storeError(filePath: string, message: string, cause?: unknown): AuthError {
  return new AuthError("credential_store", filePath, `${message}: ${filePath}`, { cause });
}

function assertNotAborted(options?: AuthOperationOptions): void {
  if (options?.signal?.aborted)
    throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
}

function validateProviderId(providerId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) {
    throw new AuthError(
      "credential_store",
      providerId,
      `invalid credential provider id "${providerId}"`,
    );
  }
}

function validateCredential(value: unknown): Credential {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("credential must be an object");
  const record = value as Record<string, unknown>;
  if (record.type === "oauth") {
    if (
      typeof record.access !== "string" ||
      typeof record.refresh !== "string" ||
      typeof record.expires !== "number" ||
      !Number.isFinite(record.expires)
    ) {
      throw new Error("oauth credential has an invalid shape");
    }
    return {
      ...record,
      type: "oauth",
      access: record.access,
      refresh: record.refresh,
      expires: record.expires,
    };
  }
  if (record.type === "api_key") {
    if (record.key !== undefined && typeof record.key !== "string")
      throw new Error("api-key credential has an invalid key");
    if (
      record.env !== undefined &&
      (typeof record.env !== "object" ||
        record.env === null ||
        Array.isArray(record.env) ||
        Object.values(record.env).some((entry) => typeof entry !== "string"))
    ) {
      throw new Error("api-key credential has invalid environment data");
    }
    return {
      type: "api_key",
      ...(record.key !== undefined && { key: record.key }),
      ...(record.env !== undefined && { env: record.env as Record<string, string> }),
    };
  }
  throw new Error("credential has an unsupported type");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function descriptorPath(handle: fs.promises.FileHandle, name?: string): string {
  const descriptorRoot = fs.existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
  const root = path.join(descriptorRoot, String(handle.fd));
  return name === undefined ? root : path.join(root, name);
}

async function openCredentialDirectory(filePath: string): Promise<fs.promises.FileHandle> {
  const directory = path.dirname(filePath);
  const parts = path
    .relative(path.parse(directory).root, directory)
    .split(path.sep)
    .filter(Boolean);
  let current = await fs.promises.open(
    path.parse(directory).root,
    fs.constants.O_RDONLY | DIRECTORY,
  );
  try {
    for (const part of parts) {
      const childPath = descriptorPath(current, part);
      let created = false;
      try {
        await fs.promises.mkdir(childPath, { mode: DIRECTORY_MODE });
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const child = await fs.promises.open(childPath, fs.constants.O_RDONLY | DIRECTORY | NOFOLLOW);
      const stat = await child.stat();
      if (!stat.isDirectory()) {
        await child.close();
        throw storeError(
          path.join(path.parse(directory).root, ...parts),
          "unsafe credential directory",
        );
      }
      await current.close();
      current = child;
      if (created && stat.uid !== process.getuid?.())
        throw storeError(directory, "credential directory has an unexpected owner");
    }
    const stat = await current.stat();
    if (stat.uid !== process.getuid?.())
      throw storeError(directory, "credential directory has an unexpected owner");
    if ((stat.mode & 0o022) !== 0)
      throw storeError(directory, "credential directory is writable by another user");
    if ((stat.mode & 0o077) !== 0) await current.chmod(DIRECTORY_MODE);
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error instanceof AuthError
      ? error
      : storeError(directory, "could not securely open credential directory", error);
  }
}

async function unlinkIfSame(
  directory: fs.promises.FileHandle,
  name: string,
  expected: fs.Stats,
): Promise<void> {
  const artifact = descriptorPath(directory, name);
  try {
    const current = await fs.promises.lstat(artifact);
    if (current.dev !== expected.dev || current.ino !== expected.ino)
      throw storeError(artifact, "credential artifact changed during operation");
    await fs.promises.unlink(artifact);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  private readonly lockWaitMs: number;
  private readonly staleLockMs: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileCredentialStoreOptions = {}) {
    const selected = options.path ?? defaultCredentialPath();
    if (!path.isAbsolute(selected))
      throw new AuthError("invalid_credential_path", selected, "credential path must be absolute");
    this.path = path.resolve(selected);
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
    this.staleLockMs = options.staleLockMs ?? STALE_LOCK_MS;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    validateProviderId(providerId);
    assertNotAborted(options);
    return (await this.readAll())[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    assertNotAborted(options);
    const entries = await this.readAll();
    return Object.entries(entries).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    validateProviderId(providerId);
    return this.serial(async () =>
      this.withLock(async (directory) => {
        assertNotAborted(options);
        const all = await this.readAll(directory);
        const next = await fn(all[providerId]);
        assertNotAborted(options);
        if (next === undefined) return all[providerId];
        all[providerId] = validateCredential(next);
        await this.publish(all, directory);
        return all[providerId];
      }, options),
    );
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    validateProviderId(providerId);
    await this.serial(async () =>
      this.withLock(async (directory) => {
        const all = await this.readAll(directory);
        if (!(providerId in all)) return;
        delete all[providerId];
        await this.publish(all, directory);
      }, options),
    );
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readAll(openedDirectory?: fs.promises.FileHandle): Promise<CredentialFile> {
    const directory = openedDirectory ?? (await openCredentialDirectory(this.path));
    try {
      const handle = await fs.promises.open(
        descriptorPath(directory, path.basename(this.path)),
        fs.constants.O_RDONLY | NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
          throw storeError(this.path, "unsafe credential file");
        if ((stat.mode & 0o077) !== 0)
          throw storeError(this.path, "credential file permissions are not private");
        const raw = await handle.readFile("utf8");
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
          throw new Error("root must be an object");
        const result: CredentialFile = {};
        for (const [providerId, credential] of Object.entries(parsed)) {
          validateProviderId(providerId);
          result[providerId] = validateCredential(credential);
        }
        return result;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (error instanceof AuthError) throw error;
      throw storeError(this.path, "could not read credential store", error);
    } finally {
      if (openedDirectory === undefined) await directory.close();
    }
  }

  private async publish(
    value: CredentialFile,
    openedDirectory?: fs.promises.FileHandle,
  ): Promise<void> {
    const directory = openedDirectory ?? (await openCredentialDirectory(this.path));
    const destinationPath = descriptorPath(directory, path.basename(this.path));
    try {
      const destination = await fs.promises.lstat(destinationPath);
      if (
        destination.isSymbolicLink() ||
        !destination.isFile() ||
        destination.nlink !== 1 ||
        destination.uid !== process.getuid?.()
      ) {
        throw storeError(this.path, "unsafe credential file");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporaryName = `.${path.basename(this.path)}.${crypto.randomUUID()}.tmp`;
    const temporary = descriptorPath(directory, temporaryName);
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
        FILE_MODE,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
        throw storeError(temporary, "unsafe temporary credential file");
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(temporary, destinationPath);
      await fs.promises.chmod(destinationPath, FILE_MODE);
      await directory.sync();
    } catch (error) {
      throw error instanceof AuthError
        ? error
        : storeError(this.path, "could not publish credential store", error);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.promises.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (openedDirectory === undefined) await directory.close();
    }
  }

  private async withLock<T>(
    operation: (directory: fs.promises.FileHandle) => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    const directory = await openCredentialDirectory(this.path);
    const lockName = `${path.basename(this.path)}.lock`;
    const lockPath = descriptorPath(directory, lockName);
    const started = Date.now();
    try {
      while (true) {
        assertNotAborted(options);
        try {
          const lock = await fs.promises.open(
            lockPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
            FILE_MODE,
          );
          const stat = await lock.stat();
          try {
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
              throw storeError(lockPath, "unsafe credential lock");
            await lock.writeFile(
              `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`,
            );
            await lock.sync();
            return await operation(directory);
          } finally {
            await lock.close();
            await unlinkIfSame(directory, lockName, stat);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error instanceof AuthError
              ? error
              : storeError(lockPath, "could not securely acquire credential lock", error);
          }
          if (await this.removeAbandonedLock(directory, lockName)) continue;
          if (Date.now() - started >= this.lockWaitMs)
            throw storeError(lockPath, "timed out waiting for credential lock");
          await sleep(50, options?.signal);
        }
      }
    } finally {
      await directory.close();
    }
  }

  private async removeAbandonedLock(
    directory: fs.promises.FileHandle,
    lockName: string,
  ): Promise<boolean> {
    const lockPath = descriptorPath(directory, lockName);
    try {
      const handle = await fs.promises.open(lockPath, fs.constants.O_RDONLY | NOFOLLOW);
      let stat: fs.Stats;
      try {
        stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.())
          throw storeError(lockPath, "unsafe credential lock");
        if (Date.now() - stat.mtimeMs < this.staleLockMs) return false;
        const metadata = JSON.parse(await handle.readFile("utf8")) as { pid?: unknown };
        if (typeof metadata.pid !== "number" || metadata.pid <= 0) return false;
        try {
          process.kill(metadata.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
        }
      } finally {
        await handle.close();
      }
      await unlinkIfSame(directory, lockName, stat);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error instanceof AuthError
        ? error
        : storeError(lockPath, "could not securely inspect credential lock", error);
    }
  }
}
