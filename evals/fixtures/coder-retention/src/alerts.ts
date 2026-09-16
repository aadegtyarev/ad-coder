import { DAY, type Entry } from "./entry";

/**
 * Entries the operator is warned about a week before they go.
 *
 * Added last, by someone who copied the sweeper.
 */
export function expiringSoon(entries: Entry[], maxAgeDays: number): string[] {
  const now = Date.now();
  const cutoff = now - (maxAgeDays - 7) * DAY;
  return entries.filter((entry) => entry.writtenAt < cutoff).map((entry) => entry.id);
}
