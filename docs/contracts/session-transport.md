# Session transport contract

This contract owns the local Unix-socket boundary for SessionManager fronts.

## Guarantees

- The service listens only on an owner-private Unix socket. Each accepted peer
  passes a platform peer-uid check against the service uid and the configured
  front kind; uid equality, not root privilege or client claims, is authority.
- The socket directory is `0700` and the socket is `0600`. The server verifies
  both modes after bind and closes rather than serving through an unsafe path.
- Bind is atomic. Existing socket-path errors are fatal; the manager never
  unlinks and rebinds a presumed stale socket. Any future recovery needs a live
  peer-verified ownership probe, never age or pid heuristics.
- Driver identity is derived server-side from verified peer identity and front
  kind. A client cannot supply it or rebind another driver's key.

## Verification

Test foreign uid, unsafe modes, existing socket, malformed client identity, and
same-user front access on every supported transport platform.

## Related surfaces

- [Session manager](session-manager.md) owns bindings and manager operations.
- [Extension modules](extension-modules.md) owns transport-module boundaries.
- [Security](security.md) owns the broader trust boundary.
