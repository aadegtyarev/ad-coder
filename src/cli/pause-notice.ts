/**
 * A pause is announced ONCE per occurrence (issue #501).
 *
 * The same pause can reach the terminal through two paths: the pushed notice
 * (a background run's event, re-delivered on gap recovery) and the result
 * path (the front that drove the run, plus the generic CLI error renderer the
 * thrown `PipelinePauseError` falls through to). Printing it twice reads as a
 * new decision where the operator already made one, so every renderer asks
 * this keyed memo before it writes: the first renderer of an occurrence wins,
 * later ones stay silent. Keys are composed from the pause's own identifiers
 * -- never from its action text, so a re-render never rekeys.
 *
 * The memo is process-level and content-accumulating, like the startup
 * banner's: a process renders each pause occurrence at most once, and a NEW
 * occurrence (different run, stage, or code -- a new event sequence) prints.
 */

const announced = new Set<string>();

/** The occurrence key shared by every renderer of one pause record. */
export function pauseAnnouncementKey(runId: string, phase: string, code: string): string {
  return `${runId}|${phase}|${code}`;
}

/** True the first time this exact pause occurrence is announced in this process. */
export function announcePauseOnce(key: string): boolean {
  if (announced.has(key)) return false;
  announced.add(key);
  return true;
}

/** Test seam: forget what this process has already announced. */
export function resetPauseAnnouncements(): void {
  announced.clear();
}
