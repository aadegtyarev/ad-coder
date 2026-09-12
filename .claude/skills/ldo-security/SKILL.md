---
name: ldo-security
description: Threat-model an implementation plan before code is written — OWASP top 10, injection, auth, data exposure, supply chain
---

Invoke the security agent to threat-model an implementation plan. This is shift-left: it reads the plan, not a diff — no code exists yet, so a finding here becomes a requirement the Coder implements against, not a bug the Coder has to go back and fix.

## Usage

```
/ldo-security
```

Run this after `/ldo-planner` produces a plan, before `/ldo-coder` implements it — or let `/ldo` run it automatically, which it does whenever the Planner rates the change's `security_surface` as `elevated` (or `security: true` forces it on for any rating).

The security agent will:
1. Read `docs/contracts/security.md` first, if the project has one — a "Required" section is a floor checked regardless of what the plan looks like; an "Accepted" section names risks already decided not to mitigate, so they aren't re-raised
2. Read each plan step and ask what could go wrong security-wise
3. Check 10 threat categories against the planned changes: injection, auth/session, data exposure, input validation, SSRF, supply chain, crypto, race conditions, resource exhaustion, configuration
4. For each real threat: a concrete exploit scenario, a specific mitigation the Coder must implement, and a CWE code where applicable
5. Return `clean` quickly if the plan has no meaningful attack surface — no manufactured findings to look thorough

The Reviewer later attacks every finding this agent produced — running the exploit scenario for real against the finished code, not just checking the mitigation reads plausibly. A mitigation only counts as proven when that attack fails and the attempt is captured as evidence.
