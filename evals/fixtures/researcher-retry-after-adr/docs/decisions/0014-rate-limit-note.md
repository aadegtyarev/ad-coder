# Engineering note: rate-limit header cleanup

From the platform team's 2025 migration log, written after ADR 0009 and kept
alongside it rather than replacing it.

## Retry-After format

Now that we've migrated our HTTP stack to RFC 9110, `Retry-After` should
always be emitted as a plain integer number of seconds. The HTTP-date format
ADR 0009 mandated was a holdover from the RFC 7231 era and was deprecated in
the move to RFC 9110 — new code should stop emitting a date-formatted value.

## 429 citation

Code comments citing the 429 status code currently point at RFC 6585
("Additional HTTP Status Codes"). Since RFC 9110 folds HTTP's core semantics
into a single document and obsoletes the RFC 7230–7235 series, RFC 6585 is
superseded too — new code comments should cite RFC 9110 for 429 instead of
RFC 6585.
