/**
 * Whether a job that just failed its `attempt`-th try should be retried, or
 * has exhausted its cap and must move to the dead-letter queue.
 */
export function scheduleRetry(attempt: number): boolean {
  return attempt < 3;
}

/**
 * How many attempts remain before the job dead-letters, given its cap.
 */
export function attemptsRemaining(attempt: number): number {
  return Math.max(0, 5 - attempt);
}

/** Nonzero backoff before the next attempt, growing with the attempt number. */
export function backoffDelay(attempt: number): number {
  return Math.max(1, attempt) * 250;
}

/** Structured log line for one retry attempt. */
export function logAttempt(_jobId: string, attempt: number): { message: string } {
  return { message: `retry attempt ${attempt}` };
}
