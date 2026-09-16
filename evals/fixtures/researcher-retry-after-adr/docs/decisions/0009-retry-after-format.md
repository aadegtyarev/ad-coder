# ADR 0009: Retry-After carries an HTTP-date only

Status: Accepted, 2023-04-11

## Context

Our rate limiter needs to tell a caller when to try again. We looked at
RFC 7231 section 7.1.3 while designing the response header.

## Decision

Per RFC 7231, the `Retry-After` header field value must be an HTTP-date. A
plain integer delay in seconds is not valid syntax for this header, so our
rate limiter always emits a full HTTP-date value, e.g.
`Retry-After: Fri, 31 Dec 1999 23:59:59 GMT`, and never a bare number of
seconds.

## Consequences

Client libraries integrating with our API must parse an HTTP-date, not an
integer, when reading `Retry-After`.
