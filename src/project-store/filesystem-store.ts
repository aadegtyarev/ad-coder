import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Context, err, FileError, ok, type Result } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/harness/env/nodejs";
import { ProjectStoreError } from "./types";

interface OrderedAppend {
  readonly content: string | Uint8Array;
  readonly lastSequence: number;
  readonly settle: (result: Result<void, FileError>) => void;
}

interface OrderedAppendState {
  nextSequence: number;
  readonly pending: Map<number, OrderedAppend>;
}

/** FileSystem adapter used by JsonlSessionRepo. It confines every mutation and fixes modes. */
export class ProjectStoreFileSystem extends NodeExecutionEnv {
  /**
   * pi-agent-core assigns transaction sequence numbers before its asynchronous
   * persistence callbacks reach the filesystem.  Two callbacks can therefore
   * arrive in the reverse order even though this process owns the session.
   * Keep each journal's committed prefix monotonic; an interrupted later
   * callback remains uncommitted instead of poisoning every future resume.
   */
  private readonly orderedAppends = new Map<string, OrderedAppendState>();

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
    const sequence = this.transactionSequence(content);
    if (sequence !== undefined) return await this.appendTransaction(resolved, content, sequence);
    return this.writeSecureFile(resolved, content, true);
  }

  /**
   * Restore a complete journal whose transactions were durably appended out of
   * sequence by an older runtime. Every record must parse as one contiguous
   * transaction before anything is rewritten, so this reorders bytes without
   * discarding an ambiguous or partial record.
   */
  repairOutOfOrderTransactions(candidate: string): boolean {
    const resolved = this.assertMutation(candidate);
    this.assertSafeExistingFile(resolved, true);
    const lines = new TextDecoder().decode(this.readSafeFile(resolved)).trimEnd().split("\n");
    const header = lines.shift();
    if (header === undefined) return false;
    const transactions = lines.map((line) => ({ line, sequence: this.transactionSequence(line) }));
    const complete = transactions.filter(
      (transaction): transaction is { line: string; sequence: { first: number; last: number } } =>
        transaction.sequence !== undefined,
    );
    if (complete.length !== transactions.length) return false;
    const ordered = [...complete].sort((left, right) => left.sequence.first - right.sequence.first);
    if (ordered.every(({ line }, index) => line === transactions[index]?.line)) return false;
    let expected = ordered[0]?.sequence?.first;
    if (expected === undefined) return false;
    for (const { sequence } of ordered) {
      if (sequence?.first !== expected) return false;
      expected = sequence.last + 1;
    }
    const result = this.writeSecureFile(
      resolved,
      `${header}\n${ordered.map(({ line }) => line).join("\n")}\n`,
      false,
    );
    if (!result.ok) throw result.error;
    this.orderedAppends.set(resolved, { nextSequence: expected, pending: new Map() });
    return true;
  }

  /**
   * Move (never rewrite) a journal with overlapping committed transactions to
   * the private recovery area.  An overlap is not an ordering fault: choosing
   * either record would silently discard durable state.  The caller can then
   * create an explicitly operator-authorised fresh continuation while the
   * exact original bytes remain available for inspection and bug reporting.
   *
   * Returns undefined unless every post-header line is a complete transaction
   * and at least two transactions overlap.  In particular, partial/corrupt
   * journals are deliberately left where they are.
   */
  quarantineOverlappingTransactions(candidate: string): string | undefined {
    const resolved = this.assertMutation(candidate);
    this.assertSafeExistingFile(resolved, true);
    if (!this.hasOverlappingTransactions(resolved)) return undefined;
    const recoveryDirectory = path.join(this.storeRoot, "scratch", "recovery");
    this.assertMutation(recoveryDirectory);
    fs.mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(recoveryDirectory, 0o700);
    this.assertSafeDirectory(recoveryDirectory);
    const archived = path.join(
      recoveryDirectory,
      `${path.basename(resolved)}.${crypto.randomUUID()}.ambiguous.jsonl`,
    );
    // A rename is atomic on this store.  We do not copy then delete: after a
    // crash there is always one intact original, never a half-written repair.
    fs.renameSync(resolved, archived);
    fs.chmodSync(archived, 0o600);
    return archived;
  }

  hasOverlappingTransactions(candidate: string): boolean {
    const resolved = this.assertMutation(candidate);
    this.assertSafeExistingFile(resolved, true);
    const lines = new TextDecoder().decode(this.readSafeFile(resolved)).trimEnd().split("\n");
    const header = lines.shift();
    if (header === undefined) return false;
    const transactions = lines.map((line) => this.transactionSequence(line));
    if (transactions.some((transaction) => transaction === undefined)) return false;
    const ordered = (transactions as Array<{ first: number; last: number }>).sort(
      (left, right) => left.first - right.first,
    );
    return ordered.some((transaction, index) => {
      const previous = ordered[index - 1];
      return previous !== undefined && transaction.first <= previous.last;
    });
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

  private transactionSequence(
    content: string | Uint8Array,
  ): { first: number; last: number } | undefined {
    try {
      const parsed = JSON.parse(
        typeof content === "string" ? content : new TextDecoder().decode(content),
      );
      const writes = Array.isArray(parsed) ? parsed : [parsed];
      if (writes.length === 0) return undefined;
      const sequences = writes.map((write) =>
        typeof write === "object" && write !== null ? (write as { seq?: unknown }).seq : undefined,
      );
      if (
        !sequences.every((sequence) => Number.isSafeInteger(sequence) && (sequence as number) >= 0)
      )
        return undefined;
      const first = sequences[0] as number;
      const last = sequences.at(-1) as number;
      if (!sequences.every((sequence, index) => sequence === first + index)) return undefined;
      return { first, last };
    } catch {
      return undefined;
    }
  }

  private async appendTransaction(
    candidate: string,
    content: string | Uint8Array,
    sequence: { first: number; last: number },
  ): Promise<Result<void, FileError>> {
    const state = this.orderedAppends.get(candidate) ?? {
      nextSequence: (this.lastCommittedSequence(candidate) ?? 0) + 1,
      pending: new Map<number, OrderedAppend>(),
    };
    this.orderedAppends.set(candidate, state);
    if (sequence.first < state.nextSequence)
      return err(
        new FileError(
          "unknown",
          `session journal transaction sequence ${sequence.first} was already committed`,
          candidate,
        ),
      );
    if (state.pending.has(sequence.first))
      return err(
        new FileError(
          "unknown",
          `session journal transaction sequence ${sequence.first} is already pending`,
          candidate,
        ),
      );
    return await new Promise<Result<void, FileError>>((settle) => {
      state.pending.set(sequence.first, { content, lastSequence: sequence.last, settle });
      this.flushTransactions(candidate, state);
    });
  }

  private flushTransactions(candidate: string, state: OrderedAppendState): void {
    for (;;) {
      const pending = state.pending.get(state.nextSequence);
      if (pending === undefined) return;
      state.pending.delete(state.nextSequence);
      const result = this.writeSecureFile(candidate, pending.content, true);
      if (!result.ok) {
        pending.settle(result);
        return;
      }
      state.nextSequence = pending.lastSequence + 1;
      pending.settle(result);
    }
  }

  private lastCommittedSequence(candidate: string): number | undefined {
    try {
      const lines = new TextDecoder().decode(this.readSafeFile(candidate)).trimEnd().split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (line === undefined || line.length === 0) continue;
        const sequence = this.transactionSequence(line);
        if (sequence !== undefined) return sequence.last;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return undefined;
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
