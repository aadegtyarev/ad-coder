import { countExpired } from "../src/dashboard";
import { DAY, type Entry } from "../src/entry";

const NOW = 1000 * DAY;

/**
 * Agreed with the operators when the dashboard shipped, and the reason the
 * dashboard reports a smaller number than the sweeper deletes: an entry someone
 * is still reading is in use, whatever its age.
 *
 * The other three surfaces never got this. Do not delete this test to make them
 * agree -- it is the behaviour operators asked for, and the disagreement is the
 * defect.
 */
export function readDefersExpiry(): void {
  const entries: Entry[] = [
    { id: "read-recently", writtenAt: NOW - 40 * DAY, lastReadAt: NOW - 2 * DAY },
  ];
  if (countExpired(entries, NOW, 30) !== 0) throw new Error("a recent read must defer expiry");
}

export function pinnedIsKept(): void {
  const entries: Entry[] = [{ id: "pinned", writtenAt: NOW - 40 * DAY, pinned: true }];
  if (countExpired(entries, NOW, 30) !== 0) throw new Error("a pinned entry is never swept");
}

readDefersExpiry();
pinnedIsKept();
