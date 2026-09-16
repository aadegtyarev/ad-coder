# ADR 0021: Raise the retry cap to 5

Status: Accepted, 2026-06-02

## Context

`docs/contracts/retry.md` currently states a cap of 3 attempts before a job
moves to the dead-letter queue. Incident review of the March outage found
jobs dead-lettering on transient errors that a fourth or fifth attempt would
have cleared.

## Decision

The retry cap is raised from 3 to 5 attempts. This supersedes the cap stated
in `docs/contracts/retry.md`; that document's text has not yet been edited to
match and still reads 3 pending a documentation pass, but this ADR is the
enforceable value in the meantime.

The contract's other clauses -- nonzero backoff before every attempt, and a
structured log line per attempt carrying the job id and attempt number -- are
unaffected by this decision and remain governed by `docs/contracts/retry.md`
as written.

## Consequences

New and existing retry call sites must enforce a cap of 5, not 3. A reviewer
or auditor checking the cap against `docs/contracts/retry.md` alone will read
a stale number; this ADR is the source of truth for the cap until the
contract is edited.
