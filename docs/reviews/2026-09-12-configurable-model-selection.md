# Prepare ad-coder for self-hosted development

**Date:** 2026-09-12
**Verdict:** APPROVED after local closeout
**Complexity:** complex
**Security surface:** elevated
**Coder passes:** 1

## Verification

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Independent configurable model selection and role-specific budgets | passed | Focused mixed-window and all-route coverage passed. |
| Reject undersized summarizer before provider dispatch | passed | Dispatch-counting regression observes zero provider calls. |
| 32000/200000/mixed-window/routing/override coverage | passed | Every complexity route and override is checked against its selected model window and derived budget. |
| Static typecheck | passed | `node node_modules/typescript/bin/tsc --noEmit` |
| Biome checks | passed | `node_modules/.bin/biome check src test --diagnostic-level=error` (77 files) |
| Diff whitespace check | passed | `git diff --check` |
| Full local gate | passed | 287 tests, 1,467 assertions; focused suite 99 tests, 675 assertions. |
| Real self-hosting dogfood | deferred | Runs after the separate persistent Codex OAuth adapter increment. |

## Attacks

| Vector | Outcome | Evidence |
|--------|---------|----------|
| Undersized summarizer dispatches before rejection | not proven | Security/planning expectation is fail-before-dispatch, but the test does not record provider calls. |
| Registry redirects ambient credentials to an attacker endpoint | mitigation required | Security finding: arbitrary env-var/HTTPS pairing can exfiltrate ambient credentials if repository-controlled configuration is loaded. |
| Configuration executes repository-controlled code | mitigation required | Security finding: dynamic module loading could execute configuration before validation; use bounded JSON data loading. |

## Issues still open

None for this increment. OAuth persistence and live dogfood are the next increment.

## Issues closed along the way

- README documentation correction was completed and static checks passed.

## Cost

6,976,190 total tokens: Planner 613,008; Security 115,036; Coder 4,951,002; Reviewer 1 628,579; Coder fix 161,964; Reviewer 2 352,397; Recorder 154,204.
