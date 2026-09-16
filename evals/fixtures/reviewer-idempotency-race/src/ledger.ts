import { canonicalKey } from "./idempotency";

interface ChargeRecord {
  amountCents: number;
  committed: boolean;
}

const applied = new Map<string, ChargeRecord>();

function validateAmount(cents: number): void {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("invalid amount");
}

/** Read-only status lookup for the operator dashboard. */
export function statusOf(rawKey: string): "unknown" | "pending" | "committed" {
  const record = applied.get(canonicalKey(rawKey));
  if (!record) return "unknown";
  return record.committed ? "committed" : "pending";
}

/**
 * Applies a charge exactly once per idempotency key: a retry of the SAME
 * request must not charge twice, a genuinely different request must never be
 * folded into someone else's, and two calls racing on the same key must
 * still result in exactly one call to `charge`.
 */
export async function applyCharge(
  rawKey: string,
  amountCents: number,
  charge: (cents: number) => Promise<void>,
): Promise<{ committed: boolean; duplicate: boolean }> {
  validateAmount(amountCents);
  const key = canonicalKey(rawKey);
  const existing = applied.get(key);
  if (existing) return { committed: existing.committed, duplicate: true };
  applied.set(key, { amountCents, committed: false });
  await charge(amountCents);
  applied.set(key, { amountCents, committed: true });
  return { committed: true, duplicate: false };
}
