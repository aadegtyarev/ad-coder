/**
 * Counters exposed to the operator dashboard. Nothing in `docs/contracts/`
 * governs this surface: no rule fixes the names, the reset semantics, or
 * whether a counter may be read concurrently with a write.
 */
const counters = new Map<string, number>();

export function increment(name: string): void {
  counters.set(name, (counters.get(name) ?? 0) + 1);
}

export function snapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}

export function reset(): void {
  counters.clear();
}
