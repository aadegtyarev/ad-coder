const DEFAULT_RETRIES = 3;

/**
 * How many times an operation should be retried.
 *
 * `maxRetries` is optional by design: callers that do not care omit it and get
 * the default.
 */
export function retryCount(maxRetries?: number): number {
  return maxRetries ?? DEFAULT_RETRIES;
}
