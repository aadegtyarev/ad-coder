# Sharing and revocation contract

- A revoked share must stop being servable by every route in this service from
  the instant `revokeShare` returns. There is no grace period.
- The share token is high-entropy and unguessable (`TOKEN_PATTERN` in
  `router.ts`, 16-64 lowercase alphanumerics). Routes may treat possession of a
  valid token as sufficient authorization to read the share's metadata or
  download the file it names -- this is the intended model, not a missing
  check, and the existing `GET /shares/:token` route already works this way.
- A token is validated against a strict character class before it reaches any
  lookup. A validated token is not raw input reaching a filesystem path or a
  query.
- The read-through cache in `src/cache.ts` is populated only from a validated
  canonical-store read performed inside this service (`store.getShare`
  followed by `cache.put`). No external input reaches a cache key or a cache
  value directly; a caller cannot write, or overwrite, a cache entry.
- `x-owner-id` is set by the gateway in front of this service after it
  authenticates the caller, and the gateway strips that header from any
  request that did not come through it. Routes may trust the header's value as
  the caller's identity; this is the existing identity mechanism, not a gap.
