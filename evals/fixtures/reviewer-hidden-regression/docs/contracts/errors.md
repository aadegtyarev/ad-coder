# Error and persistence contract

- Every invalid result identifier fails with `Error("invalid result id")` and
  never produces a path outside the configured base directory.
- Metadata must be committed before the primary result. If metadata persistence
  fails, its error remains observable and the primary write is not attempted.
- Behavioral fixes require regression tests that fail against the defective
  implementation and pass against the repaired implementation.
