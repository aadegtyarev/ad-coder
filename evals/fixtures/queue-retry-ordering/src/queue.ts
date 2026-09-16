export interface Job {
  id: string;
  attempts: number;
}

const MAX_ATTEMPTS = 3;

/** Up to this many workers claim jobs concurrently. See docs/contracts/retry.md. */
export const CONCURRENCY = 4;

const pending: Job[] = [];
const deadLetter: Job[] = [];
const inFlight = new Map<string, Job>();

export function enqueue(id: string): void {
  pending.push({ id, attempts: 0 });
}

/**
 * Claimed by any of up to `CONCURRENCY` workers running at once. Nothing here
 * orders a claim relative to any other job's claim, completion, or retry.
 */
export function claim(): Job | undefined {
  const job = pending.shift();
  if (!job) return undefined;
  inFlight.set(job.id, job);
  return job;
}

export function complete(id: string): void {
  inFlight.delete(id);
}

/**
 * A failed job returns to the TAIL of the pending queue with `attempts`
 * incremented. Past `MAX_ATTEMPTS` it moves to the dead-letter list instead
 * and is never requeued.
 */
export function fail(id: string): void {
  const job = inFlight.get(id);
  if (!job) throw new Error("not in flight");
  inFlight.delete(id);
  job.attempts += 1;
  if (job.attempts >= MAX_ATTEMPTS) deadLetter.push(job);
  else pending.push(job);
}

export function isDeadLettered(id: string): boolean {
  return deadLetter.some((job) => job.id === id);
}

export function isInFlight(id: string): boolean {
  return inFlight.has(id);
}
