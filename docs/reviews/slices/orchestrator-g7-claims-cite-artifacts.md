# Slice audit: orchestrator guarantee `orchestrator.md:44` (g7-claims-cite-artifacts)
Audit base: ff07c9988923aeb4fa0b66106f3574103eb4b4cd, date 2026-09-24.
Rule text: "- Claims about a run cite an artefact; otherwise they are hypotheses. Reports do
  not prestate verdicts, paraphrase a refusal or abort as success, or call an
  unchecked check green. Green CI comes from its step list, not a badge."

## Verdict
conforming, scoped to the surfaces this slice examined (trivial-edit coverage guard,
gate/verdict prompt and report surfaces, control-plane decision records): the
refusal-as-success clause has direct code plus a passing targeted behaviour test, gate
"green" is derived from named per-step PASS/FAIL results rather than a badge, and verdict
schema + control-plane decision records require bounded, addressable evidence. The
hypothesis clause and CI-badge clause see partially unverified paths listed below.

## Checks executed
| Command | Result |
| --- | --- |
| `git rev-parse HEAD` | `ff07c9988923aeb4fa0b66106f3574103eb4b4cd` |
| `bun test test/orchestrator.test.ts -t "a failing reviewer cover"` | 1 pass, 75 filtered out, 0 fail, 7 expect() calls, exit 0 (633ms) |
| `bun test test/pipeline-gates.test.ts` | 14 pass, 0 fail, 71 expect() calls, exit 0 (995ms) |
| ~10 supporting greps/seds locating the implementations cited below | found all cited lines |

Behaviour actually exercised (test asserted, set by reading it first):
- `a failing reviewer cover records reviewer_failed and refuses to claim closure
  (issue #388)` (test/orchestrator.test.ts:3421): the edit applied but the reviewer step
  threw mid-flight; the run asserts the tool result plainly contains "could NOT settle"
  and "may not be considered closed" (lines 3444-3445) and that the durable record keeps
  `{ cover: { status: "reviewer_failed" } }` (3446) -- the refusal is never reported as a
  settled success. This is the exact "paraphrase a refusal as success" clause.
- test/pipeline-gates.test.ts (14 tests) exercises the gate/review pipeline whose
  reviewer prompt embeds the real gate report ("Declared project gates", test line 183)
  rather than a summary claim.

## Evidence read
- `src/orchestration/orchestrator.ts:1996-2001` — when every review attempt throws, the
  wiring throws a named error; the comment rules out an undefined return "that could read
  as 'no reviewer stage'". The guard then records `reviewer_failed`
  (`src/orchestration/trivial-edit.ts:581`) and the result text "states plainly the cover
  could not settle -- the work is not closed without one (never fake success"
  (trivial-edit.ts:441-442); `TrivialEditCover.status` union at trivial-edit.ts:143 has
  `reviewed | reviewer_unavailable | reviewer_failed`, so no silent-success state exists
  in the type.
- `src/orchestration/session.ts:2140-2146` — `formatGateReport` prints PASS/FAIL once per
  gate result and sets the headline PASS *from* `report.results`; green is the step list,
  not a badge. `session.ts:1572-1574` also keeps a red gate report as the blocking
  evidence ("the evidence is the captured gate output"), so a red gate can never be
  blessed by review.
- `src/orchestration/session.ts:1985-2019` — `formatVerificationEvidence` preserves
  bounded read/changed-path evidence and, per issue #449, renders a *failed* git
  measurement as an explicit failure line instead of a zero-count line that would read
  as "no changes" (an unchecked check silently called green).
- `src/orchestration/verdict.ts:525-548` — every verdict issue carries `location`
  ("required for blocker/major: relative file:line ..."), `closureCriterion`
  (objective observation proving closure), and `evidence` ("bounded evidence required for
  closed findings"); `verdict.ts:665-670` states every blocker/major must be reproducible
  with a bounded location. This is the "cite an artefact" clause for review-stage claims.
- `src/orchestration/control-plane.ts:44-57` — durable `DecisionRecord` requires
  `evidence: string[]`; `control-plane.ts:419-425` (`evidenceReferences`) validates each
  reference as a bounded path-like token, i.e. a claim's evidence has to be an artefact
  address, not prose.
- `src/orchestration/session.ts:2116,2130` — the review prompt embeds the actual gate
  report; a run with no gates is reported as "Declared project gates: none configured"
  rather than as a pass.

## Gaps and unverified
- The literal "otherwise they are hypotheses" wording appears nowhere in src/; no code
  path explicitly marks an uncited, non-verdict claim as a hypothesis. What this slice
  verified is that the structured claim surfaces (verdicts, control-plane decisions,
  gate/verification prompts) carry bounded evidence fields. An unstructured operator
  message written outside those surfaces may still make uncited claims — part `unverified`.
- "Reports do not prestate verdicts": the schema description says `"approved" is exactly
  the verdict whose issues list is empty` (verdict.ts:548 comment), but I did not read
  `parseVerdict` to prove approval with a non-empty issues list is refused at parse
  time. Unverified end-to-end.
- "abort" clause: I traced the refusal path (reviewer throw) but deliberately did not
  widen to abort/cancel reporting surfaces (`stop-run.ts`, `run-stop.ts` were only
  grepped, not read). Partially unverified.
- "Green CI comes from its step list, not a badge": this repository contains no CI badge
  or CI-reporting surface that I found (grep for "badge"/"green" found only gate logic
  and comments). The clause is satisfied on the gate surface by construction of
  `formatGateReport`; whether any external-facing report could still assert a CI badge
  I did not establish — `contract_missing_test` for that wording specifically.
- Wake-summary claims (the line-28 guarantee's surface) were not examined against this
  rule; that is adjacent to slice g5, not this one.

One command-count: 2 behaviour commands (the two `bun test` runs); ~10 supporting
greps/seds; plus `git` state inspection and the file writes this document.
