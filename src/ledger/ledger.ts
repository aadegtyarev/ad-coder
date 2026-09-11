import * as fs from "node:fs";
import * as path from "node:path";
import type { HookInvocation, Hooks, SettledAssistantMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { LedgerRecord } from "./types";
import { toolCallCounts, usageAmounts } from "./usage";

/** Ledger files live here and nowhere else; an explicit filePath is confined to it. */
export const LEDGER_BASE_DIR = ".ad-coder/ledger";

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HOOK_ID = "ad-coder/ledger";

/** Where a ledger record goes. Synchronous: one record, one write, no interleaving. */
export interface LedgerSink {
  write(record: LedgerRecord): void;
  close?(): void;
}

/** In-memory sink for tests and for callers that want the records without a file. */
export class MemoryLedgerSink implements LedgerSink {
  private readonly written: LedgerRecord[] = [];

  write(record: LedgerRecord): void {
    this.written.push(record);
  }

  records(): readonly LedgerRecord[] {
    return this.written;
  }
}

/**
 * Append-only JSONL sink over one file descriptor held for the run.
 *
 * Permissions are enforced on the descriptor, not requested from the open:
 * `mkdir`'s mode is masked by the umask and ignored for an existing directory,
 * and a create-time file mode says nothing about a path that already exists.
 */
export class FileLedgerSink implements LedgerSink {
  private readonly filePath: string;
  private readonly dirPath: string;
  private fd: number | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.dirPath = path.dirname(filePath);
  }

  write(record: LedgerRecord): void {
    // One JSON.stringify of the whole record, never a hand-built line: a value
    // holding a newline would otherwise forge extra ledger entries.
    fs.writeSync(this.open(), `${JSON.stringify(record)}\n`);
  }

  close(): void {
    if (this.fd === undefined) return;
    fs.closeSync(this.fd);
    this.fd = undefined;
  }

  private open(): number {
    if (this.fd !== undefined) return this.fd;

    fs.mkdirSync(this.dirPath, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dirPath, 0o700);

    const fd = fs.openSync(
      this.filePath,
      // O_NOFOLLOW refuses a symlink at the final path component.
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (stat.nlink !== 1) {
        throw new Error(`ledger file ${this.filePath} has ${stat.nlink} links; refusing to write`);
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error(
          `ledger file ${this.filePath} is readable or writable beyond its owner; refusing to write`,
        );
      }
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    this.fd = fd;
    return fd;
  }
}

export interface LedgerOptions {
  runId: string;
  role: string;
  step: string;
  /** Must resolve inside LEDGER_BASE_DIR. Defaults to `<base>/<runId>.jsonl`. */
  filePath?: string;
  /** Replaces the file sink entirely; nothing touches disk when supplied. */
  sink?: LedgerSink;
}

/**
 * Attributes provider `Usage` to a role, step and run, one JSONL record per
 * turn. It observes: the hook handler never rewrites the message.
 */
export class Ledger {
  readonly runId: string;
  readonly role: string;
  readonly step: string;
  readonly filePath: string | undefined;

  private readonly sink: LedgerSink;
  private drops = 0;

  constructor(options: LedgerOptions) {
    if (!RUN_ID_PATTERN.test(options.runId)) {
      throw new Error(
        `Ledger: runId must match ${String(RUN_ID_PATTERN)} (it is used as a file name)`,
      );
    }
    this.runId = options.runId;
    this.role = options.role;
    this.step = options.step;

    if (options.sink !== undefined) {
      if (options.filePath !== undefined) {
        throw new Error("Ledger: pass either sink or filePath, not both");
      }
      this.sink = options.sink;
      this.filePath = undefined;
    } else {
      this.filePath = resolveLedgerPath(
        options.filePath ?? path.join(LEDGER_BASE_DIR, `${options.runId}.jsonl`),
      );
      this.sink = new FileLedgerSink(this.filePath);
    }
  }

  /** Records lost to write failures. Non-zero means the audit trail has holes. */
  get droppedRecords(): number {
    return this.drops;
  }

  /**
   * Register the after_response observer. The returned function is the
   * unsubscribe handle `hooks.on` hands back.
   */
  attach(hooks: Hooks): () => void {
    return hooks.on("after_response", (event) => this.record(event), { id: HOOK_ID });
  }

  close(): void {
    this.sink.close?.();
  }

  /**
   * The one seam for the cumulative-versus-per-response question. This reading
   * is already PER-RESPONSE and must not be diffed: pi-agent-core 0.85.1 ADDS
   * each row's usage into the session totals
   * (`harness/session/in-memory-storage-state.js:67`) and the row is this same
   * settled message's usage (`harness/runtime/drive/response.js:246`,
   * `harness/execution/assistant.js:50`). See ./usage's file block for the
   * full argument and for the event that is cumulative.
   */
  perResponseUsageFrom(message: SettledAssistantMessage): Usage {
    return message.usage;
  }

  private record(event: HookInvocation<"after_response">): undefined {
    try {
      // Same settled message that supplies usage -- the tool-call counts share
      // its per-response granularity. Omitted via the house conditional-spread
      // idiom when the response requested no tools, so a text-only turn carries
      // no empty `toolCalls: {}`.
      const counts = toolCallCounts(event.message);
      const record: LedgerRecord = {
        ts: Date.now(),
        runId: event.runId,
        lane: event.lane,
        role: this.role,
        step: this.step,
        provider: event.message.provider,
        model: event.message.model,
        stopReason: event.message.stopReason,
        ...(event.status !== undefined && { status: event.status }),
        usage: usageAmounts(this.perResponseUsageFrom(event.message)),
        ...(Object.keys(counts).length > 0 && { toolCalls: counts }),
      };
      this.sink.write(record);
    } catch (error) {
      // The harness catches and discards whatever an after_response handler
      // throws, so a failed write would otherwise vanish and the run would
      // report success over an incomplete ledger. A dropped record simply
      // loses that turn's numbers -- nothing carries them forward -- and
      // droppedRecords is what says so.
      this.drops += 1;
      if (this.drops === 1) {
        process.stderr.write(
          `ad-coder: ledger write failed, records are being dropped: ${errorMessage(error)}\n`,
        );
      }
    }
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Confine a ledger path to LEDGER_BASE_DIR, symlinks and `..` included. */
function resolveLedgerPath(candidate: string): string {
  const base = path.resolve(LEDGER_BASE_DIR);
  const resolved = path.resolve(candidate);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Ledger: filePath must resolve inside ${base} (got ${resolved})`);
  }
  return resolved;
}
