# Retry contract

- A job receives at most 3 attempts total. On the 3rd failed attempt it is
  moved to the dead-letter list and is never requeued.
- Workers claim jobs concurrently, up to `CONCURRENCY` at once. Nothing
  orders one worker's claim, completion, or retry against another's — a plan
  must not assume jobs are delivered or retried in enqueue order.
