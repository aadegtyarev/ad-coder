# Session manager contract

This contract governs the headless `SessionManager` (issue #365 layer 2): a
small private local service over the existing `ProjectStore`, Orchestrator API,
background-run control plane, and durable event cursor. It is a library API
first (`docs/contracts/architecture.md`); the Unix-socket transport, console
discovery/attach, and the `standalone:<local>` handoff verbs are the next slice
and implement THIS document — the headless core ships no listener it has not
already been checked against.

## What it owns

- Safe durable bindings, stored secret-free OUTSIDE target projects:
  `driverKey -> projectKey`, plus one project record
  `projectKey -> (targetDir, shared sessionId, profile, displayName, nameSource)`.
  One shared durable Orchestrator conversation per project: Telegram, console,
  and later a group topic are views of that same conversation, not separate
  conversations.
- Stable session IDs for managed sessions, and the bounded untrusted title
  policy (below).
- Read-only standalone lease detection and the handoff record.
- Safe project creation beneath allow roots, including `git init` and the
  minimal ignored runtime scaffold.

## Project keys and allow roots

- A project key is a slug: `[A-Za-z0-9_-]{1,64}`, no leading `.`, and the
  reserved names `git` and `ad-coder` are refused. A key is ALWAYS one path
  component: absolute paths, `..`, `\`, empty segments and traversal variants
  are refused before any filesystem access.
- Configured allow roots are lexically validated at config parse (absolute,
  normalized, no `..` segment) and REALPATHED once at manager construction. All
  containment checks then run against the real paths: containment is
  segment-aware via `path.relative` (`relative(root, real) === key` for a
  project, never a string prefix test — `root=/home/u/proj` must not admit
  `/home/u/proj-x`).
- EVERY filesystem act on a project path — creation, binding resolution, store
  or transcript opening — re-derives the realpath immediately before use and
  re-checks segment-wise containment AFTER the syscall. A post-mkdir realpath
  that is not an immediate child of the configured allow root is a hard error
  that leaves no binding persisted (the symlink-swap TOCTOU refusal).

## Bindings durability and fail-closed reads

- Bindings live in owner state with a VERSIONED schema, written atomically,
  never inside a target project. Driver binding records attribute the front
  kind (`console` | `telegram`) so a rebind trace names the actor.
- Bindings are validated on read with the same validators used on write:
  project key shape and `targetDir` containment against the CURRENT allow
  roots. An invalid entry fails closed to `no binding` and is SURFACED as an
  error; it is never silently dropped into auto-creation, and a poisoned record
  never triggers project creation.

## Safe project creation

- Creation exists only in the programmatic core; a front never runs the
  commands behind it. Creation is idempotent in fail mode: an existing
  non-empty directory is rejected, never adopted. A concurrent double-create is
  serialized by the create itself (exclusive create) — exactly one winner.
- Creation volume is a configured non-negative-integer limit with a finite
  built-in default; a configured `0` disables creation.
- `git init` runs through argv without a shell. The directory argument is the
  post-creation absolute realpath of the validated project path.

## Standalone leases and handoff

- A legacy live standalone session is detected ONLY by reading its durable
  lease. Detection is strictly read-only: manager never clears, rewrites, or
  extends another owner's lease file.
- Manager never opens or steals a live standalone session. It appears as
  `standalone:<local>` in session lists. Handoff is two-sided: the standalone
  console accepts with `:handoff accept` after its active turn settles; a
  completed handoff is exactly a two-sided event pair in the handoff ledger.
  Manager adopts the same durable session ID only after the standalone side has
  released it.

## Stable IDs and the title policy

- A managed project's shared session ID is stable for the project's lifetime
  and derived from the project, not from time or a per-owner process.
- Every session has a display name and a name source (`generated` | `manual`).
  A new session starts as `New session`; after the first user message settles,
  an asynchronous title-only LLM call proposes a concise name. Title generation
  is the cheapest configured route and passes through the owned
  `ProviderAdmissionController` (lowest priority class `title`) — no front may
  bypass admission for it.
- Titles are UNTRUSTED model output and manual names are remote user input:
  both are length-capped in code points, stripped of ANSI escape sequences and
  control characters, secret-screened, and treated as opaque display strings.
  They are NEVER used as identifiers, slugs, or path components. A candidate
  that sanitizes to empty falls back to `New session`. A manual name is never
  replaced by a generated one.
- The strip removes only sequences whose END the standard defines (CSI up to its
  final byte, OSC to BEL or ST, DCS/PM/APC/SOS to ST, one byte for the other
  Fe/Fs/Fp escapes, and the 8-bit C1 spellings). A candidate that still carries
  an introducer byte afterwards is REFUSED rather than guessed at — where an
  unterminated sequence ends is not a decision the strip may make — and lands on
  the same neutral fallback as the empty case.
- What is removed may not hide anything from the screens: each of them also sees
  the draft with the removed surfaces DELETED rather than replaced by a space, so
  that a character taken out of a keyword cannot split it into two words and hide
  an assignment. That projection is screened and never persisted.

## Unix-socket trust boundary (implemented by the transport slice)

The service listens only on an owner-private Unix socket, solely so same-uid
fronts reach the programmatic core. These invariants are binding:

1. **Authorization is the peer-uid check, nothing else.** On each accepted
   connection the server verifies `SO_PEERCRED` (or the platform equivalent)
   against its own uid and the declared front kind. A mismatching-uid peer is
   rejected. A process running as uid 0 reaching the socket from outside the
   boundary is refused by the same check: uid equality is the grant, not
   privilege.
2. **Private placement, verified after create.** The socket lives in a `0700`
   directory and is itself `0600`. The umask being *requested* is not trust:
   after binding, the server STATS the directory and socket; if either mode is
   wrong the socket is closed and the service refuses to run, rather than
   serving through an open door.
3. **Bind is atomic; there is no unlink-and-rebind path.** `EADDRINUSE` /
   `EEXIST` from the listen is FATAL — the server exits with a typed error.
   Manager never unlinks a socket path to reclaim it. Stale-socket recovery, if
   it is ever added, requires a LIVE peer-uid-verified listener responding to
   an ownership probe; file age or pid files alone never justify unlinking, and
   a slow live manager must not be sniped by a second instance.
4. **Driver identity is server-derived.** The client never announces a
   driverKey. The server derives it from the verified peer identity plus the
   front kind declared at socket setup. A front may rebind only its own derived
   key; a client-supplied or client-declared driver identity is refused. Every
   binding write is attributed with the front kind in the durable record.

## Front capability parity

The manager's programmatic API (list / create / bind / resolve / rename /
handoff) is the single declaration both fronts translate. Console and Telegram
differ only in rendering; a front holding its own copy of manager state or
adding a front-only verb is a violation (`docs/contracts/cli.md`). CLI
subcommands for the manager stay thin: one command entry in the single command
registry, dispatch and help rendered from it.

## Failure projection

Failures are typed with a stable code, concise safe human text, and at least
one next action where recovery exists. Error text names keys and field paths,
never credential values, never raw provider bodies.
<!-- ad-coder:contract-67fbfb1e2fa98f9c686459c09ecf83dc -->
<!-- ad-coder:contract-192a9b4fe6408c893c3b848145438c8c -->
- The SessionManager transport slice (server.ts) is implemented and enforced:
  after bind it stats the socket and its directory - a socket not 0600 inside a
  0700 owner-private directory closes the service with a typed error; the
  peer-uid gate (SO_PEERCRED/getpeereid) refuses every foreign-uid peer;
  driver identity stays server-derived and a client-supplied driver identity is
  refused; EADDRINUSE/EEXIST at listen is fatal and never unlinks a socket path
  to reclaim it; a malformed or foreign lease renders the session a read-only
  standalone entry (gleaned), never adopted.
