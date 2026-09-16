import { DAY, type Entry } from "./entry";

/** How many entries the dashboard reports as expiring. */
export function countExpired(entries: Entry[], now: number, maxAgeDays: number): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.pinned) continue;
    const age = now - (entry.lastReadAt ?? entry.writtenAt);
    if (age > maxAgeDays * DAY) count += 1;
  }
  return count;
}
