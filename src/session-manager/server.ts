/**
 * The owner-private Unix-socket transport for the headless SessionManager
 * (issue #365 layer 2; docs/ROADMAP.md 2026-09-14). The transport implements
 * the manager's API — never its own policy — and its ONLY other job is the
 * socket trust boundary, every rule enforced here, not in a caller:
 *
 * 1. owner-private `0700` directory and umask-independent `0600` socket,
 *    both verified by `lstat` after the fact;
 * 2. a peer-uid check on every accepted connection refusing every
 *    foreign-uid peer, fail-closed when credentials are unavailable;
 * 3. driver identity DERIVED by the server from the verified peer — the
 *    `<kind>:<owner>` key is never a client-supplied request field;
 * 4. NO stale-socket reclaim: an existing socket path, a symlink, or any
 *    non-socket at the bind path is refused and `EADDRINUSE` is fatal and
 *    typed. There is no unlink-and-rebind path.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionManager } from "./manager";
import { readPeerCredentials } from "./peer-credentials";
import { type DriverKind, SessionManagerError, sessionManagerErrorMessage } from "./types";

/** The largest single accepted request frame (bytes). Oversized frames drop. */
export const MAX_FRAME_BYTES = 256 * 1024;

const LISTEN_BACKLOG = 16;

export const DEFAULT_SOCKET_NAME = "manager.sock";

/**
 * How the server reads the presenting peer's trusted uid. The default reader
 * asks the KERNEL for the accepted connection's peer credentials
 * (`./peer-credentials`: Linux `getsockopt(SO_PEERCRED)`, Darwin
 * `getpeereid`), so the uid is attributed to the process on the other end and
 * not to anything the client sends. The seam exists for tests and for a
 * platform whose lookup is absent. Fail-closed: a reader that cannot establish
 * credentials returns undefined and the connection is refused.
 */
export type PeerCredentialsReader = (socket: net.Socket) => { uid?: number } | undefined;

/** Default reader: the real per-connection kernel lookup. */
export const defaultPeerCredentialsReader: PeerCredentialsReader = (socket) =>
  readPeerCredentials(socket);

export interface SessionManagerServerOptions {
  /** Absolute directory the socket lives in; created `0700` when absent. */
  socketDir: string;
  /** Socket file name inside `socketDir`; single component, default `manager.sock`. */
  socketName?: string;
  manager: SessionManager;
  /**
   * The front kind this transport instance serves, declared at socket setup
   * and DERIVED into every driver key it attributes (never taken from a
   * request). One transport slice, one front per instance: the Telegram
   * driver slice reuses the same class by declaring `"telegram"` here.
   */
  frontKind?: DriverKind;
  peerCredentials?: PeerCredentialsReader;
  /**
   * The post-bind socket chmod, injectable for tests; defaults to the real
   * `fs.chmodSync`. The directory chmod stays the server's own real action.
   */
  chmodSocket?: (socketPath: string, mode: number) => void;
}

/** The server DERIVES the driver key from the verified peer — nothing else may. */
export function deriveDriverKey(kind: "console" | "telegram", peerUid: number): string {
  return `${kind}:u${peerUid}`;
}

function bindPath(socketDir: string, socketName: string): string {
  if (!path.isAbsolute(socketDir))
    throw new SessionManagerError(
      "invalid_config",
      false,
      "the socket directory must be an absolute path",
      "point socket-dir at an absolute owner-private directory",
    );
  if (
    socketName.length === 0 ||
    socketName === "." ||
    socketName === ".." ||
    socketName.includes("/")
  )
    throw new SessionManagerError(
      "invalid_config",
      false,
      "the socket name must be a single path component",
      "use the default socket name",
    );
  return path.join(socketDir, socketName);
}

/**
 * Assert the bind path is UNUSED — no matter what occupies it, even a dead
 * server's socket: reclaiming would mean an unlink that races a live server,
 * and there is no unlink-and-rebind path here by contract.
 */
function assertBindPathUnused(bindPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(bindPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new SessionManagerError(
      "manager_unavailable",
      true,
      "the socket path could not be inspected",
      "check the socket directory is readable and writable by the owner",
      error,
    );
  }
  throw new SessionManagerError(
    "address_in_use",
    false,
    stat.isSymbolicLink()
      ? "a symlink occupies the socket path; the bind is refused, never reclaimed"
      : stat.isDirectory()
        ? "a directory occupies the socket path; the bind is refused"
        : "an entry already occupies the socket path; even a stale socket never reclaims it",
    "remove the dead socket path yourself or stop the server that owns it",
  );
}

/** Create-or-verify the socket directory as a REAL owner-private `0700` dir. */
function ensureSocketDirPrivate(socketDir: string): void {
  fs.mkdirSync(socketDir, { recursive: true });
  // Umask-independent: an explicit chmod after the fact, then VERIFIED.
  fs.chmodSync(socketDir, 0o700);
  const stat = fs.lstatSync(socketDir);
  // A symlinked socket directory would carry the socket outside the intended
  // private spot; a non-directory fails the private rules outright.
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new SessionManagerError(
      "manager_unavailable",
      false,
      "the socket path is not a real, owner-private directory",
      "create a plain socket directory owned by the operator",
    );
  if ((stat.mode & 0o777) !== 0o700)
    throw new SessionManagerError(
      "manager_unavailable",
      false,
      "the socket directory could not be made owner-private",
      "chmod the socket directory to 0700 or choose another location",
    );
}

/** Post-bind verification: the socket itSELF must be a plain socket at `0600`. */
export function verifyBoundSocket(socketPath: string): void {
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket())
    throw new SessionManagerError(
      "manager_unavailable",
      false,
      "the bound path is not a socket",
      "remove the intruding entry at the socket path and restart",
    );
  if ((stat.mode & 0o777) !== 0o600)
    throw new SessionManagerError(
      "manager_unavailable",
      false,
      "the bound socket is not owner-private (0600)",
      "chmod the socket to 0600 and restart the server",
    );
}

/**
 * The one-line JSON response envelope (errors:safe-projection): a stable
 * `code`, concise safe text, `retryable`, and a next action. Error text names
 * keys and field paths, never a resolved path or a secret.
 */
interface JsonResponse {
  ok: boolean;
  error?: { code: string; message: string; retryable: boolean; nextAction?: string };
  result?: unknown;
}

const SESSION_METHODS = [
  "list",
  "open",
  "bind",
  "unbind",
  "rename",
  "title",
  "handoff",
  "adopt",
] as const;
type SessionMethod = (typeof SESSION_METHODS)[number];

function isSessionMethod(value: string): value is SessionMethod {
  return (SESSION_METHODS as readonly string[]).includes(value);
}

/**
 * The transport's whole dispatch table: the manager's API and nothing added.
 * `driverKey` arrives DERIVED from the verified peer, never from the request.
 */
export async function dispatchRequest(
  manager: SessionManager,
  driverKey: string,
  request: Record<string, unknown>,
): Promise<unknown> {
  const { method } = request;
  const projectKey = typeof request.projectKey === "string" ? request.projectKey : undefined;
  if (typeof method !== "string" || !isSessionMethod(method))
    throw new SessionManagerError(
      "invalid_request",
      false,
      `a session-manager request must name one of: ${SESSION_METHODS.join(", ")}`,
      "use a listed request method",
    );
  switch (method) {
    case "list":
      return await manager.listSessions();
    case "open": {
      if (projectKey === undefined) throw requestFieldError("projectKey");
      return await manager.ensureSession(projectKey, driverKey);
    }
    case "bind": {
      if (projectKey === undefined) throw requestFieldError("projectKey");
      await manager.bindDriver(projectKey, driverKey);
      return { projectKey };
    }
    case "unbind": {
      manager.unbindDriver(driverKey, projectKey);
      return {};
    }
    case "rename": {
      if (projectKey === undefined) throw requestFieldError("projectKey");
      if (typeof request.name !== "string") throw requestFieldError("name");
      return await manager.renameSession(projectKey, request.name);
    }
    case "title": {
      if (projectKey === undefined) throw requestFieldError("projectKey");
      if (typeof request.firstUserMessage !== "string") throw requestFieldError("firstUserMessage");
      return await manager.generateAndApplyTitle(projectKey, request.firstUserMessage);
    }
    case "handoff": {
      if (projectKey === undefined) throw requestFieldError("projectKey");
      return await manager.proposeHandoff(projectKey);
    }
    case "adopt": {
      if (projectKey === undefined) throw requestFieldError("projectKey");
      return await manager.adoptAfterRelease(projectKey);
    }
  }
}

function requestFieldError(field: string): SessionManagerError {
  return new SessionManagerError(
    "invalid_request",
    false,
    `the request is missing the ${field} field`,
    `include ${field} in the request`,
  );
}

function typedResponse(error: unknown): JsonResponse {
  if (error instanceof SessionManagerError)
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.nextAction !== undefined ? { nextAction: error.nextAction } : {}),
      },
    };
  return {
    ok: false,
    error: {
      code: "manager_unavailable",
      message: sessionManagerErrorMessage(error),
      retryable: true,
    },
  };
}

/** Iterate confirmed connection attributions: never surfaced to the client. */
export interface AttributedConnection {
  driverKey: string;
  peerUid: number;
}

/**
 * The listening server. Constructing it with `listen()` runs the socket
 * trust-boundary checks in order so any non-private bind fatals typed before
 * the manager can be reached through it.
 */
export class SessionManagerServer {
  private readonly manager: SessionManager;
  private readonly socketDir: string;
  private readonly socketName: string;
  private readonly frontKind: DriverKind;
  private readonly peerCredentials: PeerCredentialsReader;
  private readonly chmodSocket: (socketPath: string, mode: number) => void;
  private server: net.Server | undefined;

  constructor(options: SessionManagerServerOptions) {
    this.manager = options.manager;
    this.socketDir = options.socketDir;
    this.socketName = options.socketName ?? DEFAULT_SOCKET_NAME;
    this.frontKind = options.frontKind ?? "console";
    this.peerCredentials = options.peerCredentials ?? defaultPeerCredentialsReader;
    this.chmodSocket =
      options.chmodSocket ?? ((socketPath, mode) => fs.chmodSync(socketPath, mode));
  }

  get socketPath(): string {
    return bindPath(this.socketDir, this.socketName);
  }

  /** Bind and start serving. Resolves once listening and verified. */
  async listen(): Promise<string> {
    const socketPath = this.socketPath;
    assertBindPathUnused(socketPath);
    ensureSocketDirPrivate(this.socketDir);
    return await new Promise<string>((resolve, reject) => {
      const server = net.createServer({ pauseOnConnect: true }, (socket) => {
        void this.serveConnection(socket);
      });
      server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE")
          reject(
            new SessionManagerError(
              "address_in_use",
              false,
              "another server already listens on that socket path; a live socket is never reclaimed",
              "stop the other server before starting this one",
              error,
            ),
          );
        else reject(error);
      });
      server.listen({ path: socketPath, backlog: LISTEN_BACKLOG }, () => {
        // Umask-independent: an explicit chmod BEFORE the verification, so the
        // verified inode is the one that serves.
        try {
          this.chmodSocket(socketPath, 0o600);
        } catch (error) {
          // A failed chmod closes the service AND leaves no occupied socket
          // path behind: every rejection path owns its own cleanup.
          server.close();
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // A vanished socket is not an extra failure.
          }
          reject(
            new SessionManagerError(
              "manager_unavailable",
              false,
              "the bound socket could not be made owner-private (0600)",
              "chmod the socket to 0600 and restart the server",
              error,
            ),
          );
          return;
        }
        try {
          verifyBoundSocket(socketPath);
        } catch (error) {
          // A failed post-bind verification closes the service AND leaves no
          // occupied socket path behind: the rejection path owns cleanup.
          server.close();
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // A vanished socket is not an extra failure.
          }
          reject(error);
          return;
        }
        this.server = server;
        resolve(socketPath);
      });
    });
  }

  /**
   * Serve ONE verified connection to completion. Total: every refusal and
   * protocol failure is answered at this boundary, so no rejection escapes
   * into the `connection` event emitter as an unhandled rejection.
   */
  async serveConnection(socket: net.Socket): Promise<void> {
    try {
      const attribution = this.attributedConnection(socket);
      await this.runProtocol(socket, attribution);
      socket.end();
    } catch (error) {
      await this.projectRefusal(socket, error);
    }
  }

  private attributedConnection(socket: net.Socket): AttributedConnection {
    const credentials = this.peerCredentials(socket);
    const uid = credentials?.uid;
    const ownerUid = process.getuid?.();
    // Fail-closed: unavailable credentials, an unavailable OWNER uid, or a
    // foreign uid all refuse; the containing 0600 socket is the intrusion
    // detection itself. uid equality is the grant, not privilege. Each refusal
    // names its OWN cause, so a missing lookup reads as a missing lookup rather
    // than as an intruder.
    if (typeof uid !== "number")
      throw new SessionManagerError(
        "not_authorized",
        false,
        "the connecting peer's credentials could not be established",
        "connect from this host, where the accepted socket carries the peer's uid",
      );
    if (ownerUid === undefined)
      throw new SessionManagerError(
        "not_authorized",
        false,
        "this server cannot establish its own uid, so no peer can be authorized",
        "run the session-manager server as a user with a uid on this host",
      );
    if (uid !== ownerUid)
      throw new SessionManagerError(
        "not_authorized",
        false,
        "the connecting process is not the owner of this session-manager instance",
        "connect as the same operating-system user the server runs as",
      );
    return { peerUid: uid, driverKey: deriveDriverKey(this.frontKind, uid) };
  }

  /**
   * Answer a refused connection with its typed envelope and a graceful FIN.
   * The refused peer's bytes are drained before the socket closes so the
   * close cannot become an RST that discards the response; this never throws.
   */
  private async projectRefusal(socket: net.Socket, error: unknown): Promise<void> {
    const envelope = `${JSON.stringify(typedResponse(error))}\n`;
    if (socket.writable) {
      try {
        await new Promise<void>((resolve) => {
          socket.end(envelope, "utf8", resolve);
        });
        return;
      } catch {
        // Fall through to the hard close below.
      }
    }
    socket.destroy();
  }

  private async runProtocol(socket: net.Socket, attribution: AttributedConnection): Promise<void> {
    // One request per line, frames capped per connection, until the peer ends.
    let buffer = "";
    for await (const chunk of socket) {
      buffer += (chunk as Buffer).toString("utf8");
      if (buffer.length > MAX_FRAME_BYTES)
        throw new SessionManagerError(
          "invalid_request",
          false,
          "a request exceeded the per-connection frame cap",
          "send smaller requests",
        );
      // serial dispatch: one line, one response, drained before the next.
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const response = await this.respond(line, attribution);
        if (!socket.write(`${JSON.stringify(response)}\n`))
          await new Promise<void>((resolve) => socket.once("drain", resolve));
      }
    }
  }

  private async respond(line: string, attribution: AttributedConnection): Promise<JsonResponse> {
    if (line.trim().length === 0)
      return {
        ok: false,
        error: {
          code: "invalid_request",
          message: "an empty request line is not a session-manager request",
          retryable: false,
        },
      };
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new SessionManagerError(
          "invalid_request",
          false,
          "a session-manager request must be a JSON object",
          "send a JSON object with a method field",
        );
      return {
        ok: true,
        result: await dispatchRequest(
          this.manager,
          attribution.driverKey,
          parsed as Record<string, unknown>,
        ),
      };
    } catch (error) {
      return typedResponse(error);
    }
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Refused even here — a vanished socket is not this server's cleanup debt.
    }
  }

  /** The concise safe projection of the running server for `--json` fronts. */
  info(): { socketPath: string; host: string; pid: number } {
    return { socketPath: this.socketPath, host: os.hostname(), pid: process.pid };
  }
}
