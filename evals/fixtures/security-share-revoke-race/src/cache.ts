import type { ShareRecord } from "./store";

/**
 * A read-through cache kept only for the hot download path. It is a SECOND copy
 * of whatever `store.ts` said at the moment it was filled -- not a source of
 * truth, a stale mirror of one. `get` only re-checks the record's own age
 * against `CACHE_TTL_MS`; it never re-checks the canonical store, so a record
 * that changed there is invisible here until the TTL passes or something calls
 * `evict`.
 */
const cached = new Map<string, { record: ShareRecord; cachedAt: number }>();

/** How long a cached lookup answers without re-checking the canonical store. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

export function put(token: string, record: ShareRecord): void {
  cached.set(token, { record, cachedAt: Date.now() });
}

/** Undefined on a genuine miss or once an entry has aged past `CACHE_TTL_MS`. */
export function get(token: string): ShareRecord | undefined {
  const entry = cached.get(token);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cached.delete(token);
    return undefined;
  }
  return entry.record;
}

export function evict(token: string): void {
  cached.delete(token);
}
