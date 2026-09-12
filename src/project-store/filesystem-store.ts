import * as fs from "node:fs";
import * as path from "node:path";
import { type Context, err, FileError, ok, type Result } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import { ProjectStoreError } from "./types";

/** FileSystem adapter used by JsonlSessionRepo. It confines every mutation and fixes modes. */
export class ProjectStoreFileSystem extends NodeExecutionEnv {
  constructor(
    readonly storeRoot: string,
    private readonly jsonlRecordLimit = 0,
  ) {
    super({ cwd: storeRoot });
  }

  private assertMutation(candidate: string): string {
    const resolved = path.resolve(this.cwd, candidate);
    if (resolved !== this.storeRoot && !resolved.startsWith(`${this.storeRoot}${path.sep}`)) {
      throw new ProjectStoreError(
        "unsafe_path",
        resolved,
        "runtime path escapes the project store",
      );
    }
    let cursor = this.storeRoot;
    for (const component of path.relative(this.storeRoot, resolved).split(path.sep).slice(0, -1)) {
      if (!component) continue;
      cursor = path.join(cursor, component);
      try {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new ProjectStoreError(
            "unsafe_path",
            cursor,
            "runtime path has an unsafe component",
          );
        }
      } catch (error) {
        if (error instanceof ProjectStoreError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return resolved;
  }

  override async createDir(
    candidate: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ) {
    const resolved = this.assertMutation(candidate);
    const result = await super.createDir(resolved, options, context);
    if (result.ok) fs.chmodSync(resolved, 0o700);
    return result;
  }

  override async writeFile(candidate: string, content: string | Uint8Array, _context: Context) {
    const resolved = this.assertMutation(candidate);
    this.assertSafeExistingFile(resolved);
    this.assertJsonlRecords(content, resolved);
    return this.writeSecureFile(resolved, content, false);
  }

  override async appendFile(candidate: string, content: string | Uint8Array, _context: Context) {
    const resolved = this.assertMutation(candidate);
    this.assertSafeExistingFile(resolved);
    this.assertJsonlRecords(content, resolved);
    return this.writeSecureFile(resolved, content, true);
  }

  override async renameFile(source: string, destination: string, context: Context) {
    const sourcePath = this.assertMutation(source);
    const destinationPath = this.assertMutation(destination);
    this.assertSafeExistingFile(sourcePath);
    this.assertSafeExistingFile(destinationPath);
    const result = await super.renameFile(sourcePath, destinationPath, context);
    if (result.ok) this.secureFile(destinationPath);
    return result;
  }

  override async remove(
    candidate: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ) {
    return super.remove(this.assertMutation(candidate), options, context);
  }

  override async readTextFile(
    candidate: string,
    _context: Context,
  ): Promise<Result<string, FileError>> {
    const resolved = this.assertMutation(candidate);
    try {
      const bytes = this.readSafeFile(resolved);
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      this.assertJsonlRecords(value, resolved);
      return ok(value);
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      return err(this.fileError(error, resolved));
    }
  }

  override async readTextLines(
    candidate: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const result = await this.readTextFile(candidate, context);
    if (!result.ok) return result;
    const lines = result.value.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  override async readBinaryFile(
    candidate: string,
    _context: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    const resolved = this.assertMutation(candidate);
    try {
      return ok(this.readSafeFile(resolved));
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      return err(this.fileError(error, resolved));
    }
  }

  override async fileInfo(candidate: string, context: Context) {
    const resolved = this.assertMutation(candidate);
    this.assertSafeExistingObject(resolved, false);
    return super.fileInfo(resolved, context);
  }

  override async listDir(candidate: string, context: Context) {
    const resolved = this.assertMutation(candidate);
    this.assertSafeDirectory(resolved);
    const result = await super.listDir(resolved, context);
    if (result.ok) {
      for (const entry of result.value) this.assertSafeExistingObject(entry.path);
    }
    return result;
  }

  override async canonicalPath(candidate: string, context: Context) {
    const resolved = this.assertMutation(candidate);
    this.assertSafeExistingObject(resolved);
    return super.canonicalPath(resolved, context);
  }

  override async exists(candidate: string, context: Context) {
    const resolved = this.assertMutation(candidate);
    this.assertSafeExistingObject(resolved, false);
    return super.exists(resolved, context);
  }

  private assertSafeExistingFile(candidate: string, required = false): void {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw new ProjectStoreError(
          "unsafe_object",
          candidate,
          "runtime destination is not a private regular file",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || required) throw error;
    }
  }

  private assertSafeDirectory(candidate: string): void {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ProjectStoreError("unsafe_object", candidate, "runtime directory is unsafe");
    }
  }

  private assertSafeExistingObject(candidate: string, required = true): void {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink())
        throw new ProjectStoreError("unsafe_object", candidate, "runtime object is a symlink");
      if (stat.isFile() && stat.nlink !== 1)
        throw new ProjectStoreError("unsafe_object", candidate, "runtime file has multiple links");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || required) throw error;
    }
  }

  private assertJsonlRecords(content: string | Uint8Array, candidate: string): void {
    if (this.jsonlRecordLimit === 0) return;
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    for (const record of text.split("\n")) {
      if (record.length === 0) continue;
      if (Buffer.byteLength(record) + 1 > this.jsonlRecordLimit) {
        throw new ProjectStoreError(
          "resource_limit",
          candidate,
          "JSONL record exceeds configured byte limit",
        );
      }
    }
  }

  private readSafeFile(candidate: string): Uint8Array {
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new ProjectStoreError(
          "unsafe_object",
          candidate,
          "runtime source is not a private regular file",
        );
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private writeSecureFile(
    candidate: string,
    content: string | Uint8Array,
    append: boolean,
  ): Result<void, FileError> {
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        candidate,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_NOFOLLOW |
          (append ? fs.constants.O_APPEND : 0),
        0o600,
      );
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new ProjectStoreError(
          "unsafe_object",
          candidate,
          "runtime destination is not a private regular file",
        );
      fs.fchmodSync(fd, 0o600);
      if (!append) fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, content);
      return ok(undefined);
    } catch (error) {
      if (error instanceof ProjectStoreError) throw error;
      return err(this.fileError(error, candidate));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private fileError(error: unknown, candidate: string): FileError {
    const cause = error instanceof Error ? error : new Error(String(error));
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return new FileError("not_found", cause.message, candidate, cause);
    if (code === "EACCES" || code === "EPERM")
      return new FileError("permission_denied", cause.message, candidate, cause);
    return new FileError("unknown", cause.message, candidate, cause);
  }

  private secureFile(candidate: string): void {
    this.assertSafeExistingFile(candidate);
    fs.chmodSync(candidate, 0o600);
  }
}
