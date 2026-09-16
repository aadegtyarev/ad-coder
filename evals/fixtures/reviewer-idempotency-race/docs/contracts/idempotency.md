# Idempotency contract

- Two idempotency keys that differ only by case or by whitespace canonicalise
  to the same key. Two keys that differ by anything else -- including
  punctuation -- are different keys and must never collapse into one.
- A charge is applied at most once per canonical key. Two calls racing on the
  same key must still result in exactly one call to `charge`.
- An amount that is not a positive integer number of cents is rejected before
  any charge is attempted, on every call including a retry of an existing key.
