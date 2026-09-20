/**
 * The REAL peer-credential lookup behind the socket trust boundary
 * (docs/contracts/session-manager.md, "Unix-socket trust boundary": the peer-uid
 * check is the authorization, nothing else). The server cannot ask the client
 * who it is — it asks the KERNEL, on the accepted connection's own descriptor:
 *
 * - Linux: `getsockopt(fd, SOL_SOCKET, SO_PEERCRED)` fills a `struct ucred`
 *   {pid, uid, gid}; the kernel answers for an AF_UNIX peer.
 * - Darwin: `getpeereid(fd, &uid, &gid)`.
 *
 * JavaScript exposes no such call, so the lookup is a `bun:ffi` binding to
 * libc — the same mechanism `src/project-tools/read.ts` already uses for
 * `openat`. FAIL-CLOSED is the rule the contract states: a platform with no
 * lookup, a library that cannot be loaded, a descriptor the runtime does not
 * hand out, or a failing syscall all return `undefined`, and the server refuses
 * the connection. A missing credential is never a grant.
 */

import { dlopen, ptr } from "bun:ffi";
import type * as net from "node:net";

export interface PeerCredentials {
  /** The kernel-attributed uid of the process at the far end of the socket. */
  uid: number;
}

/** `getsockopt` level `SOL_SOCKET` (asm-generic/socket.h). */
const SOL_SOCKET = 1;
/** `SO_PEERCRED`, Linux only (asm-generic/socket.h). */
const SO_PEERCRED = 17;
/** `sizeof(struct ucred)`: three 32-bit fields — pid_t, uid_t, gid_t. */
const UCRED_BYTES = 12;
/** The uid slot inside that struct (0 = pid, 1 = uid, 2 = gid). */
const UCRED_UID_INDEX = 1;

type NativeLookup = (fd: number) => PeerCredentials | undefined;

function openLinuxLookup(): NativeLookup | undefined {
  try {
    const library = dlopen("libc.so.6", {
      getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
    });
    return (fd: number) => {
      const ucred = new Int32Array(UCRED_BYTES / 4);
      const length = new Int32Array([UCRED_BYTES]);
      const status = library.symbols.getsockopt(
        fd,
        SOL_SOCKET,
        SO_PEERCRED,
        ptr(ucred),
        ptr(length),
      );
      if (status !== 0 || length[0] !== UCRED_BYTES) return undefined;
      const uid = ucred[UCRED_UID_INDEX];
      return typeof uid === "number" ? { uid } : undefined;
    };
  } catch {
    // An unloadable libc is "no lookup", never a crash at import time.
    return undefined;
  }
}

function openDarwinLookup(): NativeLookup | undefined {
  try {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      getpeereid: { args: ["i32", "ptr", "ptr"], returns: "i32" },
    });
    return (fd: number) => {
      const uid = new Int32Array(1);
      const gid = new Int32Array(1);
      if (library.symbols.getpeereid(fd, ptr(uid), ptr(gid)) !== 0) return undefined;
      const value = uid[0];
      return typeof value === "number" ? { uid: value } : undefined;
    };
  } catch {
    return undefined;
  }
}

const nativeLookup: NativeLookup | undefined =
  process.platform === "linux"
    ? openLinuxLookup()
    : process.platform === "darwin"
      ? openDarwinLookup()
      : undefined;

/**
 * The descriptor of an ACCEPTED socket. The runtime hands out the live handle
 * on the connection object, and the handle carries the descriptor the syscall
 * needs; anything else (no handle, a non-numeric field, a negative value) is
 * reported as unavailable so the caller refuses rather than guesses.
 */
function acceptedSocketFd(socket: net.Socket): number | undefined {
  const handle = (socket as unknown as { _handle?: { fd?: unknown } })._handle;
  const fd = handle?.fd;
  return typeof fd === "number" && Number.isSafeInteger(fd) && fd >= 0 ? fd : undefined;
}

/**
 * The kernel's own answer for this connection, or `undefined` when there is no
 * lookup to make. The result is the peer's REAL uid: nothing in the request or
 * the client's environment can influence it.
 */
export function readPeerCredentials(socket: net.Socket): PeerCredentials | undefined {
  if (nativeLookup === undefined) return undefined;
  const fd = acceptedSocketFd(socket);
  if (fd === undefined) return undefined;
  return nativeLookup(fd);
}

/** Whether this build has a peer-credential lookup at all (diagnostics only). */
export function peerCredentialLookupAvailable(): boolean {
  return nativeLookup !== undefined;
}
