# Persistence contract

- A queue write is durable before the call returns: the record is written and
  flushed, and a failed flush fails the call.
