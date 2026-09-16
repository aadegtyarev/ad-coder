# Retry contract

- A queue worker retries a failed job at most 3 times before moving it to the
  dead-letter queue.
- The delay before an attempt is nonzero; a zero backoff is a violation
  regardless of how the ceiling is counted.
- A structured log line for every attempt includes the job id and the attempt
  number.
