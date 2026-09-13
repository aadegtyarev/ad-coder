import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UserProfileError } from "./errors";
import { previewUserProfileImport, requireImportResult } from "./import";
import {
  encodeUserProfile,
  parseEconomicRecord,
  parseUserProfile,
  parseUserProfileJson,
} from "./schema";
import type {
  ImportMode,
  UserProfile,
  UserProfileImportPreview,
  UserProfileStoreOptions,
} from "./types";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export interface FileUserProfileStoreOptions extends UserProfileStoreOptions {
  path?: string;
}

export function defaultUserProfilePath(options: UserProfileStoreOptions): string {
  if (!path.isAbsolute(options.userHome))
    throw new UserProfileError("invalid_path", "userHome", "user profile home must be absolute");
  const configHome = options.xdgConfigHome;
  if (configHome !== undefined && !path.isAbsolute(configHome))
    throw new UserProfileError(
      "invalid_path",
      "xdgConfigHome",
      "user profile config home must be absolute",
    );
  return path.join(
    configHome ?? path.join(options.userHome, ".config"),
    "ad-coder",
    "profile.json",
  );
}

function storeError(cause?: unknown): UserProfileError {
  return new UserProfileError("io_error", "store", "could not access user profile store", {
    cause,
  });
}

function emptyProfile(): UserProfile {
  return {
    version: 1,
    inventories: [],
    calibratedRouting: [],
    economicRecords: [],
    subscriptionCapacityRanges: [],
  };
}

async function removeTemporary(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file);
  } catch (error) {
    // A failed atomic write may never create its temporary file; ENOENT is the expected cleanup case.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** A private, atomic user-level profile store. Its file is never an export target. */
export class FileUserProfileStore {
  readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FileUserProfileStoreOptions) {
    if (
      options.path !== undefined &&
      options.configPath !== undefined &&
      path.resolve(options.path) !== path.resolve(options.configPath)
    )
      throw new UserProfileError(
        "invalid_path",
        "configPath",
        "user profile path overrides must agree",
      );
    const selected = options.path ?? options.configPath ?? defaultUserProfilePath(options);
    if (!path.isAbsolute(selected))
      throw new UserProfileError("invalid_path", "profile", "user profile path must be absolute");
    this.path = path.resolve(selected);
  }

  async read(): Promise<UserProfile> {
    try {
      const directory = await fs.promises.lstat(path.dirname(this.path));
      if (directory.isSymbolicLink() || !directory.isDirectory() || (directory.mode & 0o077) !== 0)
        throw new UserProfileError("unsafe_file", "directory", "user profile directory is unsafe");

      const handle = await fs.promises.open(this.path, fs.constants.O_RDONLY | NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
          throw new UserProfileError("unsafe_file", "profile", "user profile file is unsafe");
        return parseUserProfileJson(await handle.readFile("utf8"));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyProfile();
      if (error instanceof UserProfileError) throw error;
      throw storeError(error);
    }
  }

  async write(value: unknown): Promise<UserProfile> {
    const profile = parseUserProfile(value);
    return this.serial(async () => {
      const current = await this.read();
      this.assertJournalPrefix(current, profile);
      if (encodeUserProfile(current) !== encodeUserProfile(profile)) await this.publish(profile);
      return profile;
    });
  }

  async appendEconomicRecord(value: unknown): Promise<UserProfile> {
    const record = parseEconomicRecord(value);
    return this.serial(async () => {
      const current = await this.read();
      if (current.economicRecords.some((entry) => entry.id === record.id))
        throw new UserProfileError("conflict", record.id, "economic record id already exists");
      const next = parseUserProfile({
        ...current,
        economicRecords: [...current.economicRecords, record],
      });
      await this.publish(next);
      return next;
    });
  }

  async previewImport(value: unknown, mode: ImportMode): Promise<UserProfileImportPreview> {
    return previewUserProfileImport(await this.read(), value, mode);
  }

  async import(value: unknown, mode: ImportMode): Promise<UserProfile> {
    return this.serial(async () => {
      const current = await this.read();
      const result = requireImportResult(previewUserProfileImport(current, value, mode));
      const validated = parseUserProfile(result);
      if (encodeUserProfile(current) !== encodeUserProfile(validated))
        await this.publish(validated);
      return validated;
    });
  }

  /** A failure-injection seam for subclasses; publication has not occurred when this runs. */
  protected async beforeCommit(): Promise<void> {}

  private assertJournalPrefix(current: UserProfile, next: UserProfile): void {
    if (
      current.economicRecords.length > next.economicRecords.length ||
      current.economicRecords.some(
        (record, index) => JSON.stringify(record) !== JSON.stringify(next.economicRecords[index]),
      )
    )
      throw new UserProfileError("conflict", "economicRecords", "economic history is append-only");
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async ensureDirectory(): Promise<void> {
    const directory = path.dirname(this.path);
    try {
      await fs.promises.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      const stat = await fs.promises.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022) !== 0)
        throw new UserProfileError("unsafe_file", "directory", "user profile directory is unsafe");
      if ((stat.mode & 0o077) !== 0) await fs.promises.chmod(directory, DIRECTORY_MODE);
    } catch (error) {
      if (error instanceof UserProfileError) throw error;
      throw storeError(error);
    }
  }

  private async publish(value: UserProfile): Promise<void> {
    await this.ensureDirectory();
    const encoded = encodeUserProfile(value);
    try {
      const destination = await fs.promises.lstat(this.path);
      if (destination.isSymbolicLink() || !destination.isFile() || destination.nlink !== 1)
        throw new UserProfileError("unsafe_file", "profile", "user profile file is unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof UserProfileError) throw error;
        throw storeError(error);
      }
    }
    const temporary = path.join(
      path.dirname(this.path),
      `.${path.basename(this.path)}.${crypto.randomUUID()}.tmp`,
    );
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
        FILE_MODE,
      );
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
      await handle.chmod(FILE_MODE);
      await handle.close();
      handle = undefined;
      await this.beforeCommit();
      await fs.promises.rename(temporary, this.path);
      const directoryHandle = await fs.promises.open(
        path.dirname(this.path),
        fs.constants.O_RDONLY,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (error instanceof UserProfileError) throw error;
      throw storeError(error);
    } finally {
      if (handle !== undefined) await handle.close();
      await removeTemporary(temporary);
    }
  }
}

/** Use the process home only when callers deliberately choose the default location. */
export function createDefaultUserProfileStore(): FileUserProfileStore {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  return new FileUserProfileStore({
    userHome: os.homedir(),
    ...(xdgConfigHome === undefined ? {} : { xdgConfigHome }),
  });
}
