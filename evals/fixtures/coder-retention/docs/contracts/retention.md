# Retention contract

- A pinned entry is never swept, at any age.
- Every surface that reports on retention answers from the same rule, so an
  operator is never shown one set of entries and given another. Where the
  surfaces disagree today, the behaviour operators have already agreed to --
  recorded in the tests -- is the one that is right.
- A retention decision is taken against a caller-supplied clock, never against
  the wall clock, so a sweep is reproducible and testable.
