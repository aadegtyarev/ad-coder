import { DAY, type Entry } from "./entry";

/** What `retention status` shows the operator before a sweep runs. */
export function previewExpired(entries: Entry[], now: number, maxAgeDays: number): string[] {
  const cutoff = now - maxAgeDays * DAY;
  return entries.filter((entry) => entry.writtenAt < cutoff).map((entry) => entry.id);
}
