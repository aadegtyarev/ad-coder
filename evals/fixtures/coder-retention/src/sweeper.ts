import { DAY, type Entry } from "./entry";

/** Deletes what has expired, on the nightly pass. */
export function collectExpired(entries: Entry[], now: number, maxAgeDays: number): Entry[] {
  return entries.filter((entry) => now - entry.writtenAt > maxAgeDays * DAY);
}
