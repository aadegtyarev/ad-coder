/**
 * Canonicalises a caller-supplied idempotency key. Per
 * docs/contracts/idempotency.md: two keys that differ only by case or by
 * whitespace canonicalise to the same key. Two keys that differ by anything
 * else -- including punctuation -- must never collapse into the same key.
 */
export function canonicalKey(rawKey: string): string {
  return rawKey.trim().toLowerCase().replace(/\s+/g, " ");
}
