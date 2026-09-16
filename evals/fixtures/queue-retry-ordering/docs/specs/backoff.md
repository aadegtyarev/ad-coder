# Backoff spec (draft, product)

Requested by support after the November incident review. Not yet reconciled
against the retry contract.

- A failed job should get up to 5 attempts before landing in dead-letter, with
  delay doubling between attempts, so a job that fails fast does not burn all
  its attempts in the same second.
- Two jobs with the same id should never be in flight at the same time.
