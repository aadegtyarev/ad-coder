Find the threats before the code exists, and name the mitigation that closes each one.

Threat modelling reads a plan, not a diff. It is cheapest exactly there: a
mitigation written into a plan costs a paragraph, and the same mitigation
retrofitted after review costs a round. A dedicated security role usually does
this; whoever holds a plan that touches an elevated surface does it with the
same technique.

## Where to look

Read each step of the plan and ask what could go wrong. These are the dimensions
worth checking against a planned change:

- **Injection** — SQL, command, template: where does untrusted input reach an
  interpreter?
- **Auth and session** — broken access control, missing checks, token leaks,
  privilege escalation.
- **Data exposure** — secrets in code, personal data in logs, unencrypted
  sensitive data, errors verbose enough to leak state.
- **Input validation** — missing validation on user-controlled data, XSS,
  prototype pollution, path traversal.
- **SSRF and URLs** — user-controlled URLs, redirect chains, exposure of an
  internal network.
- **Supply chain** — new dependencies, suspicious imports, eval and dynamic
  loading, deserialization.
- **Crypto** — hardcoded keys, weak algorithms, comparison that is not
  constant-time, a broken source of randomness.
- **Race conditions** — time-of-check to time-of-use, concurrent access to
  shared state without synchronisation.
- **Resource exhaustion** — unbounded allocation, missing limits, catastrophic
  regex backtracking.
- **Configuration** — default credentials, debug mode in production, missing
  security headers.

## A pattern match is a lead, not a finding

Follow the path production actually takes, not the first site that matched your
search. A query that looks unguarded where you found it is not a finding until
you have traced the call path to the door that authorizes it — and the finding
must then name that door, or say plainly that nothing authorizes the path.

This is the discipline that separates a threat model from a linter. The linter
reports the shape; the model reports whether an attacker can reach it.

## What a finding must carry

For each real threat: a concrete exploit scenario describing how an attacker
abuses it, a specific mitigation whoever implements the change must apply, and a
CWE identifier when one applies.

Rate severity honestly — critical for remote code execution, authentication
bypass, data breach or a leaked secret; high for injection, privilege
escalation, or SSRF reaching internal services; medium for XSS, CSRF and
information disclosure; low for weak configuration and a missing rate limit;
informational for hardening. Inflated severity is not caution: it trains the
next reader to discount the list.

Only flag real threats. Do not speculate about hypotheticals, and do not repeat
code-quality concerns — those belong to verification, and mixing them dilutes
the security findings that matter. If the plan has no meaningful attack surface,
say so quickly and stop; a threat model padded to look thorough wastes the
attention it was supposed to direct.

## Scope

This stage specifies adversarial tests for whoever implements the change; it
does not run the project's suite itself. Mitigations you name become blocking
requirements downstream — so name the ones you would actually block on, and no
others.

## When credentials are in scope

Names and paths, never values. A finding that quotes a secret to prove the
secret leaks has leaked it again, into a place with a longer memory: an issue
tracker, a ledger, a run log. Name the file, the variable and the path the value
travels; that is enough for anyone to verify and fix it.
